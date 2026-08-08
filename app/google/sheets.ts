// The Google Sheets mirror: STEWARD writes a spreadsheet, and since 0011 reads it back.
//
// Same Cloud project, same OAuth client and the SAME `drive.file` scope the document
// store already holds — `spreadsheets.create` and every `values.*` call accept it for
// a file this app created. So nothing here widens consent, and nothing here drags the
// OAuth app into a verification review. The one thing it needs that Drive did not is
// the Sheets API switched on in the Cloud project, which is a toggle, not a review —
// and when it is off Google says so precisely, so we pass that through rather than
// inventing a vaguer message of our own.
//
// 0010 refused a write-back with an argument, not for want of time: a spreadsheet that
// wrote back would change records with no actor, no timestamp and no diff. 0011 answers
// two of those three outright — a pull writes through the services, so the timestamp and
// a diff of ONLY the changed fields land in the same call — and answers the third
// honestly rather than fully. The Sheets API does not report who typed a cell, so the
// actor is `sheet:<connected account>`: a PROVENANCE, meaning *this arrived through the
// spreadsheet on the account connected to this STEWARD*. It does not claim that person
// typed it, and nothing here pretends otherwise.
//
// A pull creates nothing, deletes nothing, archives nothing, and never runs on a timer.
// See plans/0011-sheet-driven-writes.md.

import type { SettingsRepository } from '../repo/ports.ts';
import { GOOGLE_ACCOUNT_KEY, type GoogleAuth } from './oauth.ts';
import { DRIVE_FILES_API, ensureFolder, type Fetcher } from './folder.ts';
import {
  PULL_COLUMNS, PULL_TABS, SPREADSHEET_TITLE, TAB_TITLES,
  derivedHeaders, headersFor, mirrorCounts, mirrorTabs,
  type MirrorData, type MirrorTab, type PullTab, type TabTitle,
} from './mirror.ts';
import { planFingerprint, planPull, type PullPlan, type SheetValues, type TabValues } from './pull.ts';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const KEY = {
  id: 'sheets.spreadsheet_id',
  url: 'sheets.spreadsheet_url',
  pushedAt: 'sheets.pushed_at',
  pulledAt: 'sheets.pulled_at',
  /** The title we last set, so the 0011 rename happens once rather than on every push. */
  title: 'sheets.title',
} as const;

/** Spare rows so the next push usually needs no grid resize at all. */
const ROW_SLACK = 50;

export interface MirrorState {
  /** A client id exists — same prerequisite Drive has. */
  configured: boolean;
  connected: boolean;
  url: string | null;
  pushedAt: string | null;
  pulledAt: string | null;
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
  | {
      ok: false;
      reason: string;
      enableUrl?: string;
      /** The mirror moved on since the last push; `force` is the deliberate discard. */
      stale?: boolean;
    };

export type PullOutcome =
  | { ok: true; plan: PullPlan; revision: string; url: string; actor: string }
  | { ok: false; reason: string; enableUrl?: string };

export type ApplyOutcome =
  | { ok: true; applied: number; actor: string; pulledAt: string }
  | { ok: false; reason: string; needsAck?: boolean; plan?: PullPlan };

/** A Google error, carried with the status so callers can branch on it. */
class SheetsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface SheetProps { sheetId: number; title: string }
interface SpreadsheetMeta {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  sheets?: { properties: SheetProps; protectedRanges?: { protectedRangeId: number }[] }[];
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
  // Read on demand, not captured. Since 0017 the client id is operator-held and can be
  // pasted into Settings while this mirror already exists; a captured empty string would
  // leave the surface saying "not configured" until the next restart. Tests pass a plain
  // string, which is the whole reason the union is here rather than a bare thunk.
  clientId: string | (() => string) = '',
) {
  const readClientId = (): string => (typeof clientId === 'function' ? clientId() : clientId);
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

  /** Grey means "STEWARD computes this and never reads it back". White means it does. */
  const GREY = { red: 0.93, green: 0.93, blue: 0.93 };
  const WHITE = { red: 1, green: 1, blue: 1 };

  /** Contiguous runs of column indices, so adjacent grey columns share one warning. */
  const runsOf = (indices: number[]): [number, number][] => {
    const runs: [number, number][] = [];
    for (const i of [...indices].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && last[1] === i) last[1] = i + 1; else runs.push([i, i + 1]);
    }
    return runs;
  };

