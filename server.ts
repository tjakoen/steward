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
  '<script type="module" src="/scripts/ai-dispatch.js"></script>';

const renderAppPage = (html: string) => renderPage(html);
const servePage = makePageServer(bunRuntime, config.pagesDir, renderAppPage, PAGE_ASSETS, PAGE_HEAD);

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
        const intent = parseIntent(body, 'anon');
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
