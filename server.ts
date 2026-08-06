// STEWARD composition root. BATCH is a library — this file owns the server,
// the single /intent door, the /stream SSE hub, and mounts MILL/PROOF/CRUMB.

// FIRST, and it has to stay first: importing this installs the console mirror into
// <dataDir>/steward.log when packaged, so every line the modules below emit while their
// bodies evaluate is captured too (app/log.ts).
import { logFile } from './app/log.ts';

import { mkdir } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// BATCH
import { bunRuntime } from '@tjakoen/batch/platform/bun-runtime.ts';
import { makePageServer } from '@tjakoen/batch/http/pages.ts';
import { createStream, type Stream } from '@tjakoen/batch/http/stream.ts';
// GRAIN
import { createInteractionLayer } from '@tjakoen/grain/ai/interaction-layer.ts';
import { createStreamLogSink } from '@tjakoen/grain/ai/timeline-log.ts';
import {
  isAction, actionsForKind, surface, type Intent,
} from '@tjakoen/grain/ai/contract.ts';
import { buildManifest, type ManifestTarget } from '@tjakoen/grain/ai/manifest.ts';
// MILL / PROOF / CRUMB
import { createMillRoutes, type MillCollection } from '@tjakoen/mill/serve.ts';
import { createProofRoutes } from '@tjakoen/proof/routes.ts';
import { createCrumbRoutes } from '@tjakoen/crumb/routes.ts';

import { config } from './config.ts';
import { renderPage } from './render.ts';
import { db } from './app/repo/db.ts';
import { sqliteRepositories } from './app/repo/sqlite.ts';
import { makeServices, type DocumentStores } from './app/services/index.ts';
import { makeGoogleAuth, makeVerifier, challengeFor, authUrl, GOOGLE_SCOPE } from './app/google/oauth.ts';
import { GoogleDriveStore } from './app/google/drive.ts';
import { makeSheetsMirror } from './app/google/sheets.ts';
import { makeStewardReasoner } from './app/ai/reasoner.ts';
import { CHAT_SURFACE, SCREEN_SURFACE } from './app/ai/surfaces.ts';
import { seedDemo } from './app/seed/demo.ts';
import { dispatchSteward, isStewardAction } from './app/actions/steward.ts';
import {
  esc, renderForm, customerSchema, clientSchema, customerRow, clientRow, personsLabel,
  ticketSchema, ticketEditSchema, renderBoard, progressList, auditList, auditItem, auditTime,
  documentChips, fileSize, previewKind, icon, type IconName,
} from './app/view/html.ts';
import { OP_EVENT } from '@tjakoen/grain/ai/contract.ts';
import type {
  AuditEntity, Client, Customer, DocumentRef, ListScope, Ticket, TicketStatus,
} from './app/domain/types.ts';
import { TICKET_STATUSES } from './app/domain/types.ts';
import { LocalDocumentStore, mimeFor } from './app/docs/store.ts';
import { renderTicketDocument } from './app/view/pdf.ts';
import { documentPrintOptions } from './app/view/doc.ts';
import { printToPdf, closeBrowser } from './app/pdf/print.ts';
import { validateLogo, DISPLAY_SIZE, MAX_BYTES as LOGO_MAX_BYTES } from './app/docs/logo.ts';
import {
  DEFAULT_PORT as SMTP_PORT, KEYS as DIGEST_KEYS, normalisePassword, parseTime,
  readSettings as readDigestSettings, sendDigest, buildWorkspace,
} from './app/mail/digest.ts';
import { digestFor, renderDigestDocument } from './app/view/digest.ts';
import { sendMail } from './app/mail/smtp.ts';
import { makeDigestScheduler, localDate } from './app/mail/scheduler.ts';
import { componentsCss, embeddedSource, isAsset, serveAsset } from './app/assets/serve.ts';
import { listen, openBrowser, probeExisting } from './app/launch.ts';
import { applyUpdate, checkForUpdate, cleanupOldBinaries } from './app/update.ts';
import { dataDir } from './app/paths.ts';

// ---- storage + services ----
db(); // ensure schema exists
const repos = sqliteRepositories();

// Google connection (user consent, PKCE) over a loopback redirect.
//
// The redirect URI is resolved LAZILY from the port actually bound, not the one
// configured: Bun may hand us a different port, and the URI Google redirects to
// has to be one this process is really listening on. Desktop OAuth clients
// accept any loopback port, so this needs no registration.
let listeningPort = config.port;
const googleAuth = makeGoogleAuth(repos.settings, {
  clientId: config.google.clientId,
  clientSecret: config.google.clientSecret,
  get redirectUri() { return `http://127.0.0.1:${listeningPort}${config.google.redirectPath}`; },
});

// Documents: local disk until an account is connected, Drive afterwards. Reads
// route by the store each document RECORDS, so connecting or disconnecting
// Drive never strands files already written somewhere else.
await mkdir(config.docsDir, { recursive: true });
const localStore = new LocalDocumentStore(config.docsDir);
const driveStore = new GoogleDriveStore(googleAuth, config.google.folderName);
const documentStores: DocumentStores = {
  active: () => (googleAuth.status().connected ? driveStore : localStore),
  forKind: (kind) => (kind === 'drive' ? driveStore : localStore),
};
const services = makeServices(repos, documentStores);

// The Sheets mirror: same OAuth, same `drive.file` scope, same Drive folder. One way
// out only — SQLite stays the source of truth, and a spreadsheet that wrote back would
// change records with no actor, no timestamp and no diff (plans/0010-sheets-sync.md).
const sheetsMirror = makeSheetsMirror(
  repos.settings, googleAuth, config.google.folderName, fetch, config.google.clientId,
);
/**
 * Move an archived record's Drive files into STEWARD/Archived, and back on restore (0012).
 *
 * Archiving is a local database write; this is the optional consequence. It runs only when
 * Google is connected, touches only documents this app actually stored in Drive, and reports
 * a failure as a note rather than raising — the record is already archived either way.
 *
 * A client's files are its customers' and their tickets': a client owns no documents itself.
 */
