// STEWARD's own operable vocabulary. Runs behind the SAME /intent door as
// GRAIN (the server branches on the action name) and emits the SAME RenderOps
// over the SAME SSE hub. One door, one stream, two vocabularies.

import type { RenderOp } from '@tjakoen/grain/ai/contract.ts';
import type { Services } from '../services/index.ts';
import type { Client, Customer, Person, TicketStatus } from '../domain/types.ts';
import { TICKET_STATUSES } from '../domain/types.ts';
import {
  customerRow, clientRow, personsLabel, ticketCard, progressItem,
} from '../view/html.ts';

export const STEWARD_ACTIONS = [
  'client.create', 'client.update', 'client.archive', 'client.restore',
  'customer.create', 'customer.update', 'customer.search',
  'customer.archive', 'customer.restore',
  'ticket.create', 'ticket.update', 'ticket.status', 'ticket.progress',
  'sheet.push', 'digest.send',
] as const;
export type StewardAction = (typeof STEWARD_ACTIONS)[number];

export function isStewardAction(s: string): s is StewardAction {
  return (STEWARD_ACTIONS as readonly string[]).includes(s);
}

export interface StewardIntent {
  action: StewardAction;
  payload: Record<string, unknown>;
  actor: string; // "human" | "ai"
  session: string;
}

