// STEWARD composition root. BATCH is a library — this file owns the server,
// the single /intent door, the /stream SSE hub, and mounts MILL/PROOF/CRUMB.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// BATCH
import { bunRuntime } from '@tjakoen/batch/platform/bun-runtime.ts';
import { makeStatic } from '@tjakoen/batch/http/static.ts';
import { makePageServer } from '@tjakoen/batch/http/pages.ts';
import { createStream, type Stream } from '@tjakoen/batch/http/stream.ts';
import { createStyleBundle } from '@tjakoen/batch/assets/style-bundle.ts';
// GRAIN
import { createInteractionLayer } from '@tjakoen/grain/ai/interaction-layer.ts';
import { createStreamLogSink } from '@tjakoen/grain/ai/timeline-log.ts';
import {
  isAction, actionsForKind, surface, type Intent,
} from '@tjakoen/grain/ai/contract.ts';
import { buildManifest, type ManifestTarget } from '@tjakoen/grain/ai/manifest.ts';
// MILL / PROOF / CRUMB
import { createMillRoutes, dirSource, type MillCollection } from '@tjakoen/mill/serve.ts';
import { createProofRoutes } from '@tjakoen/proof/routes.ts';
import { createCrumbRoutes } from '@tjakoen/crumb/routes.ts';

import { config } from './config.ts';
import { renderPage } from './render.ts';
import { db } from './app/repo/db.ts';
import { sqliteRepositories } from './app/repo/sqlite.ts';
import { makeServices } from './app/services/index.ts';
import { makeStewardReasoner } from './app/ai/reasoner.ts';
import { seedDemo } from './app/seed/demo.ts';
import { dispatchSteward, isStewardAction } from './app/actions/steward.ts';
import {
  esc, renderForm, customerSchema, clientSchema, customerRow, clientRow, personsLabel,
  ticketSchema, ticketEditSchema, renderBoard, progressList,
} from './app/view/html.ts';
import { OP_EVENT } from '@tjakoen/grain/ai/contract.ts';
import type { Client, Customer, Ticket } from './app/domain/types.ts';
import { renderTicketDocument } from './app/view/pdf.ts';
import { printToPdf, closeBrowser } from './app/pdf/print.ts';

const pkg = (spec: string) => fileURLToPath(import.meta.resolve(spec));

// ---- storage + services ----
db(); // ensure schema exists
const services = makeServices(sqliteRepositories());

// ---- GRAIN door ----
const stream: Stream = createStream();
const aiLayer = createInteractionLayer({
  reasoner: makeStewardReasoner(services),
  stream,
  archiveItem: async () => undefined,
  renderSurface: async () => '',
  logSink: createStreamLogSink(stream),
});

function parseIntent(b: unknown, fallback: string): Intent | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  if (typeof o.surface !== 'string' || typeof o.action !== 'string' || !isAction(o.action)) return null;
  return {
    source: 'user', // stamped at the door — never trust the client
    session: typeof o.session === 'string' && o.session ? o.session : fallback,
    screen: typeof o.screen === 'string' ? o.screen : '',
    surface: o.surface,
    action: o.action,
    payload: o.payload && typeof o.payload === 'object' ? (o.payload as Record<string, unknown>) : {},
  };
}

// ---- page rendering ----
const PAGE_HEAD =
  '<script src="/scripts/theme-boot.js"></script>' +
  '<link rel="stylesheet" href="/styles/variables.css">' +
  '<link rel="stylesheet" href="/styles/global.css">' +
  '<link rel="stylesheet" href="/components.css">' +
  '<link rel="stylesheet" href="/app/steward.css">';
const PAGE_ASSETS =
  '<script type="module" src="/scripts/theme.js"></script>' +
  '<script type="module" src="/scripts/ai-dispatch.js"></script>' +
  '<script type="module" src="/app/steward-live.js"></script>' +
  '<script type="module" src="/app/steward-chat.js"></script>';