const moveArchivedFiles = async (
  entity: 'client' | 'customer',
  id: string,
  archived: boolean,
): Promise<{ moved: number; note?: string }> => {
  if (!googleAuth.status().connected) return { moved: 0 };
  const customers = entity === 'customer'
    ? [id]
    : services.repos.customers.list(id, 'all').map((c) => c.id);
  const tickets = customers.flatMap((c) => services.repos.tickets.list(c, 'all').map((t) => t.id));

  const docs = [
    ...customers.flatMap((c) => services.documentsFor('customer', c)),
    ...tickets.flatMap((t) => services.documentsFor('ticket', t)),
  ];
  // `storage === 'drive'` excludes the pre-Google local rows; a truthy `storageId` excludes
  // LINKED files, which are the operator's own and deliberately carry no id (0006).
  const ids = docs.filter((d) => d.storage === 'drive' && d.storageId).map((d) => d.storageId);
  if (!ids.length) return { moved: 0 };

  try {
    return { moved: await driveStore.moveArchived(ids, archived) };
  } catch (e) {
    return { moved: 0, note: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Everything the mirror puts in the sheet, read fresh at push time.
 *
 * `'all'`, not the default live scope (0012): archived records keep their row and carry a
 * date in the `archived` column. Dropping them would look like data loss to whoever has the
 * spreadsheet open, and 0011 pulls from this sheet, where a missing row already means
 * "neither create nor delete".
 */
const mirrorData = () => ({
  clients: services.repos.clients.list('all'),
  customers: services.repos.customers.list(undefined, 'all'),
  tickets: services.repos.tickets.list(undefined, 'all'),
});

// ---- the daily digest (0013) ----
// One email a morning with a branded PDF per client, sent from THIS process while
// the app is open — there is no server to host a cron, and inventing one would mean
// a service the operator has not asked for and cannot see.
const runDigest = (today: string, actor: string) => sendDigest({
  repos,
  print: printToPdf,
  send: sendMail,
  // Audited against every client whose work left the building. The recipient is
  // recorded; the message body is not.
  audit: (clientId, recipient, count) => {
    repos.audit.append({
      entity: 'client', entityId: clientId, action: 'update', actor,
      diff: JSON.stringify({ digestSentTo: recipient, tickets: count }),
    });
  },
  log: (line) => console.log(line),
}, today);

const digestScheduler = makeDigestScheduler({
  settings: repos.settings,
  send: (today) => runDigest(today, 'scheduler'),
  log: (line) => console.log(line),
});

// ---- GRAIN door ----
const stream: Stream = createStream();

// Keep every open SSE connection non-idle. BATCH's hub is deliberately transport-only
// and holds no timers, so the heartbeat belongs here at the composition root rather than
// upstream — a timer in `createStream` would be a publish cycle and an opinion imposed on
// every consumer. `EventSource` only dispatches listeners for event names the client
// registered, so an unhandled `ping` is inert in the browser. `.unref()` so it never
// holds the process open on shutdown.
const HEARTBEAT_MS = 20_000;
setInterval(() => stream.broadcast('ping', { t: Date.now() }), HEARTBEAT_MS).unref();

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
  // GRAIN's app-shell island: the rail toggle (an off-canvas drawer below 768px).
  '<script type="module" src="/scripts/shell.js"></script>' +
  // GRAIN's drawer island: open/close, Escape, scrim, and the modal obligations.
  // Loaded BEFORE steward-live.js, which drives it through `window.grain.drawer`.
  '<script type="module" src="/scripts/drawer.js"></script>' +
  '<script type="module" src="/app/steward-live.js"></script>' +
  '<script type="module" src="/app/steward-chat.js"></script>';

const renderAppPage = (html: string) => renderPage(html);
const servePage = makePageServer(bunRuntime, config.pagesDir, renderAppPage, PAGE_ASSETS, PAGE_HEAD);

// ---- app shell -------------------------------------------------------------
// One chrome for EVERY surface (STEWARD routes, MILL help, PROOF plans), and it
// is GRAIN's, not STEWARD's: the app-shell organism hosting a side-rail (primary
// nav — "where you are"), the topbar parts (context + actions — "what you do
// here") and the scrolling main region. Counts are read live per
// request so the nav always reflects the DB. Internal PROOF "Plans" is
// intentionally absent from the nav (dev-only surface, still reachable by URL).

// Nav marks are GRAIN sprite glyphs, not text characters: `◆ ▤ ☰ ◧ ❐ ↻ ⚙ ?`
// came from eight different Unicode blocks and sat on eight different baselines
// at eight optical weights. The sprite is one 24×24 grid at one stroke width.
interface NavItem { label: string; href: string; ico: IconName; count?: () => number; }
const NAV_MAIN: NavItem[] = [
  { label: 'Home', href: '/', ico: 'loop' },
];
const NAV_WORK: NavItem[] = [
  { label: 'Clients', href: '/clients', ico: 'rules', count: () => services.repos.clients.list().length },
  { label: 'Customers', href: '/customers', ico: 'pin', count: () => services.repos.customers.list().length },
  { label: 'Tickets', href: '/tickets', ico: 'tasks', count: () => services.repos.tickets.list().length },
];
const NAV_ACTIVITY: NavItem[] = [
  { label: 'Files', href: '/files', ico: 'files', count: () => services.listDocuments().length },
  { label: 'Activity', href: '/activity', ico: 'traces' },
];
const NAV_FOOT: NavItem[] = [
  { label: 'Help', href: '/help', ico: 'knowledge' },
  { label: 'Settings', href: '/settings', ico: 'settings' },
];

const isActive = (item: NavItem, path: string): boolean =>
  item.href === '/' ? path === '/' : path === item.href || path.startsWith(item.href + '/');

// GRAIN's nav-item: the glyph sits in the rail's shared icon gutter, the label
// beside it, the count in the grid's trailing column. STEWARD supplies the value
// and nothing else — keeping it current is the consumer's job, says nav-item.md.
const navLink = (item: NavItem, path: string): string => {
  const active = isActive(item, path) ? ' aria-current="page"' : '';
  const count = item.count ? `<span class="nav-item__count">${item.count()}</span>` : '';
  return `<a class="nav-item" href="${item.href}"${active}>${icon(item.ico, 'nav__ico', 'sm')}` +
    `<span class="nav-item__label">${esc(item.label)}</span>${count}</a>`;
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
    `<span class="side-rail__label">Workspace</span>` +
    NAV_WORK.map((i) => navLink(i, path)).join('') +
    NAV_ACTIVITY.map((i) => navLink(i, path)).join('') +
    `<div class="side-rail__spacer"></div>` +
    NAV_FOOT.map((i) => navLink(i, path)).join('');

  const crumbs = opts.crumbs ?? `<strong>${esc(title)}</strong>`;
  // The filter says what it hid and offers a way out of it: hiding rows with no
  // running total lets a filtered list be read as the whole one.
  // GRAIN's topbar-search ships the BOX only — that the typing hides rows is
  // STEWARD's, wired to the input in steward-live.js, exactly as topbar.md says.
  const filterbar = opts.filter
    ? `<div class="topbar-search filter-box"><input type="search" data-filter="${esc(opts.filter.target)}" ` +
      `placeholder="${esc(opts.filter.placeholder ?? 'Filter…')}" aria-label="Filter">` +
      `<button type="button" class="linkish filter-clear" data-filter-clear hidden>Clear</button></div>` +
      `<span class="filter-note" data-filter-note role="status"></span>`
    : '';
  const themeToggle = `<button type="button" class="btn topbar__btn" data-toggle-scheme aria-label="Toggle light/dark" title="Toggle light/dark">◐</button>`;
  // NOT `data-drawer-open`: GRAIN's own opener would fire first and open the
  // drawer on whatever content it last held. STEWARD restores the create form,
  // then opens through the documented seam (`window.grain.drawer`), so focus
  // lands on the first field of the form the operator actually asked for.
  const newBtn = opts.drawer ? `<button type="button" class="btn" data-variant="soft" data-drawer-new>+ ${esc(opts.drawer.title)}</button>` : '';

  // A single drawer per page: prefilled with the create form (if any); edit
  // buttons reuse it by swapping the title + loading an /edit fragment.
  // GRAIN's drawer organism owns the shape AND the modal obligations (focus in,
  // Tab trapped, the rest of the page inert, focus returned) via scripts/drawer.js.
  // The dialog role sits on the PANEL, which is what that file's markup contract
  // and the close/scrim handling expect.
  const drawer =
    `<aside id="app-drawer" class="drawer" data-drawer hidden>` +
    `<div class="drawer__backdrop" data-drawer-close></div>` +
    `<div class="drawer__panel" role="dialog" aria-modal="true" aria-labelledby="app-drawer-title">` +
    `<header class="drawer__head">` +
    `<h2 id="app-drawer-title" data-drawer-title>${esc(opts.drawer?.title ?? '')}</h2>` +
    `<button type="button" class="btn topbar__btn" data-drawer-close aria-label="Close">` +
    `${icon('close', undefined, 'sm')}</button></header>` +
    `<div class="drawer__body drawer-content" data-drawer-body>${opts.drawer?.body ?? ''}</div></div></aside>`;

  return (
    `<!DOCTYPE html><html lang="en" data-themes="${config.themes}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · STEWARD</title>${PAGE_HEAD}</head>` +
    // The shell is GRAIN's app-shell organism: STEWARD's chrome sits in its
    // regions rather than in a grid of STEWARD's own (which collided with it —
    // see the top of steward.css). The two regions STEWARD has no use for are
    // switched off with the shell's own attributes, not by redefining the grid.
    `<body><div class="app-shell" data-aside-hidden="true" data-console-hidden="true">` +
    // The rail is GRAIN's side-rail: brand, items, a spacer, the identity foot,
    // all direct children (the old `<nav>` wrapper would have hidden them from
    // the rail's flex column). It stays a landmark by BEING the <nav>.
    // The brand mark is a <strong>, not a <span>: the collapsed rail hides every
    // span in the brand row, which is how the word goes and the mark stays.
    `<nav class="app-shell__rail side-rail" aria-label="Primary">` +
    `<a class="side-rail__brand rail-brand" href="/"><strong class="rail-mark">S</strong><span>STEWARD</span></a>` +
    nav +
    `<div class="side-rail__foot"><span class="side-rail__avatar">TS</span>` +
    `<span class="side-rail__who"><strong>Local workspace</strong>no account</span></div>` +
    `</nav>` +
    // Below 768px the rail is an off-canvas drawer; the scrim dismisses it and
    // the topbar's ☰ opens it. Both are GRAIN's — scripts/shell.js drives them.
    `<div class="app-shell__scrim" data-shell="rail-toggle"></div>` +
    `<header class="app-shell__topbar">` +
    `<button type="button" class="btn topbar__btn topbar__menu" data-shell="rail-toggle"` +
    ` aria-label="Show navigation">${icon('menu', undefined, 'sm')}</button>` +
    `<span class="topbar-crumbs">${crumbs}</span>${filterbar}` +
    `<div class="topbar-ctl topbar-actions">${themeToggle}${opts.actions ?? ''}${newBtn}</div></header>` +
    `<main class="app-shell__main pane">${body}</main>` +
    `</div>${drawer}${PAGE_ASSETS}</body></html>`
  );
}

function layout(title: string, body: string, opts: ShellOpts): Response {
  return new Response(shell(title, body, opts), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * The in-flight OAuth login. One at a time, held in memory only: the verifier
 * must never be persisted or sent anywhere, and a restart should invalidate it.
 */
let pendingLogin: { verifier: string; state: string; at: number } | null = null;

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

/** Related records as clickable chips — the connective tissue between panels. */
const chips = (items: { href: string; label: string }[], empty: string): string =>
  items.length
    ? `<div class="chips">${items.map((i) =>
        `<a class="chip" href="${i.href}" data-href="${i.href}">${esc(i.label)}</a>`).join('')}</div>`
    : `<p class="muted">${esc(empty)}</p>`;

/** Where a record sits in Client → Customer → Ticket, as links. */
const lineage = (parts: string[]): string =>
  parts.length ? `<p class="lineage">${parts.join(' <span aria-hidden="true">›</span> ')}</p>` : '';

/**
 * Name a record for display elsewhere (activity feed, file manager). Returns
 * null when the record is gone: the audit trail and document index outlive the
 * records they point at, and a dead link is worse than plain text.
 */
const recordLabel = (entity: string, id: string): string | null => {
  if (entity === 'client') return services.repos.clients.get(id)?.name ?? null;
  if (entity === 'customer') {
    const c = services.repos.customers.get(id);
    return c ? personsLabel(c) : null;
  }
  const t = services.repos.tickets.get(id);
  return t ? `${t.ticketId} · ${t.title}` : null;
};

const recordHref = (entity: string, id: string): string => `/${esc(entity)}s/${esc(id)}`;

/** The owning record as a link, or plain text if it no longer exists. */
const recordRef = (entity: string, id: string): string => {
  const name = recordLabel(entity, id);
  if (name === null) return `<span class="sub">${esc(entity)} (removed)</span>`;
  const href = recordHref(entity, id);
  return `<a href="${href}" data-href="${href}">${esc(name)}</a>`;
};

const clientLink = (c: Client): string =>
  `<a href="/clients/${esc(c.id)}" data-href="/clients/${esc(c.id)}">${esc(c.name)}</a>`;
const customerLink = (c: Customer): string =>
  `<a href="/customers/${esc(c.id)}" data-href="/customers/${esc(c.id)}">${esc(personsLabel(c))}</a>`;

/** The recorded history of one record, rendered as a timeline section. */
const historySection = (entity: string, id: string): string =>
  `<h3 class="section-title">History</h3>` +
  auditList(services.repos.audit.forEntity(entity, id), `audit:${entity}:${id}`);

/**
 * A record's files, plus the attach control. Upload is a plain multipart form
 * (not an /intent): it carries bytes, which the JSON door doesn't take.
 */
const documentsSection = (entity: AuditEntity, id: string): string =>
  `<h3 class="section-title">Documents</h3>` +
  documentChips(services.documentsFor(entity, id), `documents:${entity}:${id}`) +
  `<form class="attach" method="post" action="/files/upload" enctype="multipart/form-data">` +
  `<input type="hidden" name="entity" value="${esc(entity)}">` +
  `<input type="hidden" name="entityId" value="${esc(id)}">` +
  `<div class="form-row"><input type="file" name="file" required></div>` +
  `<div class="form-controls"><button type="submit" class="btn">Attach</button>` +
  // Linking an EXISTING Drive file can only start from a connected account —
  // there is nothing to pick from otherwise.
  (googleAuth.status().connected
    ? `<button type="button" class="btn" data-picker data-entity="${esc(entity)}" data-entity-id="${esc(id)}">` +
      `Link from Drive</button>`
    : '') +
  `</div></form>`;

/**
 * The ticket document, with the files filed against it.
 *
 * 0013 put a Documents section on the ticket — it was always odd that the artefact
 * which gets sent on never carried the files it is about. The renderer stays pure,
 * so the fetch happens here.
 */
const ticketDocument = (t: Ticket, customer: Customer | null, client: Client | null): string =>
  renderTicketDocument(t, customer, client, services.documentsFor('ticket', t.id));

/** In the drawer only: a way back out to the full, addressable page. */
const fullPageLink = (href: string, inDrawer: boolean): string =>
  inDrawer ? `<p class="panel-meta"><a href="${href}">Open full page ↗</a></p>` : '';

/** What the logo route's short outcomes mean. Anything else is already a sentence. */
const LOGO_NOTICE: Record<string, string> = {
  set: 'Logo updated. It appears on every document this client generates from now on.',
  removed: 'Logo removed. Documents fall back to the wordmark.',
  none: 'No file was chosen.',
};

/**
 * The logo: the one branding value that is BYTES, and therefore the one that
 * cannot come through the JSON `/intent` door. A plain multipart form, following
 * 0006's precedent for uploads — and the reason `clientSchema` has six fields and
 * not seven.
 *
 * Removing has to be possible too. "Upload a white square" is not a way to clear
 * a value.
 */
function logoSection(c: Client): string {
  const has = Boolean(c.branding.logoDataUrl);
  const well = has
    ? `<div class="logo-well"><img src="${esc(c.branding.logoDataUrl)}" alt="${esc(c.name)} logo"></div>`
    : `<div class="logo-well is-empty">No logo set</div>`;
  return (
    `<h3 class="section-title">Logo</h3>` + well +
    `<form class="attach" method="post" action="/clients/${esc(c.id)}/logo" enctype="multipart/form-data">` +
    `<div class="form-row"><input type="file" name="logo" accept="image/png,image/jpeg" required></div>` +
    `<div class="form-controls">` +
    `<button type="submit" class="btn">${has ? 'Replace logo' : 'Upload logo'}</button>` +
    // `formnovalidate`, or the empty (and `required`) file input blocks the one
    // submit that is not supposed to carry a file.
    (has ? `<button type="submit" class="btn" data-variant="soft" name="remove" value="1" formnovalidate>Remove</button>` : '') +
    `</div></form>` +
    `<p class="muted">PNG or JPEG, up to ${LOGO_MAX_BYTES / 1024} KB. Shown at ` +
    `${DISPLAY_SIZE.width} × ${DISPLAY_SIZE.height} on generated documents — anything larger is stored but never seen.</p>` +
    (has ? ''
      : `<p class="muted">Without one, documents use the client's name as a wordmark in the primary ` +
        `colour. That is a real design, not a placeholder — a client may prefer it.</p>`)
  );
}

/**
 * The badge that goes in the META line, not at the foot of the page.
 *
 * The archive block at the bottom of a panel says everything — and the browser pass found
 * that a reader landing on an archived record sees a perfectly ordinary page with an Edit
 * button and does not learn otherwise for another thousand pixels. The state has to be
 * legible where the name is.
 */
const archivedBadge = (archivedAt: string | null): string[] =>
  archivedAt ? [`<span class="badge badge-archived">Archived</span>`] : [];

/**
 * `?archived=1` — the door to what is otherwise invisible by construction (0012).
 *
 * Deliberately the cheap version. Real filtering is 0014's job and archived-versus-live is
 * one facet among several there; building a filter framework here would be 0014 arriving
 * early and badly. The repository read already takes the scope, so 0014 absorbs this.
 */
const archivedScope = (req: Request): ListScope =>
  new URL(req.url).searchParams.get('archived') ? 'archived' : 'live';

/** The way in and back out, shown only when there is something to see. */
const archivedLink = (path: string, scope: ListScope, archivedCount: number): string => {
  if (scope === 'archived') return `<p class="panel-meta"><a href="${path}">← Back to the live list</a></p>`;
  if (!archivedCount) return '';
  return `<p class="panel-meta"><a href="${path}?archived=1">${archivedCount} archived</a></p>`;
};

/**
 * Archive, or restore — the delete STEWARD never had (0012).
 *
 * It states what will happen and then does it, rather than asking twice: the verb is
 * reversible, and a confirmation that adds no information is a click people learn to
 * dismiss. The counts are read, not guessed, and they include records that are already
 * archived on their own, because those leave the lists too and come back untouched.
 */
function archiveSection(entity: 'client' | 'customer', id: string, archivedAt: string | null): string {
  if (archivedAt) {
    return (
      `<div class="archived-note">` +
      `<p><strong>Archived</strong> ${esc(auditTime(archivedAt))}. It is hidden from every ` +
      `list and from the daily digest, and it still has its full history.</p>` +
      `<form class="fb inline" data-action="${entity}.restore" data-mode="update">` +
      `<input type="hidden" name="id" value="${esc(id)}" />` +
      `<button type="submit" class="btn" data-variant="soft">Restore</button></form></div>`
    );
  }
  const { customers, tickets } = services.archiveImpact(entity, id);
  const goes = [
    customers && `${customers} customer${customers === 1 ? '' : 's'}`,
    tickets && `${tickets} ticket${tickets === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' and ');
  return (
    `<div class="archive-box">` +
    `<p class="muted-note">Archiving hides this record${goes ? ` and its ${goes}` : ''} from every ` +
    `list and from the daily digest. Nothing is deleted, the history stays, and it can be ` +
    `restored. Files in Drive move to the archived folder.</p>` +
    `<form class="fb inline" data-action="${entity}.archive" data-mode="update">` +
    `<input type="hidden" name="id" value="${esc(id)}" />` +
    `<button type="submit" class="btn" data-variant="soft">Archive</button></form></div>`
  );
}

function clientPanel(c: Client, inDrawer = false, notice = ''): string {
  // `'all'` on an archived client's own page: its customers are hidden from the LISTS by
  // descent, but the record you are looking at is exactly where you need to see them.
  const customers = services.repos.customers.list(c.id, c.archivedAt ? 'all' : 'live');
  return (
    `<div data-panel-title="${esc(c.name)}">` +
    notice +
    panelMeta([...archivedBadge(c.archivedAt),
      `<span class="swatch" style="background:${esc(c.branding.primaryColor)}"></span><span class="mono">${esc(c.code)}</span>`,
      `${customers.length} customer${customers.length === 1 ? '' : 's'}`]) +
    `<div data-surface="client-detail">${renderForm(clientSchema('client.update'), 'view', clientValues(c))}</div>` +
    logoSection(c) +
    `<h3 class="section-title">Customers</h3>` +
    chips(customers.map((x) => ({ href: `/customers/${x.id}`, label: personsLabel(x) })), 'No customers yet.') +
    documentsSection('client', c.id) +
    historySection('client', c.id) +
    archiveSection('client', c.id, c.archivedAt) +
    fullPageLink(`/clients/${esc(c.id)}`, inDrawer) +
    `</div>`
  );
}

function customerPanel(c: Customer, inDrawer = false): string {
  const clients = services.repos.clients.list();
  const client = services.repos.clients.get(c.clientId);
  const tickets = services.repos.tickets.list(c.id, c.archivedAt ? 'all' : 'live');
  return (
    `<div data-panel-title="${esc(personsLabel(c))}">` +
    lineage([client ? clientLink(client) : '', `<strong>${esc(personsLabel(c))}</strong>`].filter(Boolean)) +
    panelMeta([...archivedBadge(c.archivedAt), `<span class="mono">${esc(c.code)}</span>`,
      `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`]) +
    `<div data-surface="customer-detail">${renderForm(customerSchema(clients, 'customer.update'), 'view', customerValues(c))}</div>` +
    `<h3 class="section-title">Tickets</h3>` +
    chips(tickets.map((t) => ({ href: `/tickets/${t.id}`, label: `${t.ticketId} · ${t.title}` })), 'No tickets yet.') +
    documentsSection('customer', c.id) +
    historySection('customer', c.id) +
    archiveSection('customer', c.id, c.archivedAt) +
    fullPageLink(`/customers/${esc(c.id)}`, inDrawer) +
    `</div>`
  );
}

function ticketPanel(t: Ticket, inDrawer = false): string {
  const customer = services.repos.customers.get(t.customerId);
  const client = customer ? services.repos.clients.get(customer.clientId) : null;
  return (
    `<div data-panel-title="${esc(t.title)}">` +
    lineage([client ? clientLink(client) : '', customer ? customerLink(customer) : '',
      `<strong>${esc(t.ticketId)}</strong>`].filter(Boolean)) +
    panelMeta([`<span class="badge badge-accent">${esc(t.status)}</span>`,
      `<a href="/tickets/${esc(t.id)}/pdf" target="_blank" rel="noopener">PDF ↗</a>`,
      // Saving is explicit: the link above is a live render, this keeps a copy
      // as a document of THIS ticket rather than silently filing every preview.
      `<form method="post" action="/tickets/${esc(t.id)}/pdf/save" class="inline">` +
      `<button type="submit" class="linkish">Save PDF to documents</button></form>`]) +
    `<div data-surface="ticket-detail">${renderForm(ticketEditSchema(), 'view', ticketValues(t))}</div>` +
    `<h3 class="section-title">Progress log</h3>${progressList(t)}` +
    `<form class="fb" data-action="ticket.progress" data-mode="create">` +
    `<input type="hidden" name="id" value="${esc(t.id)}" />` +
    `<div class="form-row"><label for="f_update">Add update</label>` +
    `<textarea id="f_update" name="update" placeholder="What happened"></textarea></div>` +
    `<div class="form-controls"><button type="submit" class="btn">Log</button></div></form>` +
    documentsSection('ticket', t.id) +
    historySection('ticket', t.id) +
    fullPageLink(`/tickets/${esc(t.id)}`, inDrawer) +
    `</div>`
  );
}

/**
 * A document's own panel: what it is, which record it belongs to, and — where
 * the browser can render it — the file itself. Preview is inline for images
 * and PDFs; everything else offers the bytes rather than pretending.
 */
async function documentPanel(d: DocumentRef, inDrawer = false): Promise<string> {
  const kind = previewKind(d.mimeType);
  const raw = `/files/${esc(d.id)}/raw`;
  let preview: string;
  if (d.source === 'link') {
    preview = `<p class="muted">This file lives in Google Drive — STEWARD stores a link, not a copy.</p>` +
      `<p><a class="btn" href="${esc(d.webViewLink)}" target="_blank" rel="noopener">Open in Drive ↗</a></p>`;
  } else if (kind === 'image') {
    preview = `<div class="preview"><img src="${raw}" alt="${esc(d.name)}"></div>`;
  } else if (kind === 'pdf') {
    preview = `<div class="preview preview--pdf"><iframe src="${raw}" title="${esc(d.name)}"></iframe></div>`;
  } else if (kind === 'text') {
    const bytes = await services.readDocument(d);
    const text = bytes ? new TextDecoder().decode(bytes.slice(0, 20_000)) : '';
    preview = `<pre class="preview preview--text">${esc(text)}</pre>`;
  } else {
    preview = `<p class="muted">No preview for ${esc(d.mimeType || 'this file type')}.</p>`;
  }

  return (
    `<div data-panel-title="${esc(d.name)}">` +
    lineage([recordRef(d.entity, d.entityId), `<strong>${esc(d.name)}</strong>`]) +
    panelMeta([
      `<span class="badge" data-source="${esc(d.source)}">${esc(d.source)}</span>`,
      esc(d.mimeType || 'unknown type'), esc(fileSize(d.size)), esc(auditTime(d.createdAt)),
    ]) +
    preview +
    `<div class="form-controls">` +
    (d.source === 'link'
      ? ''
      : `<a class="btn" href="${raw}?download=1" download="${esc(d.name)}">Download</a>`) +
    `<form method="post" action="/files/${esc(d.id)}/delete" onsubmit="return confirm('Remove this document?')">` +
    `<button type="submit" class="btn">Remove</button></form></div>` +
    fullPageLink(`/files/${esc(d.id)}`, inDrawer) +
    `</div>`
  );
}

// ---- home ------------------------------------------------------------------
// The landing route answers three questions in the order an operator asks them:
// how big is the workspace, what is waiting on me, and what changed since I was
// last here. Everything on it is a link INTO the work — Home is a doorway, not
// a destination, so it holds no controls of its own.

/** A KPI tile that goes somewhere (GRAIN's `.stat`, worn by a link). */
const statTile = (href: string, value: number, label: string, sub?: string): string =>
  `<a class="stat home-stat" href="${href}">` +
  `<span class="stat__value">${value}</span><span class="stat__label">${esc(label)}</span>` +
  (sub ? `<span class="stat__sub">${esc(sub)}</span>` : '') +
  `</a>`;

const STATUS_MARK: Record<TicketStatus, IconName> = {
  'Not Commenced': 'plus',
  'In Progress': 'loop',
  'Waiting': 'pin',
  'Completed': 'check',
};

function homePage(): string {
  const clients = services.repos.clients.list();
  const customers = services.repos.customers.list();
  const tickets = services.repos.tickets.list();
  const docs = services.listDocuments();
  const open = tickets.filter((t) => t.status !== 'Completed');
  const waiting = tickets.filter((t) => t.status === 'Waiting');
  const recent = services.repos.audit.recent(8);

  const ticketLink = (t: Ticket): string =>
    `<a href="/tickets/${esc(t.id)}" data-href="/tickets/${esc(t.id)}">${esc(t.ticketId)} · ${esc(t.title)}</a>`;

  const statusRows = TICKET_STATUSES.map((s) => {
    const n = tickets.filter((t) => t.status === s).length;
    return (
      `<li class="status-list__item"${n ? '' : ' data-state="waiting"'}>` +
      `<span class="status-list__mark">${icon(STATUS_MARK[s], undefined, 'sm')}</span>` +
      `<span class="status-list__title"><a href="/tickets">${esc(s)}</a></span>` +
      `<span class="status-list__meta">${n}</span></li>`
    );
  }).join('');

  // "Waiting" is the only status that names something outside STEWARD's control,
  // which makes it the one list worth surfacing before the operator goes looking.
  const waitingRows = waiting.length
    ? `<ul class="status-list">${waiting.slice(0, 6).map((t) =>
        `<li class="status-list__item">` +
        `<span class="status-list__mark">${icon('pin', undefined, 'sm')}</span>` +
        `<span class="status-list__title">${ticketLink(t)}</span>` +
        `<span class="status-list__meta">${esc(t.waitingOn || 'unspecified')}</span></li>`).join('')}</ul>` +
      (waiting.length > 6 ? `<p class="panel-meta"><a href="/tickets">All ${waiting.length} waiting tickets</a></p>` : '')
    : `<p class="muted">Nothing is waiting on anyone else.</p>`;

  const activityRows = recent.length
    ? `<ul class="audit">${recent.map((e) => auditItem(e, recordRef(e.entity, e.entityId))).join('')}</ul>` +
      `<p class="panel-meta"><a href="/activity">All activity</a></p>`
    : `<p class="muted">No activity recorded yet.</p>`;

  // An empty workspace should say so, and say what to do about it, rather than
  // rendering four zeroes and three empty panels.
  const empty = !clients.length && !customers.length && !tickets.length;
  if (empty) {
    return (
      `<div class="page-head"><h1>Home</h1><span class="sub">Empty workspace</span></div>` +
      `<section class="panel"><div class="panel__head"><h2>Nothing here yet</h2></div><div class="panel__body">` +
      `<p>STEWARD tracks work as <strong>tickets</strong> about a <strong>customer</strong>, who belongs to a ` +
      `<strong>client</strong> — the business whose branding the generated documents carry. Start with a client.</p>` +
      `<p><a class="btn" data-variant="soft" href="/clients">Go to Clients</a></p>` +
      `<p class="muted">To look around with data first, load the sample workspace: ` +
      `<code>bun run seed:demo</code>.</p>` +
      `</div></section>`
    );
  }

  return (
    `<div class="page-head"><h1>Home</h1><span class="sub">Local workspace</span></div>` +
    `<div class="home-stats">` +
    statTile('/tickets', open.length, open.length === 1 ? 'open ticket' : 'open tickets',
      `${tickets.length} in total`) +
    statTile('/clients', clients.length, clients.length === 1 ? 'client' : 'clients') +
    statTile('/customers', customers.length, customers.length === 1 ? 'customer' : 'customers') +
    statTile('/files', docs.length, docs.length === 1 ? 'document' : 'documents') +
    `</div>` +
    `<div class="home-cols">` +
    `<section class="panel"><div class="panel__head"><h2>Tickets by status</h2></div>` +
    `<div class="panel__body"><ul class="status-list">${statusRows}</ul></div></section>` +
    `<section class="panel"><div class="panel__head"><h2>Waiting on someone else</h2></div>` +
    `<div class="panel__body">${waitingRows}</div></section>` +
    `</div>` +
    `<section class="panel"><div class="panel__head"><h2>Recent activity</h2></div>` +
    `<div class="panel__body">${activityRows}</div></section>`
  );
}

const fragment = (html: string): Response =>
  new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

/** Back to where the operator was, after a form post that carries bytes. */
const backTo = (path: string): Response =>
  new Response(null, { status: 303, headers: { Location: path } });

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
  { prefix: '/help', title: 'Help', source: embeddedSource('/help'), chrome: docChrome('/help') },
  { prefix: '/changelog', title: 'Changelog', source: embeddedSource('/changelog'), chrome: docChrome('/changelog') },
];
const millRoutes = createMillRoutes({
  collections: millCollections,
  compose: (html) => renderPage(html),
});

// ---- PROOF (dev plan board) and CRUMB (guided tours) ----
//
// Both read a DIRECTORY, and both are deliberately left that way: `plans/` is the
// internal development board and `tours/` does not exist yet. Shipping this plan file to
// an operator is noise, not a feature, so a binary simply has no plans to show.
//
// They must therefore MISS rather than throw when the directory is absent — `readdir` on
// a missing path is an ENOENT, and an unguarded one turns "no plans here" into a 500 on
// the way to every other route, since these run before MILL and the page server.
const missing = async (): Promise<Response | null> => null;
const hasDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const proofRoutes = hasDir(config.plansDir)
  ? createProofRoutes({
      plansDir: config.plansDir,
      prefix: '/plans',
      chrome: (title, body) =>
        renderAppPage(shell(title, `<link rel="stylesheet" href="/proof.css">${body}`, { path: '/plans' })),
      liveScriptSrc: '/proof-live.js',
    })
  : missing;

const crumbRoutes = hasDir(config.toursDir) ? createCrumbRoutes({ toursDir: config.toursDir }) : missing;

// ---- static + css ----
// Every byte comes from the embedded manifest (build/assets.gen.ts) rather than from a
// directory walk, in a checkout exactly as in the binary. See app/assets/serve.ts.

// A packaged second launch focuses the running app rather than starting a second server
// on a second port. From a checkout this is skipped entirely: `PORT=3211 bun server.ts`
// beside a running instance is a deliberate act, not a stray double-click.
if (config.packaged) {
  const existing = await probeExisting(config.port);
  if (existing) {
    console.log(`STEWARD ${existing.version} is already running → http://localhost:${config.port}`);
    openBrowser(`http://localhost:${config.port}`);
    process.exit(0);
  }
}

const server = listen((port) => Bun.serve({
  port,
  // An SSE response that has said nothing is an IDLE connection, and Bun closes those
  // after 10 seconds by default — so an op fired at a tab that has been quiet lands
  // nowhere until EventSource reconnects. 0007's browser pass lost an hour to this as a
  // phantom drag-and-drop regression; the move was always reaching the server.
  //
  // 255 is Bun's ceiling (256 throws), so this alone only moves the cliff to four
  // minutes. The heartbeat above is the other half: it keeps the connection non-idle,
  // and this raises the bar the heartbeat has to clear. A desktop app sits open and
  // quiet all day, so this is the normal case, not the edge one.
  idleTimeout: 255,
  routes: {
    // --- the door ---
    '/intent': {
      POST: async (req: Request) => {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
        const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const session = typeof o.session === 'string' && o.session ? o.session : 'anon';

        // STEWARD domain vocabulary — ops pushed over SSE. Every verb but `sheet.push`
        // and `digest.send` resolves synchronously; awaiting the others costs nothing.
        if (typeof o.action === 'string' && isStewardAction(o.action)) {
          const result = await dispatchSteward(services, {
            action: o.action,
            payload: o.payload && typeof o.payload === 'object' ? (o.payload as Record<string, unknown>) : {},
            actor: 'human', // stamped at the door
            session,
          }, {
            pushSheet: () => sheetsMirror.push(mirrorData()),
            // The same actor the door stamps on the intent — a send through this
            // door is somebody at the keyboard, not the clock.
            sendDigest: () => runDigest(localDate(new Date()), 'human'),
            moveArchivedFiles,
          });
          if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
          for (const op of result.ops) stream.push(session, OP_EVENT, op);
          // The reply travels back. Every verb has always composed a real sentence —
          // "Archived Smith, John. 1 ticket went with it." — and the browser threw it
          // away and printed "Saved." at the foot of a form the operator had already
          // stopped looking at. `dismiss` says the record has left the surface it was
          // being edited on, so the drawer should close rather than sit there stale.
          return Response.json({ reply: result.reply ?? '', dismiss: result.dismiss ?? false },
            { status: 202 });
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
        // The manifest is the reasoner's instruction manual: every entry claims "this
        // address is occupied and these verbs land on it". It advertised `reflection`
        // until 0009, and no page has rendered a reflection surface since 0008 — so the
        // AI was being told to write somewhere the write was thrown away, silently at
        // both ends. (It was doubly wrong: `demo.run` accepts `screen`, not `reflection`,
        // so the one verb the app implements was not invokable on the one target it
        // advertised.) Only surfaces that really exist belong here.
        const targets: ManifestTarget[] = [
          // Mounted on EVERY page by steward-chat.js — `data-surface="chat-log:steward"`,
          // `data-kind="chat-log"`. This is the one real GRAIN surface in the markup.
          { id: CHAT_SURFACE, kind: 'chat-log', accepts: actionsForKind('chat-log') },
          // The page itself: `screen` is ambient, not a DOM node. `demo.run` performs a
          // real audited write and `navigate` is handled globally by ai-dispatch.js, so
          // advertising it is a true statement about what this door accepts.
          { id: SCREEN_SURFACE, kind: 'screen', accepts: actionsForKind('screen') },
        ];
        return Response.json(buildManifest(screen, targets, { itemCount: 0 }));
      },
    },

    // --- updates ---
    // Two doors, deliberately: checking is a read and happens on its own at boot; applying
    // writes an executable and restarts the process, and only ever happens on a click.
    '/update/check': {
      GET: async () => Response.json(await checkForUpdate()),
    },
    '/update/apply': {
      POST: async () => {
        const found = await checkForUpdate();
        if (found.state !== 'available') return Response.json({ error: 'Nothing to install.' }, { status: 400 });
        try {
          await applyUpdate(found.release);
        } catch (e) {
          return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
        }
        // Restart INTO the new binary. Detached and with its own stdio, so it outlives
        // this process rather than dying with it, and re-exec'd from the same path the
        // rename just wrote — the operator's shortcut still points there.
        Bun.spawn([process.execPath], { stdio: ['ignore', 'ignore', 'ignore'], detached: true }).unref();
        setTimeout(() => process.exit(0), 250).unref();
        return Response.json({ ok: true, version: found.version });
      },
    },

    // --- Sheets mirror ---
    // POST and only POST: this copies names, emails and phone numbers into a file that
    // is one button away from being shared with anyone. Same reasoning as /update/apply —
    // consent belongs at the moment of the outward-facing act, so it is never automatic.
    '/sheets/push': {
      POST: async () => {
        const out = await sheetsMirror.push(mirrorData());
        return Response.json(out, { status: out.ok ? 200 : 400 });
      },
    },

    // --- the daily digest (0013) ---
    '/digest/settings': {
      POST: async (req: Request) => {
        const form = await req.formData();
        const value = (k: string) => String(form.get(k) ?? '').trim();

        const time = parseTime(value('time'));
        if (!time) return backTo('/settings?digest=bad-time');

        // Validated HERE as well as by the browser, because `type="email"` is the thing
        // that rejects an address that looks perfect on screen: a pasted trailing space
        // is invisible, and the From box is SEEDED FROM Username, which is not required
        // to be an address at all. A native bubble saying "enter a valid email" over a
        // field that plainly holds one is the least explicable error the app can give.
        const to = value('to'), from = value('from');
        const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        if (to && !looksLikeEmail(to)) return backTo('/settings?digest=bad-to');
        if (from && !looksLikeEmail(from)) return backTo('/settings?digest=bad-from');
        repos.settings.set(DIGEST_KEYS.time, time);
        repos.settings.set(DIGEST_KEYS.enabled, form.get('enabled') ? '1' : '0');
        repos.settings.set(DIGEST_KEYS.to, to);
        repos.settings.set(DIGEST_KEYS.host, value('host'));
        repos.settings.set(DIGEST_KEYS.port, String(Number(value('port')) || SMTP_PORT));
        repos.settings.set(DIGEST_KEYS.user, value('user'));
        repos.settings.set(DIGEST_KEYS.from, from);

        // A password field submitted EMPTY means "leave it alone", not "erase it" —
        // the card never renders the stored value back, so an empty box is the
        // normal state of an unchanged form, and treating it as a deletion would
        // wipe the secret every time somebody changed the send time.
        const password = normalisePassword(String(form.get('password') ?? ''));
        if (password) repos.settings.set(DIGEST_KEYS.password, password);
        if (form.get('forgetPassword')) repos.settings.remove(DIGEST_KEYS.password);

        return backTo('/settings?digest=saved');
      },
    },
    '/digest/send': {
      POST: async () => {
        const out = await runDigest(localDate(new Date()), 'human');
        return Response.json(out, { status: out.ok ? 200 : 400 });
      },
    },
    // The report a client's PDF would be, without sending anything. The one way to
    // look at the digest layout while the mailbox is still somebody else's problem.
    '/digest/preview/:id': {
      GET: async (req: Request) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const client = services.repos.clients.get(id);
        if (!client) return new Response('Not found', { status: 404 });
        const today = localDate(new Date());
        const { digests, ticketTotal } = buildWorkspace(repos, today);
        const d = digests.find((x) => x.client.id === id)
          ?? digestFor(client, [], today); // nothing pending: render the empty case
        const html = renderDigestDocument(d, today, ticketTotal);
        if (new URL(req.url).searchParams.get('html') !== null) {
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        try {
          const bytes = await printToPdf(html, documentPrintOptions(client));
          return new Response(bytes as unknown as BodyInit, {
            headers: { 'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="digest-${today}.pdf"` },
          });
        } catch (e) {
          console.error('[/digest/preview]', e);
          return new Response('PDF generation failed', { status: 502 });
        }
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
      GET: (req: Request) => {
        const scope = archivedScope(req);
        const clients = services.repos.clients.list(scope);
        const rows = clients.map(clientRow).join('')
          || `<tr class="data-table__empty"><td colspan="3">${scope === 'archived' ? 'Nothing archived.' : 'No clients yet.'}</td></tr>`;
        return layout(scope === 'archived' ? 'Archived clients' : 'Clients',
          `<div class="page-head"><h1>${scope === 'archived' ? 'Archived clients' : 'Clients'}</h1>` +
          `<span class="sub">${clients.length} records</span></div>` +
          archivedLink('/clients', scope, services.repos.clients.list('archived').length) +
          `<div class="panel"><table class="data-table dtable">` +
          `<thead><tr><th>Name</th><th>Code</th><th>Company info</th></tr></thead>` +
          `<tbody class="rows" data-surface="client-list">${rows}</tbody></table></div>`,
          { path: '/clients',
            filter: { target: '[data-surface="client-list"]', placeholder: 'Filter clients…' },
            drawer: { title: 'New client', body: renderForm(clientSchema(), 'create') } });
      },
    },
    '/clients/:id': {
      GET: (req: Request) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.clients.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        // A rejected logo redirects back here with its reason. Multipart posts have
        // no live channel to answer on — the page IS the answer.
        const said = new URL(req.url).searchParams.get('logo') ?? '';
        const notice = said
          ? `<p class="form-status" data-ok="${said === 'set' || said === 'removed'}">${esc(LOGO_NOTICE[said] ?? said)}</p>`
          : '';
        return layout(c.name,
          `<a class="back-link" href="/clients">← Clients</a>` +
          `<div class="page-head"><h1>${esc(c.name)}</h1></div>` +
          `<div class="panel"><div class="panel__body">${clientPanel(c, false, notice)}</div></div>`,
          { path: '/clients', crumbs: `<a href="/clients">Clients</a> / <strong>${esc(c.name)}</strong>` });
      },
    },
    '/clients/:id/logo': {
      POST: async (req: Request) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const c = services.repos.clients.get(id);
        if (!c) return new Response('Not found', { status: 404 });
        const back = (why: string) => backTo(`/clients/${id}?logo=${why}`);

        const form = await req.formData();
        const brandingWith = (logoDataUrl: string | null) => ({ ...c.branding, logoDataUrl });

        if (form.get('remove')) {
          services.updateClient(id, { branding: brandingWith(null) }, 'human', { logo: null });
          return back('removed');
        }
        const file = form.get('logo');
        if (!(file instanceof File) || !file.size) return back('none');

        // Validated by what the bytes ARE, server-side. The browser's declared type
        // is only ever a restatement of the file extension.
        const result = validateLogo(new Uint8Array(await file.arrayBuffer()));
        if (!result.ok) return backTo(`/clients/${id}?logo=${encodeURIComponent(result.error)}`);

        // Audited like any other change — but the row records that a logo was set,
        // not half a megabyte of base64 (see services.updateClient).
        services.updateClient(id, { branding: brandingWith(result.dataUrl) }, 'human',
          { logo: result.mimeType, bytes: result.bytes });
        return back('set');
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
      GET: (req: Request) => {
        const scope = archivedScope(req);
        const clients = services.repos.clients.list();
        const customers = services.repos.customers.list(undefined, scope);
        const rows = customers.map(customerRow).join('')
          || `<tr class="data-table__empty"><td colspan="3">${scope === 'archived' ? 'Nothing archived.' : 'No customers yet.'}</td></tr>`;
        const note = clients.length ? '' : `<p class="muted">Create a client first.</p>`;
        return layout(scope === 'archived' ? 'Archived customers' : 'Customers',
          `<div class="page-head"><h1>${scope === 'archived' ? 'Archived customers' : 'Customers'}</h1>` +
          `<span class="sub">${customers.length} records</span></div>` +
          archivedLink('/customers', scope, services.repos.customers.list(undefined, 'archived').length) +
          `<div class="panel"><table class="data-table dtable">` +
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
            filter: { target: '.kanban', placeholder: 'Filter tickets…' },
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
          const bytes = await printToPdf(ticketDocument(t, customer, client), documentPrintOptions(client));
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
    '/tickets/:id/pdf/save': {
      POST: async (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const t = services.repos.tickets.get(id);
        if (!t) return new Response('Not found', { status: 404 });
        const customer = services.repos.customers.get(t.customerId);
        const client = customer ? services.repos.clients.get(customer.clientId) : null;
        try {
          const bytes = await printToPdf(ticketDocument(t, customer, client), documentPrintOptions(client));
          await services.attachDocument(
            { entity: 'ticket', entityId: t.id },
            { name: `${t.ticketId}.pdf`, mimeType: 'application/pdf', bytes },
            'generated', 'human',
          );
        } catch (e) {
          console.error('[/tickets/:id/pdf/save]', e);
          return new Response('PDF generation failed', { status: 502 });
        }
        return backTo(`/tickets/${t.id}`);
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

    // --- Google connection (OAuth: user consent, PKCE, loopback) ---
    '/oauth/google/start': {
      GET: async () => {
        if (!config.google.clientId) {
          return new Response('No Google client id configured — set GOOGLE_CLIENT_ID.', { status: 400 });
        }
        // The verifier and state live server-side for one exchange only; the
        // verifier never travels, which is the point of PKCE.
        const verifier = makeVerifier();
        const state = makeVerifier().slice(0, 32);
        pendingLogin = { verifier, state, at: Date.now() };
        return Response.redirect(
          authUrl({
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            redirectUri: `http://127.0.0.1:${listeningPort}${config.google.redirectPath}`,
          }, await challengeFor(verifier), state),
          302,
        );
      },
    },
    '/oauth/google/callback': {
      GET: async (req: Request) => {
        const url = new URL(req.url);
        const error = url.searchParams.get('error');
        if (error) return backTo(`/settings?google=${encodeURIComponent(error)}`);

        const code = url.searchParams.get('code') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const pending = pendingLogin;
        pendingLogin = null; // single use, whatever happens next

        // Reject a callback we didn't initiate, or one that arrived too late.
        if (!pending || !code || state !== pending.state || Date.now() - pending.at > 10 * 60_000) {
          return backTo('/settings?google=invalid_state');
        }
        try {
          await googleAuth.completeLogin(code, pending.verifier);
        } catch (e) {
          console.error('[oauth/google]', e);
          return backTo('/settings?google=exchange_failed');
        }
        return backTo('/settings?google=connected');
      },
    },
    '/oauth/google/disconnect': {
      POST: () => { googleAuth.disconnect(); return backTo('/settings?google=disconnected'); },
    },

    // --- Files (documents: the manager, previews, bytes) ---
    '/files': {
      GET: () => {
        const docs = services.listDocuments();
        const rows = docs.map((d) =>
          `<tr class="row" data-surface="document:${esc(d.id)}" data-href="/files/${esc(d.id)}">` +
          `<td><a href="/files/${esc(d.id)}">${esc(d.name)}</a></td>` +
          `<td>${recordRef(d.entity, d.entityId)}</td>` +
          `<td><span class="badge" data-source="${esc(d.source)}">${esc(d.source)}</span></td>` +
          `<td class="sub">${esc(d.mimeType || '—')}</td>` +
          `<td class="mono">${esc(fileSize(d.size))}</td>` +
          `<td class="mono">${esc(auditTime(d.createdAt))}</td></tr>`).join('')
          || `<tr class="data-table__empty"><td colspan="6">No documents yet. Attach one from any record.</td></tr>`;
        return layout('Files',
          `<div class="page-head"><h1>Files</h1><span class="sub">${docs.length} document${docs.length === 1 ? '' : 's'}</span></div>` +
          `<div class="panel"><table class="data-table dtable">` +
          `<thead><tr><th>Name</th><th>Belongs to</th><th>Source</th><th>Type</th><th>Size</th><th>Added</th></tr></thead>` +
          `<tbody class="rows" data-surface="document-list">${rows}</tbody></table></div>`,
          { path: '/files', filter: { target: '[data-surface="document-list"]', placeholder: 'Filter files…' } });
      },
    },
    '/files/upload': {
      POST: async (req: Request) => {
        // Bytes, so this is a multipart form rather than a JSON intent.
        const form = await req.formData();
        const file = form.get('file');
        const entity = String(form.get('entity') ?? '') as AuditEntity;
        const entityId = String(form.get('entityId') ?? '');
        if (!(file instanceof File) || !entity || !entityId) {
          return new Response('bad upload', { status: 400 });
        }
        await services.attachDocument(
          { entity, entityId },
          { name: file.name, mimeType: file.type || mimeFor(file.name), bytes: new Uint8Array(await file.arrayBuffer()) },
          'upload', 'human',
        );
        return backTo(recordHref(entity, entityId));
      },
    },
    // --- Linking an existing Drive file (Google Picker) ---
    // `drive.file` cannot see files STEWARD did not create, so the operator has
    // to hand each one over through Google's own Picker. The browser needs a
    // live access token to run it; that is inherent to the Picker, which talks
    // to Google directly. What leaves the server here is the SHORT-LIVED access
    // token only — never the refresh token, which is the real credential.
    '/files/picker-config': {
      GET: async () => {
        const missing: string[] = [];
        if (!googleAuth.status().connected) missing.push('a connected Google account');
        if (!config.google.apiKey) missing.push('GOOGLE_API_KEY');
        if (!config.google.projectNumber) missing.push('GOOGLE_PROJECT_NUMBER');
        if (missing.length) return Response.json({ ready: false, missing }, { status: 409 });

        const token = await googleAuth.accessToken();
        if (!token) return Response.json({ ready: false, missing: ['a working access token'] }, { status: 409 });
        return Response.json({
          ready: true,
          token,
          apiKey: config.google.apiKey,
          appId: config.google.projectNumber,
        }, { headers: { 'Cache-Control': 'no-store' } });
      },
    },
    '/files/link': {
      POST: async (req: Request) => {
        // JSON rather than a form post: the Picker is JavaScript, and what it
        // returns is a description of a file, not the file.
        const body = (await req.json().catch(() => null)) as {
          entity?: string; entityId?: string;
          files?: { name?: string; url?: string; mimeType?: string; size?: number }[];
        } | null;
        const entity = String(body?.entity ?? '') as AuditEntity;
        const entityId = String(body?.entityId ?? '');
        const files = Array.isArray(body?.files) ? body.files : [];
        if (!entity || !entityId || !files.length) {
          return Response.json({ error: 'bad link request' }, { status: 400 });
        }
        // A link with no URL is unopenable, so it is not worth recording.
        const linked = files
          .filter((f) => f.url)
          .map((f) => services.linkDocument(
            { entity, entityId },
            { name: f.name || 'Untitled', url: String(f.url), mimeType: f.mimeType, size: f.size },
            'human',
          ));
        return Response.json({ linked: linked.length });
      },
    },
    '/files/:id': {
      GET: async (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const d = services.getDocument(id);
        if (!d) return new Response('Not found', { status: 404 });
        return layout(d.name,
          `<a class="back-link" href="/files">← Files</a>` +
          `<div class="page-head"><h1>${esc(d.name)}</h1></div>` +
          `<div class="panel"><div class="panel__body">${await documentPanel(d)}</div></div>`,
          { path: '/files', crumbs: `<a href="/files">Files</a> / <strong>${esc(d.name)}</strong>` });
      },
    },
    '/files/:id/panel': {
      GET: async (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const d = services.getDocument(id);
        return d ? fragment(await documentPanel(d, true)) : new Response('Not found', { status: 404 });
      },
    },
    '/files/:id/raw': {
      GET: async (req: Request) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const d = services.getDocument(id);
        if (!d) return new Response('Not found', { status: 404 });
        if (d.source === 'link') return Response.redirect(d.webViewLink, 302);
        const bytes = await services.readDocument(d);
        if (!bytes) return new Response('File missing from store', { status: 410 });
        const download = new URL(req.url).searchParams.has('download');
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            'Content-Type': d.mimeType || 'application/octet-stream',
            'Content-Disposition':
              `${download ? 'attachment' : 'inline'}; filename="${d.name.replace(/["\\]/g, '')}"`,
          },
        });
      },
    },
    '/files/:id/delete': {
      POST: async (req) => {
        const id = (req as unknown as { params: { id: string } }).params.id;
        const d = services.getDocument(id);
        if (!d) return new Response('Not found', { status: 404 });
        await services.removeDocument(id, 'human');
        return backTo('/files');
      },
    },

    // --- Activity (the audit trail, whole-workspace) ---
    '/activity': {
      GET: () => {
        const entries = services.repos.audit.recent(200);
        const items = entries.map((e) => auditItem(e, recordRef(e.entity, e.entityId))).join('')
          || '<li class="muted">No activity recorded yet.</li>';
        return layout('Activity',
          `<div class="page-head"><h1>Activity</h1><span class="sub">${entries.length} most recent changes</span></div>` +
          `<div class="panel"><div class="panel__body"><ul class="audit">${items}</ul></div></div>`,
          { path: '/activity', filter: { target: '.audit', placeholder: 'Filter activity…' } });
      },
    },

    // --- Home + Settings (shell routes, replacing the static pages) ---
    '/': { GET: () => layout('Home', homePage(), { path: '/' }) },
    '/settings': {
      GET: async (req: Request) => {
        const notice = new URL(req.url).searchParams.get('google');
        await googleAuth.ensureAccount(); // names an older connection, once
        const g = googleAuth.status();
        // Say plainly what is true: not configured, configured but not
        // connected, or connected as someone.
        const state = !g.configured
          ? `<p class="muted">No OAuth client id configured. Create a Google Cloud project, enable the ` +
            `Drive API, and add an OAuth client of type <strong>Desktop app</strong>. Then set ` +
            `<code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> before starting STEWARD.</p>` +
            `<p class="muted">Desktop clients allow loopback redirects on any port, so there is nothing ` +
            `to register — this build listens on ` +
            `<code>http://127.0.0.1:${config.port}${config.google.redirectPath}</code>.</p>` +
            `<p class="muted">Publish the OAuth app to <strong>Production</strong>: while it is in Testing, ` +
            `Google expires refresh tokens after 7 days and you would have to reconnect weekly.</p>`
          : g.connected
            ? `<p>Connected${g.account ? ` as <strong>${esc(g.account)}</strong>` : ''}. ` +
              `New documents are stored in the <strong>${esc(config.google.folderName)}</strong> folder of that Drive.</p>` +
              // Linking an existing file is a separate capability with its own
              // prerequisites; say so here rather than at the moment of failure.
              (config.google.apiKey && config.google.projectNumber
                ? `<p class="muted">Existing Drive files can be linked to a record with ` +
                  `<strong>Link from Drive</strong> in any record's Documents section.</p>`
                : `<p class="muted">Linking <em>existing</em> Drive files needs the Google Picker: enable the ` +
                  `Picker API, create a browser <strong>API key</strong>, and set <code>GOOGLE_API_KEY</code> and ` +
                  `<code>GOOGLE_PROJECT_NUMBER</code> (the Cloud project number). Until then, uploads and ` +
                  `generated PDFs still file to Drive normally.</p>`) +
              `<form method="post" action="/oauth/google/disconnect"><div class="form-controls">` +
              `<button type="submit" class="btn">Disconnect</button></div></form>` +
              `<p class="muted">Disconnecting only forgets the connection here. Files already in Drive stay in Drive, ` +
              `and files already on this machine keep working.</p>`
            : `<p class="muted">Not connected. Documents are stored locally on this machine.</p>` +
              `<p><a class="btn" data-variant="soft" href="/oauth/google/start">Connect Google Drive</a></p>` +
              `<p class="muted">STEWARD asks only for <code>${esc(GOOGLE_SCOPE.split('/').pop() ?? '')}</code> access — ` +
              `the files it creates, not the rest of your Drive.</p>`;
        const noticeHtml = notice
          ? `<p class="form-status" data-ok="${notice === 'connected' || notice === 'disconnected'}">${esc(notice.replace(/_/g, ' '))}</p>`
          : '';
        return layout('Settings',
        `<div class="page-head"><h1>Settings</h1></div>` +
        `<section class="panel"><div class="panel__head"><h2>Google Drive</h2></div><div class="panel__body">` +
        noticeHtml + state + `</div></section>` +
        // --- Google Sheets: one true statement at a time ---
        // The mirror is one-way and destructive by design, so the card says that BEFORE
        // the button rather than after someone loses an afternoon's typing in it.
        (() => {
          const m = sheetsMirror.state();
          const body = !m.configured || !m.connected
            ? `<p class="muted">A mirror needs a connected Google account — connect one above. ` +
              `It uses the same permission Drive already has, so there is nothing further to approve.</p>`
            : `<p>A read-only spreadsheet of every client, customer, ticket and progress entry, ` +
              `in the same <strong>${esc(config.google.folderName)}</strong> folder. For reading, filtering ` +
              `and sharing — STEWARD never reads it back.</p>` +
              `<p class="muted">Every push rewrites the whole file. <strong>Edits made in the spreadsheet are lost.</strong></p>` +
              (m.url
                ? `<p><a href="${esc(m.url)}" target="_blank" rel="noopener">Open the mirror ↗</a>` +
                  ` <span class="muted" id="sheet-pushed">${m.pushedAt ? `— last pushed ${esc(m.pushedAt)}` : ''}</span></p>`
                : '') +
              `<div class="form-controls"><button type="button" class="btn" id="sheet-push">` +
              `${m.url ? 'Push now' : 'Create the mirror'}</button></div>` +
              `<p class="form-status" id="sheet-status" hidden></p>` +
              `<script type="module">
                const status = document.getElementById('sheet-status');
                const button = document.getElementById('sheet-push');
                const stamp = document.getElementById('sheet-pushed');
                const say = (text, ok) => { status.hidden = false; status.textContent = text; status.dataset.ok = String(!!ok); };
                button.addEventListener('click', async () => {
                  button.disabled = true;
                  say('Pushing…');
                  const r = await fetch('/sheets/push', { method: 'POST' })
                    .then((x) => x.json()).catch(() => ({ ok: false, reason: 'The push failed to reach Google.' }));
                  button.disabled = false;
                  if (!r.ok) { say(r.reason + (r.enableUrl ? ' → ' + r.enableUrl : '')); return; }
                  const counts = Object.entries(r.counts).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ');
                  say('Pushed ' + counts + '.' + (r.recreated ? ' The previous mirror was gone, so a new one was created.' : '') + (r.note ? ' ' + r.note : ''), true);
                  // Update in place rather than reloading: a reload throws away the very
                  // message the operator clicked to see. The one case that needs the
                  // server's markup back is the FIRST push, which adds the link.
                  if (stamp) stamp.textContent = '— last pushed ' + r.pushedAt;
                  else location.reload();
                });
              </script>`;
          return `<section class="panel"><div class="panel__head"><h2>Google Sheets</h2></div>` +
            `<div class="panel__body">${body}</div></section>`;
        })() +
        // --- The daily digest: a card that states what is TRUE ---
        // Every line here is a fact about this machine's configuration, not a promise.
        // The secret is held, never rendered back: the card says whether a password
        // exists, and that is all it is ever allowed to say about it.
        (() => {
          const d = readDigestSettings(repos.settings);
          const said = new URL(req.url).searchParams.get('digest');
          const notes: Record<string, string> = {
            saved: 'Saved.',
            'bad-time': 'That is not a time of day. Use HH:MM, like 08:00.',
            'bad-to': 'The To address is not an email address. Check for a stray space — a pasted one is invisible.',
            'bad-from': 'The From address is not an email address. Leave it blank to use the username, unless the username is not an address either.',
          };
          const noticed = said
            ? `<p class="form-status" data-ok="${said === 'saved'}">${esc(notes[said] ?? said)}</p>`
            : '';

          const today = localDate(new Date());
          const { digests } = buildWorkspace(repos, today);
          const pending = digests.reduce((sum, x) => sum + x.total, 0);
          const preview = digests.length
            ? `<p class="muted">Right now that would be ${pending} pending ` +
              `${pending === 1 ? 'ticket' : 'tickets'} across ${digests.length} ` +
              `${digests.length === 1 ? 'client' : 'clients'}: ` +
              digests.map((x) =>
                `<a href="/digest/preview/${esc(x.client.id)}" target="_blank" rel="noopener">` +
                `${esc(x.client.name)} (${x.total}) ↗</a>`).join(', ') + `.</p>`
            : `<p class="muted">Nothing is pending right now, so today's digest would be one ` +
              `sentence and no attachments. It still sends — a silent morning is ` +
              `indistinguishable from a scheduler that died in the night.</p>`;

          // What is missing, named. "It does not work" is not a diagnosis.
          const gaps = [
            d.host ? '' : 'an SMTP host',
            d.user ? '' : 'a username',
            d.hasPassword ? '' : 'a password',
            d.to ? '' : 'a recipient',
          ].filter(Boolean);
          const ready = gaps.length
            ? `<p class="muted">Not sendable yet — still needs ${gaps.join(', ')}.</p>`
            : d.enabled
              ? `<p>Scheduled for <strong>${esc(d.time)}</strong> every day, to ` +
                `<strong>${esc(d.to)}</strong>, while STEWARD is open.</p>`
              : `<p class="muted">Configured, but the schedule is off. It can still be sent by hand.</p>`;

          const row = (name: string, label: string, control: string, help = '') =>
            rowHtml(name, label, control, esc(help));
          // Same row, but the hint is trusted markup. Used by the password field alone,
          // whose diagnosis carries a link and an emphasis — and whose only interpolated
          // value is a number. Nothing the operator typed reaches it.
          const rowHtml = (name: string, label: string, control: string, help = '') =>
            `<div class="form-row"><label for="f_d_${esc(name)}">${esc(label)}</label>` +
            control + (help ? `<span class="sub">${help}</span>` : '') + `</div>`;
          const input = (name: string, type: string, value: string, extra = '') =>
            `<input id="f_d_${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}>`;

          return `<section class="panel"><div class="panel__head"><h2>Daily digest</h2></div>` +
            `<div class="panel__body">` + noticed +
            `<p>One email each morning listing every ticket that is not <strong>Completed</strong>, ` +
            `carrying a branded PDF per client and links to the Drive files filed against each ticket.</p>` +
            ready + preview +
            (d.lastSentOn ? `<p class="muted">Last sent on <span class="mono">${esc(d.lastSentOn)}</span>.</p>` : '') +
            (d.lastResult ? `<p class="muted">Last result: ${esc(d.lastResult)}</p>` : '') +
            // `fb` for the layout only. A form carrying a real `action` is left to the
            // browser by steward-live.js, so this posts to the URL rather than the door.
            `<form class="fb" method="post" action="/digest/settings">` +
            `<div class="form-row"><label for="f_d_enabled">Send daily</label>` +
            `<input id="f_d_enabled" name="enabled" type="checkbox" value="1"${d.enabled ? ' checked' : ''}></div>` +
            row('time', 'Time', input('time', 'time', d.time),
              'Local to this machine. A day missed while the app was closed stays missed.') +
            // `text`, not `email`: the browser's own bubble fires before the form is sent
            // and says "enter a valid email address" over a field holding what looks like
            // one — a pasted trailing space, or a From seeded from a non-address username.
            // The server validates and NAMES the problem instead. inputmode keeps the
            // phone keyboard; spellcheck off because an address is not prose.
            row('to', 'To', input('to', 'text', d.to, 'inputmode="email" autocomplete="email" spellcheck="false"')) +
            row('host', 'SMTP host', input('host', 'text', d.host, 'placeholder="smtp.gmail.com"')) +
            row('port', 'Port', input('port', 'number', String(d.port)),
              'Implicit TLS only. 587 with STARTTLS is not supported.') +
            row('user', 'Username', input('user', 'text', d.user)) +
            // The one control in STEWARD that must never be seeded from storage.
            rowHtml('password', 'Password', `<input id="f_d_password" name="password" type="password" value="" ` +
              `autocomplete="new-password" placeholder="${d.hasPassword ? '•'.repeat(Math.min(d.passwordLength, 32)) : 'app password'}">`,
              // The shape, never the secret. A 535 from Gmail is almost always an account
              // password rather than an app password, and without this the card cannot
              // tell the operator apart from someone who simply typed it wrong.
              d.hasPassword
                ? `A password is stored — ${d.passwordLength} characters. Leave this blank to ` +
                  `keep it. It is never shown again, never audited and never put in a URL.` +
                  (d.host.includes('gmail') && !d.passwordLooksLikeAppPassword
                    ? ` <strong>It does not look like a Gmail app password</strong>, which is ` +
                      `16 letters. Gmail refuses account passwords over SMTP with ` +
                      `<span class="mono">535 5.7.8</span>. Make one at ` +
                      `<a href="https://myaccount.google.com/apppasswords" target="_blank" ` +
                      `rel="noopener">myaccount.google.com/apppasswords</a> — 2-Step Verification ` +
                      `must be on first. Paste it with or without the spaces; they are stripped.`
                    : '')
                : 'For Gmail this is an app password, not the account password. ' +
                  'Spaces are stripped, so paste it exactly as Google shows it.') +
            row('from', 'From', input('from', 'text', d.from, 'inputmode="email" spellcheck="false"'),
              'Blank means the username above.') +
            `<div class="form-controls"><button type="submit" class="btn" data-variant="soft">Save</button>` +
            (d.hasPassword
              ? `<button type="submit" class="btn" name="forgetPassword" value="1">Forget password</button>`
              : '') +
            `</div></form>` +
            `<div class="form-controls"><button type="button" class="btn" id="digest-send"` +
            `${gaps.length ? ' disabled' : ''}>Send now</button></div>` +
            `<p class="form-status" id="digest-status" hidden></p>` +
            `<script type="module">
              const status = document.getElementById('digest-status');
              const button = document.getElementById('digest-send');
              const say = (text, ok) => { status.hidden = false; status.textContent = text; status.dataset.ok = String(!!ok); };
              button.addEventListener('click', async () => {
                button.disabled = true;
                say('Sending…');
                const r = await fetch('/digest/send', { method: 'POST' })
                  .then((x) => x.json()).catch(() => ({ ok: false, error: 'The send never reached the server.' }));
                button.disabled = false;
                if (!r.ok) { say(r.error || 'The send failed.'); return; }
                say('Sent — ' + r.tickets + ' pending, ' + r.attachments + ' report(s) attached.', true);
              });
            </script>` +
            `</div></section>`;
        })() +
        `<section class="panel"><div class="panel__head"><h2>Appearance</h2></div><div class="panel__body">` +
        `<p class="muted">Theme is a GRAIN token re-skin, saved to this browser.</p>` +
        // Each row is a named GROUP of toggles, not a <label> wrapping nothing.
        // Which one is on is a browser-side fact (GRAIN stores it on <html>), so
        // `aria-pressed` is set by steward-live.js, not rendered here.
        `<div class="form-row" role="group" aria-labelledby="set-mode-label">` +
        `<span class="form-label" id="set-mode-label">Mode</span><div class="form-controls">` +
        `<button type="button" class="btn" data-set-scheme="light">Light</button>` +
        `<button type="button" class="btn" data-set-scheme="dark">Dark</button>` +
        `<button type="button" class="btn" data-set-scheme="auto">Auto (OS)</button></div></div>` +
        `<div class="form-row" role="group" aria-labelledby="set-flavor-label" style="margin-top:1rem">` +
        `<span class="form-label" id="set-flavor-label">Flavor <span class="mono" data-theme-name></span></span>` +
        `<div class="form-controls">` +
        `<button type="button" class="btn" data-set-theme="sourdough">Sourdough</button>` +
        `<button type="button" class="btn" data-set-theme="baguette">Baguette</button>` +
        `<button type="button" class="btn" data-set-theme="brioche">Brioche</button></div></div>` +
        `</div></section>` +
        `<section class="panel"><div class="panel__head"><h2>Version</h2></div><div class="panel__body">` +
        `<p class="muted">STEWARD <span class="mono">${esc(config.version)}</span>` +
        (config.packaged ? '' : ' — running from a checkout, so updates come from git.') + `</p>` +
        `<p class="muted">Data is in <span class="mono">${esc(dataDir())}</span>.</p>` +
        // Where a launch that produced no visible window can still be read about.
        (config.packaged
          ? `<p class="muted">This run is logged to <span class="mono">${esc(logFile())}</span>.</p>`
          : '') +
        (config.packaged
          ? `<div class="form-controls"><button type="button" class="btn" id="update-check">Check for updates</button>` +
            `<button type="button" class="btn" data-variant="soft" id="update-apply" hidden>Download and restart</button></div>` +
            `<p class="form-status" id="update-status" hidden></p>` +
            // Applying is a click and only a click: this writes an executable on the
            // operator's machine and restarts the app. Checking on its own is a read.
            `<script type="module">
              const status = document.getElementById('update-status');
              const apply = document.getElementById('update-apply');
              const say = (text, ok) => { status.hidden = false; status.textContent = text; status.dataset.ok = String(!!ok); };
              document.getElementById('update-check').addEventListener('click', async () => {
                say('Checking…');
                const r = await fetch('/update/check').then((x) => x.json()).catch(() => ({ state: 'error', reason: 'No network.' }));
                if (r.state === 'available') { say('Version ' + r.version + ' is available.', true); apply.hidden = false; }
                else if (r.state === 'current') say('Up to date.', true);
                else say(r.reason ?? 'Could not check.');
              });
              apply.addEventListener('click', async () => {
                apply.disabled = true;
                say('Downloading and verifying…');
                const r = await fetch('/update/apply', { method: 'POST' }).then((x) => x.json()).catch(() => ({ error: 'The download failed.' }));
                if (r.error) { say(r.error); apply.disabled = false; return; }
                say('Installed ' + r.version + '. STEWARD is restarting — reload in a moment.', true);
              });
            </script>`
          : '') +
        `</div></section>` +
        `<section class="panel"><div class="panel__head"><h2>Demo mode</h2></div><div class="panel__body">` +
        `<p class="muted">Load fictional data into a separate demo database. Real data is untouched.</p>` +
        `<div class="form-controls"><button type="button" class="btn" id="reset">Reset demo data</button>` +
        `<button type="button" class="btn" id="status">Show counts</button></div>` +
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
        { path: '/settings' });
      },
    },

    // --- packaged assets ---
    '/components.css': async () =>
      new Response(await componentsCss(), { headers: { 'Content-Type': 'text/css' } }),

    // --- what this build calls itself ---
    // Also the marker a second launch probes before deciding whether the port is held by
    // another STEWARD or by something else entirely (see app/launch.ts).
    '/healthz': () => Response.json({ name: 'steward', version: config.version, packaged: config.packaged }),
  },

  async fetch(req: Request) {
    const p = new URL(req.url).pathname;
    // /styles, /scripts, /assets, /app, /fonts, and PROOF's and CRUMB's four named files.
    if (isAsset(p)) return serveAsset(p);
    const fromProof = await proofRoutes(p); if (fromProof) return fromProof;
    const fromCrumb = await crumbRoutes(p); if (fromCrumb) return fromCrumb;
    const fromMill = await millRoutes(p); if (fromMill) return fromMill;
    return servePage(p);
  },

  error(err: Error) {
    console.error('[server]', err);
    return new Response(config.isDev ? String(err.stack) : 'Internal Server Error', { status: 500 });
  },
}), config.port);

// The OAuth redirect must point at the port we actually bound, not the one asked for.
listeningPort = server.port ?? config.port;

const url = `http://localhost:${server.port}`;
console.log(`STEWARD ${config.version} → ${url}`);
console.log(`  data: ${dataDir()}`);

// A double-click has no terminal to read the URL out of. `--no-open` is for a packaged
// run being driven by something other than a person (a smoke test, a service wrapper).
if (config.packaged && !process.argv.includes('--no-open')) openBrowser(url);

if (config.packaged) {
  // The previous binary, parked by an update. This is the first moment it is safe to
  // delete: the new one has demonstrably started, because it is the one running this line.
  const exeDir = dirname(process.execPath);
  void cleanupOldBinaries(exeDir, readdirSync(exeDir)).catch(() => {});
}

// The digest clock (0013). Started here rather than at the composition root so it can
// never fire during boot: the first tick is a minute after the server is answering.
// It reads its own configuration on every tick, so a schedule changed in Settings takes
// effect without a restart, and an unconfigured install simply never sends.
const stopDigest = digestScheduler.start();

// Release the headless-Chrome singleton (0004) on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { stopDigest(); void closeBrowser().finally(() => process.exit(0)); });
}