export interface StewardResult {
  ok: boolean;
  ops: RenderOp[];
  reply?: string;
  error?: string;
  data?: unknown;
  /**
   * The record has left the surface it was being edited on, so a panel showing it is now
   * stale and should close. Archiving is the case that made this necessary: the row is
   * removed from the list underneath while the drawer sits there displaying a record that
   * is no longer in the list it was opened from.
   */
  dismiss?: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const require_ = (v: unknown, field: string): string => {
  const s = str(v);
  if (!s) throw new Error(`${field} is required`);
  return s;
};

function personsFrom(p: Record<string, unknown>): Person[] {
  const persons: Person[] = [{ given: require_(p.given, 'given'), family: require_(p.family, 'family') }];
  const g2 = str(p.given2), f2 = str(p.family2);
  if (g2 && f2) persons.push({ given: g2, family: f2 });
  return persons;
}

const op = (target: string, kind: RenderOp['op'], html: string): RenderOp => ({
  target, op: kind, html, provenance: 'user', commit: 'committed',
});

const today = (): string => new Date().toISOString().slice(0, 10);

/** What the mirror push reports back. Structural, so this module imports no Google code. */
export interface SheetPush {
  ok: boolean;
  url?: string;
  counts?: Record<string, number>;
  recreated?: boolean;
  note?: string;
  reason?: string;
}

/**
 * Capabilities the composition root lends this vocabulary. Optional: a dispatcher
 * without them refuses the action by name rather than pretending it worked.
 */
export interface StewardDeps {
  pushSheet?: () => Promise<SheetPush>;
  sendDigest?: () => Promise<DigestSend>;
  /**
   * Move a record's Drive files into (or back out of) the archived folder. Structural, so
   * this module imports no Drive code — and OPTIONAL, so a dispatcher without Google still
   * archives. It is called after the database is stamped and its failure is reported, never
   * raised: a record that failed to archive because Google was down would be the worse bug.
   */
  moveArchivedFiles?: (
    entity: 'client' | 'customer',
    id: string,
    archived: boolean,
  ) => Promise<{ moved: number; note?: string }>;
}

/** What a digest send reports back. Structural, so this module imports no mail code. */
export interface DigestSend {
  ok: boolean;
  error?: string;
  attachments: number;
  tickets: number;
}

/** The verbs that reach outside this process, and therefore the ones that return a promise. */
export type AsyncAction =
  | 'sheet.push' | 'digest.send'
  | 'client.archive' | 'client.restore' | 'customer.archive' | 'customer.restore';

/**
 * `sheet.push`, `digest.send` and the four archive verbs talk to the outside world, and
 * they are the only ones that return a promise. The overloads say exactly that: a
 * caller naming any other action gets a plain result and needs no await, while the
 * door — which only knows it holds *some* action — awaits the union. A second door
 * for the async verbs would split the vocabulary in half for the sake of a keyword.
 */
export function dispatchSteward(
  services: Services,
  intent: StewardIntent & { action: Exclude<StewardAction, AsyncAction> },
  deps?: StewardDeps,
): StewardResult;
export function dispatchSteward(
  services: Services,
  intent: StewardIntent,
  deps?: StewardDeps,
): StewardResult | Promise<StewardResult>;
export function dispatchSteward(
  services: Services,
  intent: StewardIntent,
  deps: StewardDeps = {},
): StewardResult | Promise<StewardResult> {
  const { payload: p, actor } = intent;
  const customerLabel = (customerId: string): string => {
    const c = services.repos.customers.get(customerId);
    return c ? personsLabel(c) : '';
  };
  try {
    switch (intent.action) {
      case 'ticket.create': {
        const d = today();
        const t = services.createTicket(
          { customerId: require_(p.customerId, 'customerId'),
            title: require_(p.title, 'title'),
            dateInitiated: d, status: 'Not Commenced', dateLastUpdated: d,
            waitingOn: str(p.waitingOn), waitingSince: '',
            summary: str(p.summary), nextAction: str(p.nextAction),
            progressLog: [{ date: d, update: 'Ticket created.' }], commRefs: [] },
          actor,
        );
        return { ok: true,
          ops: [op(`ticket-col:${t.status}`, 'append', ticketCard(t, customerLabel(t.customerId)))],
          reply: `Created ticket ${t.ticketId}.`, data: t };
      }
      case 'ticket.update': {
        const id = require_(p.id, 'id');
        const cur = services.repos.tickets.get(id);
        if (!cur) throw new Error(`ticket not found: ${id}`);
        const status = str(p.status);
        if (status && !(TICKET_STATUSES as readonly string[]).includes(status)) {
          throw new Error(`invalid status: ${status}`);
        }
        const t = services.updateTicket(
          id,
          { title: str(p.title) || cur.title,
            status: (status || cur.status) as TicketStatus,
            summary: str(p.summary), nextAction: str(p.nextAction),
            waitingOn: str(p.waitingOn), dateLastUpdated: today() },
          actor,
        );
        return { ok: true, ops: [op(`ticket:${id}`, 'replace', ticketCard(t, customerLabel(t.customerId)))],
          reply: `Updated ticket ${t.ticketId}.`, data: t };
      }
      case 'ticket.status': {
        const id = require_(p.id, 'id');
        const status = require_(p.status, 'status');
        if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
          throw new Error(`invalid status: ${status}`);
        }
        const cur = services.repos.tickets.get(id);
        if (!cur) throw new Error(`ticket not found: ${id}`);
        const t = services.setTicketStatus(id, status as TicketStatus, actor);
        const card = ticketCard(t, customerLabel(t.customerId));
        return { ok: true, ops: [
          op(`ticket:${id}`, 'remove', ''),
          op(`ticket-col:${status}`, 'append', card),
          op(`ticket:${id}`, 'flash', ''),
        ], reply: `Moved ticket ${t.ticketId} to ${status}.`, data: t };
      }
      case 'ticket.progress': {
        const id = require_(p.id, 'id');
        const entry = { date: today(), update: require_(p.update, 'update') };
        const t = services.addProgress(id, entry, actor);
        return { ok: true, ops: [
          op(`ticket-progress:${id}`, 'append', progressItem(entry)),
          op(`ticket:${id}`, 'replace', ticketCard(t, customerLabel(t.customerId))),
        ], reply: `Logged progress on ${t.ticketId}.`, data: t };
      }
      case 'customer.create': {
        const c = services.createCustomer(
          { clientId: require_(p.clientId, 'clientId'), code: '', persons: personsFrom(p),
            email: str(p.email), phone: str(p.phone), externalId: str(p.externalId), notes: str(p.notes) },
          actor,
        );
        return { ok: true, ops: [op('customer-list', 'append', customerRow(c))],
          reply: `Created customer ${personsLabel(c)} (${c.code}).`, data: c };
      }
      case 'customer.update': {
        const id = require_(p.id, 'id');
        const c = services.updateCustomer(
          id,
          { persons: personsFrom(p), email: str(p.email), phone: str(p.phone), notes: str(p.notes) },
          actor,
        );
        return { ok: true, ops: [op(`customer:${id}`, 'replace', customerRow(c))],
          reply: `Updated customer ${personsLabel(c)}.`, data: c };
      }
      case 'customer.search': {
        const results = services.searchCustomers(str(p.query));
        const rows = results.map(customerRow).join('')
          || `<tr class="empty"><td colspan="3">No matches.</td></tr>`;
        const html = `<tbody class="rows" data-surface="customer-list">${rows}</tbody>`;
        return { ok: true, ops: [op('customer-list', 'replace', html)], data: results };
      }
      case 'client.create': {
        const c = services.createClient(
          { name: require_(p.name, 'name'), code: require_(p.code, 'code'),
            branding: {
              logoDataUrl: null,
              primaryColor: str(p.primaryColor) || '#1f4e5f',
              secondaryColor: str(p.secondaryColor) || '#c8a15a',
              companyInfo: str(p.companyInfo),
              pdfFooter: str(p.pdfFooter),
            } },
          actor,
        );
        return { ok: true, ops: [op('client-list', 'append', clientRow(c))],
          reply: `Created client ${c.name}.`, data: c };
      }
      case 'sheet.push': {
        const push = deps.pushSheet;
        if (!push) return { ok: false, ops: [], error: 'the Sheets mirror is not configured' };
        // No render op: the mirror lives in Google, not on this screen, and a target
        // nothing occupies is worse than no target at all (0009's manifest-truth).
        return push().then((r): StewardResult => {
          if (!r.ok) return { ok: false, ops: [], error: r.reason ?? 'the push failed' };
          const counts = Object.entries(r.counts ?? {}).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
          return { ok: true, ops: [],
            reply: `Pushed ${counts} to the Sheets mirror.${r.recreated ? ' The previous mirror was gone, so a new one was created.' : ''}${r.note ? ` ${r.note}` : ''}`,
            data: r };
        }).catch((e: unknown) => ({
          ok: false, ops: [], error: e instanceof Error ? e.message : String(e),
        }));
      }
      case 'digest.send': {
        const send = deps.sendDigest;
        if (!send) return { ok: false, ops: [], error: 'the daily digest is not configured' };
        // No render op, same as `sheet.push`: what this verb produces lands in a
        // mailbox, not on this screen, and a target nothing occupies is worse than
        // no target at all.
        return send().then((r): StewardResult => {
          if (!r.ok) return { ok: false, ops: [], error: r.error ?? 'the send failed' };
          return { ok: true, ops: [],
            reply: r.tickets
              ? `Sent the digest — ${r.tickets} pending ticket${r.tickets === 1 ? '' : 's'}, ` +
                `${r.attachments} report${r.attachments === 1 ? '' : 's'} attached.`
              : 'Sent the digest — nothing is pending.',
            data: r };
        }).catch((e: unknown) => ({
          ok: false, ops: [], error: e instanceof Error ? e.message : String(e),
        }));
      }
      case 'client.update': {
        const id = require_(p.id, 'id');
        const cur = services.repos.clients.get(id);
        if (!cur) throw new Error(`client not found: ${id}`);
        const c = services.updateClient(
          id,
          { name: str(p.name) || cur.name, code: str(p.code) || cur.code,
            branding: {
              ...cur.branding,
              primaryColor: str(p.primaryColor) || cur.branding.primaryColor,
              secondaryColor: str(p.secondaryColor) || cur.branding.secondaryColor,
              companyInfo: str(p.companyInfo) || cur.branding.companyInfo,
              pdfFooter: str(p.pdfFooter) || cur.branding.pdfFooter,
            } },
          actor,
        );
        return { ok: true, ops: [op(`client:${id}`, 'replace', clientRow(c))],
          reply: `Updated client ${c.name}.`, data: c };
      }

      // --- archive and restore (0012) ------------------------------------------
      //
      // STEWARD has never had a delete: `remove()` exists on every repository and only the
      // demo reseed calls it. These four verbs are the delete, and they are reversible.
      //
      // The record acted on is the only one stamped. Its descendants leave the lists with it
      // because the repository filters by lineage, which is what makes a restore give back
      // exactly the state that was there — including a customer that was already archived.
      case 'client.archive':
      case 'client.restore':
      case 'customer.archive':
      case 'customer.restore': {
        const [entity, verb] = intent.action.split('.') as ['client' | 'customer', 'archive' | 'restore'];
        const id = require_(p.id, 'id');
        const archived = verb === 'archive';
        const at = archived ? new Date().toISOString() : null;

        const cur = entity === 'client'
          ? services.repos.clients.get(id)
          : services.repos.customers.get(id);
        if (!cur) throw new Error(`${entity} not found: ${id}`);

        const impact = services.archiveImpact(entity, id);
        const rec = entity === 'client'
          ? services.setClientArchived(id, at, actor)
          : services.setCustomerArchived(id, at, actor);
        const name = 'name' in rec ? rec.name : personsLabel(rec);

        // The database is already stamped. Drive is a courtesy on top of it, so a failure is
        // a sentence in the reply and never an exception — see StewardDeps.moveArchivedFiles.
        const drive = deps.moveArchivedFiles
          ? deps.moveArchivedFiles(entity, id, archived).catch(
              (e: unknown) => ({ moved: 0, note: e instanceof Error ? e.message : String(e) }),
            )
          : Promise.resolve({ moved: 0, note: undefined as string | undefined });

        return drive.then((d) => {
          const row = entity === 'client'
            ? clientRow(rec as Client)
            : customerRow(rec as Customer);
          // Archiving takes the row out of the live list; restoring puts it back. Either way
          // the OTHER list is a page reload away, which is the honest cheap answer until 0014.
          const ops = archived
            ? [op(`${entity}:${id}`, 'remove', '')]
            : [op(`${entity}-list`, 'append', row)];
          const took = impact.tickets || impact.customers
            ? ` ${[impact.customers && `${impact.customers} customer${impact.customers === 1 ? '' : 's'}`,
                   impact.tickets && `${impact.tickets} ticket${impact.tickets === 1 ? '' : 's'}`]
                .filter(Boolean).join(' and ')} went with it.`
            : '';
          const files = d.note
            ? ` Drive was not updated: ${d.note}`
            : d.moved ? ` ${d.moved} file${d.moved === 1 ? '' : 's'} moved in Drive.` : '';
          return { ok: true, ops,
            reply: archived
              ? `Archived ${name}.${took}${files} It can be restored.`
              : `Restored ${name}.${files}`,
            dismiss: true,
            data: rec };
        });
      }
    }
  } catch (e) {
    return { ok: false, ops: [], error: e instanceof Error ? e.message : String(e) };
  }
}