const renderAppPage = (html: string) => renderPage(html);
const servePage = makePageServer(bunRuntime, config.pagesDir, renderAppPage, PAGE_ASSETS, PAGE_HEAD);

// ---- app shell -------------------------------------------------------------
// One chrome for EVERY surface (STEWARD routes, MILL help, PROOF plans): a fixed
// sidebar (primary nav — "where you are") + a topbar (context + actions —
// "what you do here") + a scrolling content pane. Counts are read live per
// request so the nav always reflects the DB. Internal PROOF "Plans" is
// intentionally absent from the nav (dev-only surface, still reachable by URL).

interface NavItem { label: string; href: string; ico: string; count?: () => number; }
const NAV_MAIN: NavItem[] = [
  { label: 'Home', href: '/', ico: '◆' },
];
const NAV_WORK: NavItem[] = [
  { label: 'Clients', href: '/clients', ico: '▤', count: () => services.repos.clients.list().length },
  { label: 'Customers', href: '/customers', ico: '☰', count: () => services.repos.customers.list().length },
  { label: 'Tickets', href: '/tickets', ico: '◧', count: () => services.repos.tickets.list().length },
];
const NAV_FOOT: NavItem[] = [
  { label: 'Help', href: '/help', ico: '?' },
  { label: 'Settings', href: '/settings', ico: '⚙' },
];

const isActive = (item: NavItem, path: string): boolean =>
  item.href === '/' ? path === '/' : path === item.href || path.startsWith(item.href + '/');

const navLink = (item: NavItem, path: string): string => {
  const active = isActive(item, path) ? ' aria-current="page"' : '';
  const count = item.count ? `<span class="nav__count">${item.count()}</span>` : '';
  return `<a href="${item.href}"${active}><span class="nav__ico" aria-hidden="true">${item.ico}</span>${esc(item.label)}${count}</a>`;
};

interface ShellOpts {
  path: string;
  crumbs?: string;
  actions?: string;
  /** CSS selector the topbar filter box hides non-matching rows/cards within */
  filter?: { target: string; placeholder?: string };
  /** a create/edit form shown in the slide-in drawer, opened by a "+ New" button */
  drawer?: { title: string; body: string };
}

function shell(title: string, body: string, opts: ShellOpts): string {
  const { path } = opts;
  const nav =
    NAV_MAIN.map((i) => navLink(i, path)).join('') +
    `<span class="nav__label">Workspace</span>` +
    NAV_WORK.map((i) => navLink(i, path)).join('') +
    `<span class="nav__spacer"></span>` +
    NAV_FOOT.map((i) => navLink(i, path)).join('');

  const crumbs = opts.crumbs ?? `<strong>${esc(title)}</strong>`;
  const filterbar = opts.filter
    ? `<div class="searchbar"><input type="search" data-filter="${esc(opts.filter.target)}" ` +
      `placeholder="${esc(opts.filter.placeholder ?? 'Filter…')}" aria-label="Filter"></div>`
    : '';
  const themeToggle = `<button type="button" class="icon ghost" data-toggle-scheme aria-label="Toggle light/dark" title="Toggle light/dark">◐</button>`;
  const newBtn = opts.drawer ? `<button type="button" class="primary" data-drawer-open>+ ${esc(opts.drawer.title)}</button>` : '';

  // A single drawer per page: prefilled with the create form (if any); edit
  // buttons reuse it by swapping the title + loading an /edit fragment.
  const drawer =
    `<aside id="app-drawer" class="drawer" hidden>` +
    `<div class="drawer__backdrop" data-drawer-close></div>` +
    `<div class="drawer__panel"><header class="drawer__head">` +
    `<h2 data-drawer-title>${esc(opts.drawer?.title ?? '')}</h2>` +
    `<button type="button" class="drawer__close" data-drawer-close aria-label="Close">✕</button></header>` +
    `<div class="drawer__body" data-drawer-body>${opts.drawer?.body ?? ''}</div></div></aside>`;

  return (
    `<!DOCTYPE html><html lang="en" data-themes="${config.themes}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · STEWARD</title>${PAGE_HEAD}</head>` +
    `<body><div class="app-shell">` +
    `<aside class="sidebar">` +
    `<a class="sidebar__brand" href="/"><span class="sidebar__mark">S</span> STEWARD</a>` +
    `<nav class="nav">${nav}</nav>` +
    `<div class="sidebar__foot"><span class="avatar">TS</span>` +
    `<span class="who"><strong>Local workspace</strong>no account</span></div>` +
    `</aside>` +
    `<div class="content">` +
    `<header class="topbar"><span class="topbar__crumbs">${crumbs}</span>${filterbar}` +
    `<div class="topbar__actions">${themeToggle}${opts.actions ?? ''}${newBtn}</div></header>` +
    `<main class="pane">${body}</main>` +
    `</div></div>${drawer}${PAGE_ASSETS}</body></html>`
  );
}

