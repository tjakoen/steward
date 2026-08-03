// Demo dataset — FICTIONAL. Safe for a public repo. No PII.
// Run directly to (re)seed the demo db:  DEMO=1 bun run app/seed/demo.ts
// Or call seedDemo(repos) after a reset.

import { db, dbPath } from '../repo/db.ts';
import { sqliteRepositories } from '../repo/sqlite.ts';
import type { Repositories } from '../repo/ports.ts';
import type { Branding, TicketStatus } from '../domain/types.ts';

const brand = (primary: string, secondary: string, info: string, footer: string): Branding => ({
  logoDataUrl: null,
  primaryColor: primary,
  secondaryColor: secondary,
  companyInfo: info,
  pdfFooter: footer,
});

/** Wipe all domain data (order respects FKs). */
export function clearAll(repos: Repositories): void {
  for (const t of repos.tickets.list()) repos.tickets.remove(t.id);
  for (const c of repos.customers.list()) repos.customers.remove(c.id);
  for (const c of repos.clients.list()) repos.clients.remove(c.id);
}

export function seedDemo(repos: Repositories = sqliteRepositories()): void {
  clearAll(repos);

  const acme = repos.clients.create({
    name: 'Acme Advisory',
    code: 'acme',
    branding: brand('#1f4e5f', '#c8a15a',
      'Acme Advisory Pty Ltd\n123 Sample Street, Exampleton\nABN 00 000 000 000',
      'Acme Advisory — sample footer. This is demo data.'),
  });

  const northwind = repos.clients.create({
    name: 'Northwind Planning',
    code: 'nw',
    branding: brand('#324a7d', '#8fb4d9',
      'Northwind Planning\n456 Demo Avenue, Testville\nABN 11 111 111 111',
      'Northwind Planning — sample footer. This is demo data.'),
  });

  const customers = [
    { clientId: acme.id, persons: [{ given: 'Jane', family: 'Doe' }], email: 'jane.doe@example.com' },
    { clientId: acme.id, persons: [{ given: 'John', family: 'Smith' }], email: 'john.smith@example.com' },
    { clientId: acme.id, persons: [
        { given: 'Alex', family: 'Rivera' }, { given: 'Sam', family: 'Rivera' },
      ], email: 'riveras@example.com' }, // joint household
    { clientId: northwind.id, persons: [{ given: 'Priya', family: 'Nair' }], email: 'priya.nair@example.com' },
    { clientId: northwind.id, persons: [{ given: 'Bob', family: 'Ng' }], email: 'bob.ng@example.com' },
    { clientId: northwind.id, persons: [
        { given: 'Chris', family: 'Okafor' }, { given: 'Dana', family: 'Okafor' },
      ], email: 'okafors@example.com' }, // joint household
  ];

  const created = customers.map((c) =>
    repos.customers.create({ code: '', phone: '', externalId: '', notes: '', ...c }),
  );

  const statuses: TicketStatus[] = ['Not Commenced', 'In Progress', 'Waiting', 'Completed'];
  const titles = ['Review Meeting', 'Service Agreement Renewal', 'Annual Statement', 'Onboarding'];

  created.forEach((cust, i) => {
    const status = statuses[i % statuses.length]!;
    const title = titles[i % titles.length]!;
    repos.tickets.create({
      customerId: cust.id,
      title,
      dateInitiated: '2026-07-27',
      status,
      dateLastUpdated: '2026-07-27',
      waitingOn: status === 'Waiting' ? 'Client' : '',
      waitingSince: status === 'Waiting' ? '2026-07-27' : '',
      summary: `Prepare ${title.toLowerCase()} documentation. (demo data)`,
      nextAction: status === 'Completed' ? 'Task completed.' : `Action ${title.toLowerCase()} on 2026-07-31.`,
      progressLog: [{ date: '2026-07-27', update: 'Task ticket created. (demo)' }],
      commRefs: [],
    });
  });
}

if (import.meta.main) {
  db(); // ensure schema
  seedDemo();
  console.log(`Demo data seeded into ${dbPath()}`);
}
