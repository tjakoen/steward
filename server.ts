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
} from './app/view/html.ts';
import { OP_EVENT } from '@tjakoen/grain/ai/contract.ts';
import type { Customer } from './app/domain/types.ts';

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
  '<script type="module" src="/app/steward-live.js"></script>';

const renderAppPage = (html: string) => renderPage(html);
const servePage = makePageServer(bunRuntime, config.pagesDir, renderAppPage, PAGE_ASSETS, PAGE_HEAD);

// Full-document layout for STEWARD's dynamic (data-driven) routes.
const NAV = ['Home:/', 'Clients:/clients', 'Customers:/customers', 'Plans:/plans', 'Help:/help', 'Settings:/settings']
  .map((x) => { const [l, h] = x.split(':'); return `<a href="${h}">${l}</a>`; }).join('');
function layout(title: string, body: string): Response {
  const html =
    `<!DOCTYPE html><html lang="en" data-themes="${config.themes}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${PAGE_HEAD}</head>` +
    `<body><header class="app-header"><strong>STEWARD</strong><nav>${NAV}</nav>` +
    `<button type="button" data-toggle-scheme aria-label="Toggle light/dark">◐ Theme</button></header>` +
    `<main class="app-main">${body}</main>${PAGE_ASSETS}</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const customerValues = (c: Customer): Record<string, string> => ({
  id: c.id, clientId: c.clientId,
  given: c.persons[0]?.given ?? '', family: c.persons[0]?.family ?? '',
  given2: c.persons[1]?.given ?? '', family2: c.persons[1]?.family ?? '',
  email: c.email, phone: c.phone, notes: c.notes,
});

// ---- MILL (help + changelog) ----
const millCollections: MillCollection[] = [
  { prefix: '/help', title: 'Help', source: dirSource(join(config.contentDir, 'help')) },
  { prefix: '/changelog', title: 'Changelog', source: dirSource(config.contentDir) },
];
const millRoutes = createMillRoutes({
  collections: millCollections,
  compose: (html) => renderPage(html),
});

// ---- PROOF (dev plan board) ----
const proofRoutes = createProofRoutes({
  plansDir: config.plansDir,
  prefix: '/plans',
  chrome: (title, body) =>
    renderAppPage(
      `<!DOCTYPE html><html lang="en" data-themes="${config.themes}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `${PAGE_HEAD}<link rel="stylesheet" href="/proof.css"></head><body>${body}${PAGE_ASSETS}</body></html>`,
    ),
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
        const rows = clients.map(clientRow).join('') || '<li class="muted">No clients yet.</li>';
        return layout('Clients',
          `<h1>Clients</h1><ul class="rows" data-surface="client-list">${rows}</ul>` +
          `<section><h2>New client</h2>${renderForm(clientSchema(), 'create')}</section>`);
      },
    },
    '/customers': {
      GET: () => {
        const clients = services.repos.clients.list();
        const rows = services.repos.customers.list().map(customerRow).join('') || '<li class="muted">No customers yet.</li>';
        const form = clients.length
          ? `<section><h2>New customer</h2>${renderForm(customerSchema(clients), 'create')}</section>`
          : `<p class="muted">Create a client first.</p>`;
        return layout('Customers',
          `<h1>Customers</h1>` +
          `<form class="fb" data-action="customer.search" data-mode="view" onsubmit="return false">` +
          `<div class="form-row"><label>Search</label><input name="query" id="search" placeholder="name / code / email"></div></form>` +
          `<ul class="rows" data-surface="customer-list">${rows}</ul>${form}`);
      },
    },
    '/customers/:id': {
      GET: (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.customers.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        const clients = services.repos.clients.list();
        return layout(personsLabel(c),
          `<a href="/customers">← Customers</a><h1>${esc(personsLabel(c))}</h1>` +
          `<p class="muted">${esc(c.code)}</p>` +
          `<div data-surface="customer-detail">${renderForm(customerSchema(clients, 'customer.update'), 'view', customerValues(c))}</div>`);
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