function layout(title: string, body: string, opts: ShellOpts): Response {
  return new Response(shell(title, body, opts), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const customerValues = (c: Customer): Record<string, string> => ({
  id: c.id, clientId: c.clientId,
  given: c.persons[0]?.given ?? '', family: c.persons[0]?.family ?? '',
  given2: c.persons[1]?.given ?? '', family2: c.persons[1]?.family ?? '',
  email: c.email, phone: c.phone, notes: c.notes,
});

const clientValues = (c: Client): Record<string, string> => ({
  id: c.id, name: c.name, code: c.code,
  primaryColor: c.branding.primaryColor, secondaryColor: c.branding.secondaryColor,
  companyInfo: c.branding.companyInfo, pdfFooter: c.branding.pdfFooter,
});

const ticketValues = (t: Ticket): Record<string, string> => ({
  id: t.id, title: t.title, status: t.status,
  summary: t.summary, nextAction: t.nextAction, waitingOn: t.waitingOn,
});

// ---- record panels ---------------------------------------------------------
// ONE builder per record kind, rendered in two places: the slide-in drawer
// (row click → `/…/:id/panel` fragment) and the standalone detail page (deep
// link / refresh). Same markup both ways, so the two can't drift. `data-panel-title`
// tells the drawer what to put in its header.

const panelMeta = (parts: string[]): string =>
  `<p class="panel-meta">${parts.filter(Boolean).join(' · ')}</p>`;

/** In the drawer only: a way back out to the full, addressable page. */
const fullPageLink = (href: string, inDrawer: boolean): string =>
  inDrawer ? `<p class="panel-meta"><a href="${href}">Open full page ↗</a></p>` : '';

function clientPanel(c: Client, inDrawer = false): string {
  return (
    `<div data-panel-title="${esc(c.name)}">` +
    panelMeta([`<span class="swatch" style="background:${esc(c.branding.primaryColor)}"></span><span class="mono">${esc(c.code)}</span>`]) +
    `<div data-surface="client-detail">${renderForm(clientSchema('client.update'), 'view', clientValues(c))}</div>` +
    fullPageLink(`/clients/${esc(c.id)}`, inDrawer) +
    `</div>`
  );
}

function customerPanel(c: Customer, inDrawer = false): string {
  const clients = services.repos.clients.list();
  const client = services.repos.clients.get(c.clientId);
  return (
    `<div data-panel-title="${esc(personsLabel(c))}">` +
    panelMeta([`<span class="mono">${esc(c.code)}</span>`, client ? esc(client.name) : '']) +
    `<div data-surface="customer-detail">${renderForm(customerSchema(clients, 'customer.update'), 'view', customerValues(c))}</div>` +
    fullPageLink(`/customers/${esc(c.id)}`, inDrawer) +
    `</div>`
  );
}

function ticketPanel(t: Ticket, inDrawer = false): string {
  const customer = services.repos.customers.get(t.customerId);
  const who = customer ? personsLabel(customer) : '—';
  return (
    `<div data-panel-title="${esc(t.title)}">` +
    panelMeta([`<span class="mono">${esc(t.ticketId)}</span>`, esc(who),
      `<span class="badge accent">${esc(t.status)}</span>`,
      `<a href="/tickets/${esc(t.id)}/pdf" target="_blank" rel="noopener">PDF ↗</a>`]) +
    `<div data-surface="ticket-detail">${renderForm(ticketEditSchema(), 'view', ticketValues(t))}</div>` +
    `<h3 class="section-title">Progress log</h3>${progressList(t)}` +
    `<form class="fb" data-action="ticket.progress" data-mode="create">` +
    `<input type="hidden" name="id" value="${esc(t.id)}" />` +
    `<div class="form-row"><label for="f_update">Add update</label>` +
    `<textarea id="f_update" name="update" placeholder="What happened"></textarea></div>` +
    `<div class="form-controls"><button type="submit">Log</button></div></form>` +
    fullPageLink(`/tickets/${esc(t.id)}`, inDrawer) +
    `</div>`
  );
}

const fragment = (html: string): Response =>
  new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

/** Resolve a ticket's customer label; caches the customer lookups per call. */
function ticketLabeler(): (t: Ticket) => string {
  const cache = new Map<string, string>();
  return (t: Ticket) => {
    let label = cache.get(t.customerId);
    if (label === undefined) {
      const c = services.repos.customers.get(t.customerId);
      label = c ? personsLabel(c) : '';
      cache.set(t.customerId, label);
    }
    return label;
  };
}

// ---- MILL (help + changelog) — rendered INSIDE the app shell ----
const docChrome = (path: string) => (input: { title: string; body: string }) =>
  shell(input.title, `<article class="doc">${input.body}</article>`, { path });
const millCollections: MillCollection[] = [
  { prefix: '/help', title: 'Help', source: dirSource(join(config.contentDir, 'help')), chrome: docChrome('/help') },
  { prefix: '/changelog', title: 'Changelog', source: dirSource(config.contentDir), chrome: docChrome('/changelog') },
];
const millRoutes = createMillRoutes({
  collections: millCollections,
  compose: (html) => renderPage(html),
});

// ---- PROOF (dev plan board) — internal, wrapped in the same shell ----
const proofRoutes = createProofRoutes({
  plansDir: config.plansDir,
  prefix: '/plans',
  chrome: (title, body) =>
    renderAppPage(shell(title, `<link rel="stylesheet" href="/proof.css">${body}`, { path: '/plans' })),
  liveScriptSrc: '/proof-live.js',
});

// ---- CRUMB (guided tours; JSON only) ----
const crumbRoutes = createCrumbRoutes({ toursDir: config.toursDir });

// ---- static + css ----
const styles = createStyleBundle(bunRuntime, [...config.styleRoots]);
const staticServers = Object.entries(config.assetDirs).map(
  ([prefix, dir]) => [prefix, makeStatic(bunRuntime, dir)] as const,
);
const serveFonts = makeStatic(bunRuntime, config.fontsDir);

const css = async (spec: string) =>
  new Response(await Bun.file(pkg(spec)).text(), { headers: { 'Content-Type': 'text/css' } });
const js = async (spec: string) =>
  new Response(await Bun.file(pkg(spec)).text(), { headers: { 'Content-Type': 'text/javascript' } });

const server = Bun.serve({
  port: config.port,
  routes: {
    // --- the door ---
    '/intent': {
      POST: async (req: Request) => {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
        const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const session = typeof o.session === 'string' && o.session ? o.session : 'anon';

        // STEWARD domain vocabulary — dispatched synchronously; ops pushed over SSE.
        if (typeof o.action === 'string' && isStewardAction(o.action)) {
          const result = dispatchSteward(services, {
            action: o.action,
            payload: o.payload && typeof o.payload === 'object' ? (o.payload as Record<string, unknown>) : {},
            actor: 'human', // stamped at the door
            session,
          });
          if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
          for (const op of result.ops) stream.push(session, OP_EVENT, op);
          return new Response(null, { status: 202 });
        }

        // GRAIN vocabulary — fire-and-forget through the interaction layer.
        const intent = parseIntent(body, session);
        if (!intent) return Response.json({ error: 'invalid intent' }, { status: 400 });
        void aiLayer.handleIntent(intent).catch((e) => console.error('[/intent]', e));
        return new Response(null, { status: 202 });
      },
    },
    '/stream': {
      GET: (req: Request) => stream.subscribe(new URL(req.url).searchParams.get('session') ?? 'anon'),
    },
    '/ai/manifest': {
      GET: (req: Request) => {
        const screen = new URL(req.url).searchParams.get('screen') ?? 'home';
        const targets: ManifestTarget[] = [
          { id: surface('reflection'), kind: 'reflection', accepts: actionsForKind('reflection') },
        ];
        return Response.json(buildManifest(screen, targets, { itemCount: 0 }));
      },
    },

    // --- STEWARD demo controls ---
    '/demo/status': {
      GET: () => Response.json({
        clients: services.repos.clients.list().length,
        customers: services.repos.customers.list().length,
        tickets: services.repos.tickets.list().length,
      }),
    },
    '/demo/reset': {
      POST: () => { seedDemo(services.repos); return Response.json({ ok: true }); },
    },

    // --- CRM surfaces (data-driven) ---
    '/clients': {
      GET: () => {
        const clients = services.repos.clients.list();
        const rows = clients.map(clientRow).join('')
          || `<tr class="empty"><td colspan="3">No clients yet.</td></tr>`;
        return layout('Clients',
          `<div class="page-head"><h1>Clients</h1><span class="sub">${clients.length} records</span></div>` +
          `<div class="panel"><table class="dtable">` +
          `<thead><tr><th>Name</th><th>Code</th><th>Company info</th></tr></thead>` +
          `<tbody class="rows" data-surface="client-list">${rows}</tbody></table></div>`,
          { path: '/clients',
            filter: { target: '[data-surface="client-list"]', placeholder: 'Filter clients…' },
            drawer: { title: 'New client', body: renderForm(clientSchema(), 'create') } });
      },
    },
    '/clients/:id': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.clients.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        return layout(c.name,
          `<a class="back-link" href="/clients">← Clients</a>` +
          `<div class="page-head"><h1>${esc(c.name)}</h1></div>` +
          `<div class="panel"><div class="panel__body">${clientPanel(c)}</div></div>`,
          { path: '/clients', crumbs: `<a href="/clients">Clients</a> / <strong>${esc(c.name)}</strong>` });
      },
    },
    '/clients/:id/panel': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.clients.get(id);
        return c ? fragment(clientPanel(c, true)) : new Response('Not found', { status: 404 });
      },
    },
    '/clients/:id/edit': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.clients.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        return new Response(renderForm(clientSchema('client.update'), 'edit', clientValues(c)),
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },
    '/customers': {
      GET: () => {
        const clients = services.repos.clients.list();
        const customers = services.repos.customers.list();
        const rows = customers.map(customerRow).join('')
          || `<tr class="empty"><td colspan="3">No customers yet.</td></tr>`;
        const note = clients.length ? '' : `<p class="muted">Create a client first.</p>`;
        return layout('Customers',
          `<div class="page-head"><h1>Customers</h1><span class="sub">${customers.length} records</span></div>` +
          `<div class="panel"><table class="dtable">` +
          `<thead><tr><th>Name</th><th>Code</th><th>Email</th></tr></thead>` +
          `<tbody class="rows" data-surface="customer-list">${rows}</tbody></table></div>${note}`,
          { path: '/customers',
            filter: { target: '[data-surface="customer-list"]', placeholder: 'Filter customers…' },
            drawer: clients.length ? { title: 'New customer', body: renderForm(customerSchema(clients), 'create') } : undefined });
      },
    },
    '/customers/:id': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.customers.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        return layout(personsLabel(c),
          `<a class="back-link" href="/customers">← Customers</a>` +
          `<div class="page-head"><h1>${esc(personsLabel(c))}</h1></div>` +
          `<div class="panel"><div class="panel__body">${customerPanel(c)}</div></div>`,
          { path: '/customers', crumbs: `<a href="/customers">Customers</a> / <strong>${esc(personsLabel(c))}</strong>` });
      },
    },
    '/customers/:id/panel': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.customers.get(id);
        return c ? fragment(customerPanel(c, true)) : new Response('Not found', { status: 404 });
      },
    },
    '/customers/:id/edit': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.customers.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        const clients = services.repos.clients.list();
        return new Response(renderForm(customerSchema(clients, 'customer.update'), 'edit', customerValues(c)),
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },

    // --- Ticket surfaces (kanban board + detail) ---
    '/tickets': {
      GET: () => {
        const tickets = services.repos.tickets.list();
        const customers = services.repos.customers.list();
        const board = renderBoard(tickets, ticketLabeler());
        const note = customers.length ? '' : `<p class="muted">Create a customer first.</p>`;
        return layout('Tickets',
          `<div class="page-head"><h1>Tickets</h1><span class="sub">${tickets.length} tickets</span></div>${board}${note}`,
          { path: '/tickets',
            filter: { target: '.board', placeholder: 'Filter tickets…' },
            drawer: customers.length ? { title: 'New ticket', body: renderForm(ticketSchema(customers), 'create') } : undefined });
      },
    },
    '/tickets/:id': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const t = services.repos.tickets.get(id);
        if (!t) return new Response('Not found', { status: 404 });
        const pdfBtn = `<a class="btn" href="/tickets/${esc(t.id)}/pdf" target="_blank" rel="noopener">Download PDF</a>`;
        return layout(t.title,
          `<a class="back-link" href="/tickets">← Board</a>` +
          `<div class="page-head"><h1>${esc(t.title)}</h1></div>` +
          `<div class="panel"><div class="panel__body">${ticketPanel(t)}</div></div>`,
          { path: '/tickets', crumbs: `<a href="/tickets">Tickets</a> / <strong>${esc(t.title)}</strong>`, actions: pdfBtn });
      },
    },
    '/tickets/:id/panel': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const t = services.repos.tickets.get(id);
        return t ? fragment(ticketPanel(t, true)) : new Response('Not found', { status: 404 });
      },
    },
    '/tickets/:id/pdf': {
      GET: async (req: Request) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const t = services.repos.tickets.get(id);
        if (!t) return new Response('Not found', { status: 404 });
        // Read-only render — not a mutation, so no /intent, no audit row.
        const customer = services.repos.customers.get(t.customerId);
        const client = customer ? services.repos.clients.get(customer.clientId) : null;
        try {
          const bytes = await printToPdf(renderTicketDocument(t, customer, client));
          // Cast: TS's typed-array generic doesn't unify with the DOM BodyInit union.
          return new Response(bytes as unknown as BodyInit, {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="${t.ticketId}.pdf"`,
            },
          });
        } catch (e) {
          console.error('[/tickets/:id/pdf]', e);
          return new Response('PDF generation failed', { status: 502 });
        }
      },
    },
    '/tickets/:id/edit': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const t = services.repos.tickets.get(id);
        if (!t) return new Response('Not found', { status: 404 });
        return new Response(renderForm(ticketEditSchema(), 'edit', ticketValues(t)),
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },

    // --- Home + Settings (shell routes, replacing the static pages) ---
    '/': {
      GET: () => layout('Home',
        `<div class="page-head"><h1>Home</h1><span class="sub">Foundation build</span></div>` +
        `<p class="muted">AI-first admin cockpit — task-ticket CRM with branded document generation.</p>` +
        `<section class="panel"><div class="panel__head"><h2>Proof of life</h2></div><div class="panel__body">` +
        `<p class="muted">Sends a real Intent through the single door. The reasoner performs an audited SQLite write and streams a render op back over SSE.</p>` +
        `<button type="button" class="primary" id="run-demo">Run demo intent</button>` +
        `<div id="reflection" data-surface="reflection" class="log" aria-live="polite"></div>` +
        `<script type="module">
          const session = crypto.randomUUID();
          const log = document.getElementById('reflection');
          const line = (t) => { const p = document.createElement('p'); p.textContent = t; log.prepend(p); };
          const es = new EventSource('/stream?session=' + session);
          es.addEventListener('op', (e) => { try { const op = JSON.parse(e.data); if (op.text) line(op.text); } catch {} });
          document.getElementById('run-demo').addEventListener('click', async () => {
            const res = await fetch('/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session, screen: 'home', surface: 'screen', action: 'demo.run', payload: {} }) });
            line('intent sent → ' + res.status);
          });
        </script></div></section>`,
        { path: '/' }),
    },
    '/settings': {
      GET: () => layout('Settings',
        `<div class="page-head"><h1>Settings</h1></div>` +
        `<section class="panel"><div class="panel__head"><h2>Appearance</h2></div><div class="panel__body">` +
        `<p class="muted">Theme is a GRAIN token re-skin, saved to this browser.</p>` +
        `<div class="form-row"><label>Mode</label><div class="form-controls">` +
        `<button type="button" data-set-scheme="light">Light</button>` +
        `<button type="button" data-set-scheme="dark">Dark</button>` +
        `<button type="button" data-set-scheme="auto">Auto (OS)</button></div></div>` +
        `<div class="form-row" style="margin-top:1rem"><label>Flavor <span class="mono" data-theme-name></span></label><div class="form-controls">` +
        `<button type="button" data-set-theme="sourdough">Sourdough</button>` +
        `<button type="button" data-set-theme="baguette">Baguette</button>` +
        `<button type="button" data-set-theme="brioche">Brioche</button></div></div>` +
        `</div></section>` +
        `<section class="panel"><div class="panel__head"><h2>Demo mode</h2></div><div class="panel__body">` +
        `<p class="muted">Load fictional data into a separate demo database. Real data is untouched.</p>` +
        `<div class="form-controls"><button type="button" id="reset">Reset demo data</button>` +
        `<button type="button" id="status">Show counts</button></div>` +
        `<pre id="out" class="log"></pre>` +
        `<script type="module">
          const out = document.getElementById('out');
          document.getElementById('reset').addEventListener('click', async () => {
            const r = await fetch('/demo/reset', { method: 'POST' });
            out.textContent = 'reset → ' + JSON.stringify(await r.json());
          });
          document.getElementById('status').addEventListener('click', async () => {
            const r = await fetch('/demo/status');
            out.textContent = JSON.stringify(await r.json(), null, 2);
          });
        </script></div></section>`,
        { path: '/settings' }),
    },

    // --- packaged assets ---
    '/components.css': async () =>
      new Response(await styles.css(), { headers: { 'Content-Type': 'text/css' } }),
    '/proof.css': () => css('@tjakoen/proof/board.css'),
    '/proof-live.js': () => js('@tjakoen/proof/board-live.js'),
    '/crumb.css': () => css('@tjakoen/crumb/crumb.css'),
    '/crumb-live.js': () => js('@tjakoen/crumb/crumb-live.js'),
  },

  async fetch(req: Request) {
    const p = new URL(req.url).pathname;
    if (p.startsWith('/fonts/')) return serveFonts(p.slice('/fonts'.length));
    for (const [prefix, serve] of staticServers) {
      if (p.startsWith(prefix + '/')) return serve(p.slice(prefix.length));
    }
    const fromProof = await proofRoutes(p); if (fromProof) return fromProof;
    const fromCrumb = await crumbRoutes(p); if (fromCrumb) return fromCrumb;
    const fromMill = await millRoutes(p); if (fromMill) return fromMill;
    return servePage(p);
  },

  error(err: Error) {
    console.error('[server]', err);
    return new Response(config.isDev ? String(err.stack) : 'Internal Server Error', { status: 500 });
  },
});

console.log(`STEWARD → http://localhost:${server.port}`);

// Release the headless-Chrome singleton (0004) on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void closeBrowser().finally(() => process.exit(0)); });
}
