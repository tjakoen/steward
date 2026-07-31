// STEWARD's own operable vocabulary. Runs behind the SAME /intent door as
// GRAIN (the server branches on the action name) and emits the SAME RenderOps
// over the SAME SSE hub. One door, one stream, two vocabularies.

import type { RenderOp } from '@tjakoen/grain/ai/contract.ts';
import type { Services } from '../services/index.ts';
import type { Person } from '../domain/types.ts';
import { customerRow, clientRow, personsLabel } from '../view/html.ts';

export const STEWARD_ACTIONS = [
  'client.create', 'client.update',
  'customer.create', 'customer.update', 'customer.search',
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

export function dispatchSteward(services: Services, intent: StewardIntent): StewardResult {
  const { payload: p, actor } = intent;
  try {
    switch (intent.action) {
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
        const html = `<ul class="rows" data-surface="customer-list">${results.map(customerRow).join('')}</ul>`;
        return { ok: true, ops: [op('customer-list', 'replace', html)], data: results };
      }
      case 'client.create': {
        const c = services.createClient(
          { name: require_(p.name, 'name'), code: require_(p.code, 'code'), active: true,
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
    }
  } catch (e) {
    return { ok: false, ops: [], error: e instanceof Error ? e.message : String(e) };
  }
}