  const shade = (sheetId: number, from: number, to: number, colour: typeof GREY) => ({
    repeatCell: {
      // From the HEADER row down, unbounded: the banner keeps its own look, and a row
      // added below the last record is shaded like every other.
      range: { sheetId, startRowIndex: 1, startColumnIndex: from, endColumnIndex: to },
      cell: { userEnteredFormat: { backgroundColor: colour } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  });

  const protect = (sheetId: number, description: string, from?: number, to?: number) => ({
    // warningOnly, not a real permission: the operator owns this file and shares it
    // themselves, so a hard protection would be a permissions fight. A warning is what
    // actually reaches the person about to lose their typing — and Sheets shows this
    // DESCRIPTION in its own dialog, which is why each range gets its own sentence.
    addProtectedRange: {
      protectedRange: {
        range: { sheetId, ...(from === undefined ? {} : { startColumnIndex: from, endColumnIndex: to }) },
        warningOnly: true,
        description,
      },
    },
  });

  /**
   * Bold the header, colour the two kinds of column, and warn on the ones a pull ignores.
   *
   * Re-applied on EVERY push rather than at birth, because 0011 changed all three guards
   * and a mirror already sitting in the operator's Drive would otherwise keep 0010's
   * "rewritten on every push" warning over columns that are now read back. The pullable
   * columns get NO protected range at all: warning someone away from the cells the whole
   * feature exists to let them edit is the opposite of a guard.
   */
  const dressRequests = (sheetId: number, tab: TabTitle): unknown[] => {
    const headers = headersFor(tab);
    const bold = {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    };
    if (!(PULL_TABS as readonly string[]).includes(tab)) {
      return [bold, shade(sheetId, 0, headers.length, GREY),
        protect(sheetId, 'This tab is never read back — log progress in STEWARD. Rewritten on every push.')];
    }
    const grey = derivedHeaders(tab).map((h) => headers.indexOf(h));
    const white = PULL_COLUMNS[tab as PullTab].map((c) => headers.indexOf(c.header));
    return [
      bold,
      shade(sheetId, 0, 1, GREY),
      ...runsOf(grey).map(([a, b]) => shade(sheetId, a, b, GREY)),
      ...runsOf(white).map(([a, b]) => shade(sheetId, a, b, WHITE)),
      protect(sheetId, 'Column A is the record id. Changing it re-points this row at a different record.', 0, 1),
      ...runsOf(grey).map(([a, b]) =>
        protect(sheetId, 'Computed by STEWARD and not read back. A push overwrites it.', a, b)),
    ];
  };

  /** Column widths, once — at birth. Re-running it would undo the operator's own sizing. */
  const sizeRequests = (sheetId: number, columns: number): unknown[] => [
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
          return id === undefined
            ? []
            : [...dressRequests(id, t.title as TabTitle), ...sizeRequests(id, t.rows[1]?.length ?? 1)];
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

  /** Write every tab: size the grid, re-dress it, clear what was there, then put the rows in. */
  const write = async (token: string, spreadsheetId: string, tabs: MirrorTab[]): Promise<void> => {
    // Reading the metadata first is what tells us the tab ids, whether the operator
    // deleted a tab, and — by 404 — whether the file still exists at all.
    const meta = await call<SpreadsheetMeta>(
      `${SHEETS_API}/${spreadsheetId}?fields=sheets(properties(sheetId,title),protectedRanges(protectedRangeId))`,
      {}, token,
    );
    const byTitle = new Map((meta.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));
    const oldRanges = (meta.sheets ?? []).flatMap((s) =>
      (s.protectedRanges ?? []).map((r) => r.protectedRangeId));

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
      // Cleared and re-added below rather than edited: 0011 changed what the guards SAY
      // and how many of them there are, and a mirror already in the operator's Drive has
      // 0010's single whole-tab warning sitting over columns that are now read back.
      ...oldRanges.map((id) => ({ deleteProtectedRange: { protectedRangeId: id } })),
    ];
    if (requests.length) {
      const reply = await call<{ replies?: { addSheet?: { properties: SheetProps } }[] }>(
        `${SHEETS_API}/${spreadsheetId}:batchUpdate`,
        { method: 'POST', body: JSON.stringify({ requests }) }, token,
      );
      // A tab the operator deleted comes back dressed like the original.
      for (const p of (reply.replies ?? []).flatMap((r) => (r.addSheet ? [r.addSheet.properties] : []))) {
        byTitle.set(p.title, p.sheetId);
      }
    }
    const dress = tabs.flatMap((t) => {
      const id = byTitle.get(t.title);
      if (id === undefined) return [];
      const born = missing.some((m) => m.title === t.title);
      return [
        ...dressRequests(id, t.title as TabTitle),
        ...(born ? sizeRequests(id, t.rows[1]?.length ?? 1) : []),
      ];
    });
    if (dress.length) {
      await call(`${SHEETS_API}/${spreadsheetId}:batchUpdate`,
        { method: 'POST', body: JSON.stringify({ requests: dress }) }, token);
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

  /**
   * Every pullable tab, read TWICE, because neither render option is sufficient alone.
   *
   * `FORMATTED_VALUE` returns what the operator sees, rendered in the spreadsheet's own
   * locale: a date comes back as `4/8/2026`, and whether that is 4 August or 8 April
   * depends on a setting in somebody else's Google account. `UNFORMATTED_VALUE` returns
   * the underlying value — a date is an unambiguous serial — but a text field holding
   * digits arrives as a JSON number, and `JSON.parse` destroyed a sixteen-digit external
   * id before our code ever saw it. So: the unformatted read tells us the cell's TYPE, the
   * formatted one tells us what the operator MEANT. Two requests against a 60-per-minute
   * quota is not a cost worth optimising away.
   */
  const readTabs = async (token: string, spreadsheetId: string): Promise<SheetValues> => {
    const ranges = PULL_TABS.map((t) => `ranges=${encodeURIComponent(`'${t}'`)}`).join('&');
    const read = async (option: string) => {
      const res = await call<{ valueRanges?: { values?: unknown[][] }[] }>(
        `${SHEETS_API}/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=${option}`,
        {}, token,
      );
      return res.valueRanges ?? [];
    };
    const [raw, text] = await Promise.all([read('UNFORMATTED_VALUE'), read('FORMATTED_VALUE')]);
    const values: SheetValues = {};
    PULL_TABS.forEach((tab, i) => {
      values[tab] = { raw: raw[i]?.values ?? [], text: text[i]?.values ?? [] } satisfies TabValues;
    });
    return values;
  };

  /** The provenance an audit row carries. Not a claim about who typed the cell. */
  const pullActor = (): string => `sheet:${settings.get(GOOGLE_ACCOUNT_KEY) ?? 'unknown'}`;

  /** Read the sheet and diff it, which is the one question both doors keep asking. */
  const planFrom = async (token: string, spreadsheetId: string, data: MirrorData): Promise<PullPlan> =>
    planPull({ data, values: await readTabs(token, spreadsheetId), pushedAt: settings.get(KEY.pushedAt) });

  return {
    state(): MirrorState {
      return {
        configured: Boolean(readClientId()),
        connected: Boolean(auth.status().connected),
        url: settings.get(KEY.url),
        pushedAt: settings.get(KEY.pushedAt),
        pulledAt: settings.get(KEY.pulledAt),
      };
    },

    /**
     * Rewrite the mirror. Never automatic: this copies names, emails and phone
     * numbers into a file that is one button away from being shared with anyone,
     * so the consent belongs at the moment it happens.
     *
     * `force` discards edits made in the sheet since the last push. Without it the push
     * REFUSES when the mirror has moved on — the write is clear-then-write, which was
     * merely destructive-by-design until 0011 gave the operator a real reason to type in
     * that file and a real expectation that their typing survives.
     */
    async push(data: MirrorData, opts: { force?: boolean } = {}): Promise<PushOutcome> {
      const token = await auth.accessToken().catch(() => null);
      if (!token) {
        return { ok: false, reason: 'Google is not connected. Connect an account in Settings first.' };
      }

      const pushedAt = new Date().toISOString();
      const tabs = mirrorTabs(data, pushedAt, settings.get(KEY.pulledAt));
      let id = settings.get(KEY.id);
      let recreated = false;
      let note: string | undefined;

      // The interlock: ASK THE SHEET, not a clock.
      //
      // The plan for this said to compare Drive's `modifiedTime`, and measuring it killed
      // that design — Drive lags a Sheets content edit by up to a minute (2026-08-07: a
      // write at 02:28 did not reach `modifiedTime` until 02:30), so a timestamp guard is
      // blind for exactly as long as it takes somebody to type and hit push. Diffing the
      // sheet is immediate, exact, and describes the thing we actually care about — "this
      // file holds edits nobody has pulled" — rather than a proxy for it.
      //
      // It refuses rather than pulling first, because a push and a pull are opposite acts
      // and STEWARD guessing which one was meant is worse than asking.
      if (id && !opts.force) {
        // A file that is gone, or a Drive that is unreachable, is the write path's problem
        // to report: failing a push over a failed *check* would be a new way to be stuck.
        const pending = await planFrom(token, id, data).catch(() => null);
        const held = pending &&
          (pending.changes.length + pending.problems.length + pending.blank.length);
        if (held) {
          const parts = [
            pending!.changes.length && `${pending!.changes.length} record${pending!.changes.length === 1 ? '' : 's'} edited`,
            pending!.problems.length && `${pending!.problems.length} cell${pending!.problems.length === 1 ? '' : 's'} that cannot be read`,
            pending!.blank.length && `${pending!.blank.length} new row${pending!.blank.length === 1 ? '' : 's'}`,
          ].filter(Boolean).join(', ');
          return {
            ok: false,
            stale: true,
            reason: `The mirror has been edited since the last push (${parts}). ` +
              'Pull those edits first, or push anyway and lose them.',
          };
        }
      }

      try {
        if (!id) {
          const made = await create(token, tabs);
          id = made.meta.spreadsheetId!;
          note = made.note;
          settings.set(KEY.id, id);
          settings.set(KEY.title, SPREADSHEET_TITLE);
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
          settings.set(KEY.title, SPREADSHEET_TITLE);
          settings.set(KEY.url, made.meta.spreadsheetUrl ?? '');
          await write(token, id, tabs);
        }

        // The 0011 rename, done once: the file id does not change, so existing share
        // links and bookmarks are unaffected. A failure here is cosmetic, so it is a note.
        if (settings.get(KEY.title) !== SPREADSHEET_TITLE) {
          try {
            await call(`${DRIVE_FILES_API}/${id}?fields=id`, {
              method: 'PATCH', body: JSON.stringify({ name: SPREADSHEET_TITLE }),
            }, token);
            settings.set(KEY.title, SPREADSHEET_TITLE);
          } catch {
            note = note ?? `The mirror could not be renamed to "${SPREADSHEET_TITLE}"; its contents are current.`;
          }
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

    /**
     * The dry run. Reads the sheet, computes the diff, writes NOTHING.
     *
     * This is the whole defence against the one accident no algorithm can find: a block
     * pasted one row down, where every id is real and sits beside somebody else's values.
     */
    async pullPreview(data: MirrorData): Promise<PullOutcome> {
      const token = await auth.accessToken().catch(() => null);
      if (!token) {
        return { ok: false, reason: 'Google is not connected. Connect an account in Settings first.' };
      }
      const id = settings.get(KEY.id);
      if (!id) return { ok: false, reason: 'There is no mirror yet. Create one with a push first.' };

      try {
        const plan = await planFrom(token, id, data);
        return {
          ok: true,
          plan,
          // What the operator is about to READ, not when the file was touched. See
          // `planFingerprint` for why the timestamp this used to carry cannot work.
          revision: planFingerprint(plan),
          url: settings.get(KEY.url) ?? '',
          actor: pullActor(),
        };
      } catch (e) {
        if (e instanceof SheetsError && isApiDisabled(e)) {
          return { ok: false, reason: e.message, enableUrl: enableUrlIn(e.message) };
        }
        if (e instanceof SheetsError && e.status === 404) {
          return { ok: false, reason: 'The mirror is gone from Drive. Push to create a new one.' };
        }
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    /**
     * Apply what a preview showed, and only that.
     *
     * The plan is RE-COMPUTED rather than cached: caching it server-side would be state
     * with a lifetime and a leak, and re-reading is one round trip and always correct.
     * `revision` is the FINGERPRINT the preview returned — the operator reads the diff,
     * thinks, and clicks, while somebody with the share link is still typing, so an apply
     * whose diff is no longer the one that was read is refused rather than resolved.
     *
     * `write` is injected so this module still owns no repository and no services.
     */
    async pullApply(
      data: MirrorData,
      opts: { revision: string; acknowledge?: boolean },
      apply: (plan: PullPlan, actor: string) => number,
    ): Promise<ApplyOutcome> {
      const fresh = await this.pullPreview(data);
      if (!fresh.ok) return { ok: false, reason: fresh.reason };

      if (fresh.revision !== opts.revision) {
        return {
          ok: false,
          plan: fresh.plan,
          reason: 'The diff is no longer the one that was previewed — the sheet or a record ' +
            'moved while it was on screen. Nothing was written; read the new one.',
        };
      }
      const { plan } = fresh;
      if (plan.refusal) return { ok: false, reason: plan.refusal, plan };
      if (!plan.changes.length) return { ok: false, reason: 'Nothing to apply — the sheet and STEWARD agree.' };
      if (plan.needsAck && !opts.acknowledge) {
        return {
          ok: false,
          needsAck: true,
          plan,
          reason: `That would change ${plan.changes.length} of ${plan.records} records. ` +
            'A block pasted one row down looks exactly like this — every id real, every value ' +
            'somebody else\'s. Read the list, then confirm.',
        };
      }

      const applied = apply(plan, fresh.actor);
      const pulledAt = new Date().toISOString();
      settings.set(KEY.pulledAt, pulledAt);
      return { ok: true, applied, actor: fresh.actor, pulledAt };
    },

    /** Forget the mirror locally. The spreadsheet itself stays in the operator's Drive. */
    forget(): void {
      for (const k of Object.values(KEY)) settings.remove(k);
    },
  };
}

export type SheetsMirror = ReturnType<typeof makeSheetsMirror>;
export { TAB_TITLES };
