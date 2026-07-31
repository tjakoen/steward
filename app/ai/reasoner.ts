// STEWARD's reasoner — the single in-process writer behind GRAIN's /intent door.
//
// Foundation scope: prove the loop end-to-end. The fixed GRAIN vocabulary has no
// STEWARD-domain verbs yet (extending ActionName is plan 0006-grain-upstream), so
// the proof-of-life rides `demo.run`: it performs a REAL sqlite mutation + audit
// row and streams back a render op. Unknown actions fall through to a no-op ok.

import type { Reasoner, ReasonTools } from '@tjakoen/grain/ai/reasoner.ts';
import type { Intent, Decision, RenderOp } from '@tjakoen/grain/ai/contract.ts';
import { surface } from '@tjakoen/grain/ai/contract.ts';
import type { Services } from '../services/index.ts';

export function makeStewardReasoner(services: Services): Reasoner {
  return {
    async decide(intent: Intent, tools: ReasonTools): Promise<Decision> {
      if (intent.action === 'demo.run') {
        // Pick any customer and append a demo progress note — a real, audited write.
        const customer = services.repos.customers.list()[0];
        let line: string;
        if (customer) {
          const existing = services.repos.tickets.list(customer.id)[0];
          if (existing) {
            const t = services.addProgress(
              existing.id,
              { date: new Date().toISOString(), update: 'Demo intent round-trip (audited).' },
              'ai',
            );
            line = `demo.run → ticket ${t.ticketId} progress appended, audit row written.`;
          } else {
            const t = services.createTicket(
              { customerId: customer.id, title: 'Demo Ticket', dateInitiated: new Date().toISOString(),
                status: 'Not Commenced', dateLastUpdated: new Date().toISOString(), waitingOn: '',
                waitingSince: '', summary: 'Created by demo.run.', nextAction: '', progressLog: [], commRefs: [] },
              'ai',
            );
            line = `demo.run → created ticket ${t.ticketId}, audit row written.`;
          }
        } else {
          line = 'demo.run → no customers yet; seed demo data first.';
        }

        const op: RenderOp = {
          target: surface('reflection'),
          op: 'log',
          text: line,
          provenance: 'system',
          commit: 'committed',
        };
        tools.emit(op);
        return { ok: true, ops: [op], reply: line };
      }

      // Foundation: other actions acknowledged, no domain effect yet.
      return { ok: true, ops: [] };
    },
  };
}
