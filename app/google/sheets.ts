// The Google Sheets mirror: STEWARD writes a spreadsheet, and never reads it back.
//
// Same Cloud project, same OAuth client and the SAME `drive.file` scope the document
// store already holds — `spreadsheets.create` and every `values.*` call accept it for
// a file this app created. So nothing here widens consent, and nothing here drags the
// OAuth app into a verification review. The one thing it needs that Drive did not is
// the Sheets API switched on in the Cloud project, which is a toggle, not a review —
// and when it is off Google says so precisely, so we pass that through rather than
// inventing a vaguer message of our own.
//
// One way, by design. SQLite is the source of truth and every mutation appends an
// audit row; a spreadsheet that wrote back would change records with no actor, no
// timestamp and no diff. See plans/0010-sheets-sync.md.

import type { SettingsRepository } from '../repo/ports.ts';
import type { GoogleAuth } from './oauth.ts';
import { DRIVE_FILES_API, ensureFolder, type Fetcher } from './folder.ts';
import {
  SPREADSHEET_TITLE, TAB_TITLES, mirrorCounts, mirrorTabs,
  type MirrorData, type MirrorTab,
} from './mirror.ts';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const KEY = {
  id: 'sheets.spreadsheet_id',
  url: 'sheets.spreadsheet_url',
  pushedAt: 'sheets.pushed_at',
} as const;

/** Spare rows so the next push usually needs no grid resize at all. */
const ROW_SLACK = 50;

export interface MirrorState {
  /** A client id exists — same prerequisite Drive has. */
  configured: boolean;
  connected: boolean;
  url: string | null;
  pushedAt: string | null;
}

export type PushOutcome =
  | {
      ok: true;
      url: string;
      counts: Record<string, number>;
      pushedAt: string;
      /** The previous mirror was gone (trashed), so a new one was made. */
      recreated: boolean;
      /** Something non-fatal worth saying — e.g. the file could not be filed. */
      note?: string;
    }
  | { ok: false; reason: string; enableUrl?: string };

/** A Google error, carried with the status so callers can branch on it. */
class SheetsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface SheetProps { sheetId: number; title: string }
interface SpreadsheetMeta {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  sheets?: { properties: SheetProps }[];
}

/** Google's "enable this API" message carries the console link; keep the real one. */
const enableUrlIn = (message: string): string | undefined =>
  message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+?(?=[\s,]|$)/)?.[0];

const isApiDisabled = (e: SheetsError): boolean =>
  e.status === 403 && /has not been used in project|is disabled|accessNotConfigured/i.test(e.message);

