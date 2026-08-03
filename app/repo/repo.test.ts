import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from './db.ts';
import { sqliteRepositories } from './sqlite.ts';
import { makeServices } from '../services/index.ts';
import { makeTicketId, customerCodeFromPersons } from '../ids.ts';

function fresh() {
  setDb(new Database(':memory:'));
  return makeServices(sqliteRepositories());
}

beforeEach(() => {
  setDb(new Database(':memory:'));
});

test('ticket id: code from family name + padded sequence', () => {
  expect(customerCodeFromPersons([{ given: 'Jane', family: 'Doe' }])).toBe('DOEX');
  expect(customerCodeFromPersons([{ given: 'Bob', family: 'Ng' }])).toBe('NGXX');
  expect(makeTicketId('DOEX', 1)).toBe('TXDOEX0001');
  expect(makeTicketId('DOEX', 42)).toBe('TXDOEX0042');
});

test('per-customer ticket sequence increments and survives deletes', () => {
  const s = fresh();
  const client = s.createClient(
    { name: 'Acme', code: 'acme',
      branding: { logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '' } },
    'human',
  );
  const cust = s.createCustomer(
    { clientId: client.id, code: '', persons: [{ given: 'Jane', family: 'Doe' }], email: '', phone: '', externalId: '', notes: '' },
    'human',
  );
  const t1 = s.createTicket({ customerId: cust.id, title: 'A', dateInitiated: '', status: 'Not Commenced', dateLastUpdated: '', waitingOn: '', waitingSince: '', summary: '', nextAction: '', progressLog: [], commRefs: [] }, 'human');
  const t2 = s.createTicket({ customerId: cust.id, title: 'B', dateInitiated: '', status: 'Not Commenced', dateLastUpdated: '', waitingOn: '', waitingSince: '', summary: '', nextAction: '', progressLog: [], commRefs: [] }, 'human');
  expect(t1.ticketId).toBe('TXDOEX0001');
  expect(t2.ticketId).toBe('TXDOEX0002');
  s.repos.tickets.remove(t2.id);
  const t3 = s.createTicket({ customerId: cust.id, title: 'C', dateInitiated: '', status: 'Not Commenced', dateLastUpdated: '', waitingOn: '', waitingSince: '', summary: '', nextAction: '', progressLog: [], commRefs: [] }, 'human');
  expect(t3.ticketId).toBe('TXDOEX0003'); // no reuse
});

test('every mutation appends an audit row', () => {
  const s = fresh();
  const client = s.createClient(
    { name: 'Acme', code: 'acme',
      branding: { logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '' } },
    'ai',
  );
  s.updateClient(client.id, { name: 'Acme Advisory' }, 'human');
  const rows = s.repos.audit.forEntity('client', client.id);
  expect(rows.length).toBe(2);
  expect(rows.some((r) => r.action === 'create' && r.actor === 'ai')).toBe(true);
  expect(rows.some((r) => r.action === 'update' && r.actor === 'human')).toBe(true);
});

test('customer search matches person name, joint households preserved', () => {
  const s = fresh();
  const client = s.createClient(
    { name: 'Acme', code: 'acme',
      branding: { logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '' } },
    'human',
  );
  s.createCustomer({ clientId: client.id, code: '', persons: [{ given: 'Alex', family: 'Rivera' }, { given: 'Sam', family: 'Rivera' }], email: 'r@example.com', phone: '', externalId: '', notes: '' }, 'human');
  const found = s.searchCustomers('rivera');
  expect(found.length).toBe(1);
  expect(found[0]!.persons.length).toBe(2);
});