export function makeSheetsMirror(
  settings: SettingsRepository,
  auth: GoogleAuth,
  folderName = 'STEWARD',
  fetchImpl: Fetcher = fetch,
  clientId = '',
) {
  const call = async <T>(url: string, init: RequestInit = {}, token?: string): Promise<T> => {
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { error?: { message?: string } };
    if (!res.ok) {
      throw new SheetsError(res.status, json.error?.message ?? `sheets request failed: ${res.status}`);
    }
    return json;
  };

  /** Bold the header, protect the tab, size the columns. Once per tab, at birth. */
  const dressRequests = (sheetId: number, columns: number): unknown[] => [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    {
      // warningOnly, not a real permission: the operator owns this file and shares
      // it themselves, so a hard protection would be a permissions fight. A warning
      // is what actually reaches the person about to lose their typing.
      addProtectedRange: {
        protectedRange: {
          range: { sheetId },
          warningOnly: true,
          description: 'Rewritten by STEWARD on every push.',
        },
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columns },
      },
    },
  ];

  /** A brand-new spreadsheet, dressed, and filed into the STEWARD folder. */
  const create = async (token: string, tabs: MirrorTab[]): Promise<{ meta: SpreadsheetMeta; note?: string }> => {
    const meta = await call<SpreadsheetMeta>(SHEETS_API, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: SPREADSHEET_TITLE },
        sheets: tabs.map((t) => ({
          properties: {
            title: t.title,
            gridProperties: {
              // Row 1 is the banner, row 2 the header: both stay in view.
              frozenRowCount: 2,
              rowCount: t.rows.length + ROW_SLACK,
              columnCount: Math.max(1, t.rows[1]?.length ?? 1),
            },
          },
        })),
      }),
    }, token);
    if (!meta.spreadsheetId) throw new SheetsError(500, 'Google returned no spreadsheet id.');

    const byTitle = new Map((meta.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));
    await call(`${SHEETS_API}/${meta.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: tabs.flatMap((t) => {
          const id = byTitle.get(t.title);
          return id === undefined ? [] : dressRequests(id, t.rows[1]?.length ?? 1);
        }),
      }),
    }, token);

    // spreadsheets.create takes no parent and drops the file in My Drive root, so
    // filing it is a separate Drive call. If it fails the mirror still exists and
    // still works — say so rather than failing a push over tidiness.
    let note: string | undefined;
    try {
      const folder = await ensureFolder(token, folderName, fetchImpl);
      await call(
        `${DRIVE_FILES_API}/${meta.spreadsheetId}?addParents=${folder}&removeParents=root&fields=id`,
        { method: 'PATCH', body: '{}' },
        token,
      );
    } catch {
      note = `The mirror was created but could not be moved into the ${folderName} folder; it is in My Drive.`;
    }
    return { meta, note };
  };

  /** Write every tab: size the grid, clear what was there, then put the rows in. */
  const write = async (token: string, spreadsheetId: string, tabs: MirrorTab[]): Promise<void> => {
    // Reading the metadata first is what tells us the tab ids, whether the operator
    // deleted a tab, and — by 404 — whether the file still exists at all.
    const meta = await call<SpreadsheetMeta>(
      `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`, {}, token,
    );
    const byTitle = new Map((meta.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));

    const missing = tabs.filter((t) => !byTitle.has(t.title));
    const requests = [
      ...missing.map((t) => ({ addSheet: { properties: { title: t.title } } })),
      ...tabs.flatMap((t) => {
        const id = byTitle.get(t.title);
        if (id === undefined) return []; // just added; sized below
        return [{
          updateSheetProperties: {
            properties: {
              sheetId: id,
              gridProperties: {
                frozenRowCount: 2,
                // values.update REFUSES a range past the grid, so the grid grows first.
                rowCount: t.rows.length + ROW_SLACK,
                columnCount: Math.max(1, t.rows[1]?.length ?? 1),
              },
            },
            fields: 'gridProperties(frozenRowCount,rowCount,columnCount)',
          },
        }];
      }),
    ];
    if (requests.length) {
      const reply = await call<{ replies?: { addSheet?: { properties: SheetProps } }[] }>(
        `${SHEETS_API}/${spreadsheetId}:batchUpdate`,
        { method: 'POST', body: JSON.stringify({ requests }) }, token,
      );
      // A tab the operator deleted comes back dressed like the original.
      const added = (reply.replies ?? []).flatMap((r) => (r.addSheet ? [r.addSheet.properties] : []));
      const dress = added.flatMap((p) => {
        const tab = tabs.find((t) => t.title === p.title);
        return tab ? dressRequests(p.sheetId, tab.rows[1]?.length ?? 1) : [];
      });
      if (dress.length) {
        await call(`${SHEETS_API}/${spreadsheetId}:batchUpdate`,
          { method: 'POST', body: JSON.stringify({ requests: dress }) }, token);
      }
    }

    // Clear BEFORE writing, and pessimistically: a failure between the two leaves
    // tabs that are visibly empty, which someone notices — rather than a mix of old
    // and new rows, which nobody does. Writing without clearing is the actual bug
    // this avoids: delete three tickets and their rows sit at the bottom forever.
    await call(`${SHEETS_API}/${spreadsheetId}/values:batchClear`, {
      method: 'POST',
      body: JSON.stringify({ ranges: tabs.map((t) => `'${t.title}'!A1:ZZ`) }),
    }, token);

    await call(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        // RAW: values are stored exactly as given. A cell beginning with "=" stays
        // text instead of becoming a formula, which is both what a mirror means and
        // the answer to spreadsheet-formula injection through a customer's notes.
        valueInputOption: 'RAW',
        data: tabs.map((t) => ({ range: `'${t.title}'!A1`, values: t.rows })),
      }),
    }, token);
  };

  return {
    state(): MirrorState {
      return {
        configured: Boolean(clientId),
        connected: Boolean(auth.status().connected),
        url: settings.get(KEY.url),
        pushedAt: settings.get(KEY.pushedAt),
      };
    },

    /**
     * Rewrite the mirror. Never automatic: this copies names, emails and phone
     * numbers into a file that is one button away from being shared with anyone,
     * so the consent belongs at the moment it happens.
     */
    async push(data: MirrorData): Promise<PushOutcome> {
      const token = await auth.accessToken().catch(() => null);
      if (!token) {
        return { ok: false, reason: 'Google is not connected. Connect an account in Settings first.' };
      }

      const pushedAt = new Date().toISOString();
      const tabs = mirrorTabs(data, pushedAt);
      let id = settings.get(KEY.id);
      let recreated = false;
      let note: string | undefined;

      try {
        if (!id) {
          const made = await create(token, tabs);
          id = made.meta.spreadsheetId!;
          note = made.note;
          settings.set(KEY.id, id);
          settings.set(KEY.url, made.meta.spreadsheetUrl ?? `${SHEETS_API.replace('/v4/spreadsheets', '')}/d/${id}`);
        }
        try {
          await write(token, id, tabs);
        } catch (e) {
          // The operator can trash the file. Recreating silently is how someone ends
          // up with three mirrors and a share link pointing at a dead one, so this
          // recreates AND says so.
          if (!(e instanceof SheetsError) || e.status !== 404) throw e;
          settings.remove(KEY.id);
          const made = await create(token, tabs);
          id = made.meta.spreadsheetId!;
          recreated = true;
          note = made.note;
          settings.set(KEY.id, id);
          settings.set(KEY.url, made.meta.spreadsheetUrl ?? '');
          await write(token, id, tabs);
        }
      } catch (e) {
        if (e instanceof SheetsError && isApiDisabled(e)) {
          return { ok: false, reason: e.message, enableUrl: enableUrlIn(e.message) };
        }
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }

      settings.set(KEY.pushedAt, pushedAt);
      return {
        ok: true,
        url: settings.get(KEY.url) ?? '',
        counts: mirrorCounts(tabs),
        pushedAt,
        recreated,
        note,
      };
    },

    /** Forget the mirror locally. The spreadsheet itself stays in the operator's Drive. */
    forget(): void {
      for (const k of Object.values(KEY)) settings.remove(k);
    },
  };
}

export type SheetsMirror = ReturnType<typeof makeSheetsMirror>;
export { TAB_TITLES };
