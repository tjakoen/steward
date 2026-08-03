// Headless-Chrome PDF driver (0004). Speaks the Chrome DevTools Protocol over a
// single WebSocket — no puppeteer, keeping the BREAD stack lean. A browser is
// launched lazily on first use and kept for the process lifetime; each request
// runs in a throwaway target. `resolveChrome()` is exported so callers/tests can
// skip cleanly when no Chrome binary exists (CI-safe).

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Windows install locations, in the order worth trying (0009).
 *
 * Edge earns its place here by being on every Windows install and speaking the same
 * DevTools protocol — it is the difference between "PDFs work" and "PDFs work if the
 * operator happened to install Chrome". The env vars are absent off Windows, so these
 * entries collapse to nothing everywhere else.
 */
const WINDOWS_CANDIDATES = [
  [Bun.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
  [Bun.env.PROGRAMFILES, 'Google\\Chrome\\Application\\chrome.exe'],
  [Bun.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe'],
  [Bun.env.PROGRAMFILES, 'Microsoft\\Edge\\Application\\msedge.exe'],
  [Bun.env['PROGRAMFILES(X86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
].map(([base, rel]) => (base ? `${base}\\${rel}` : undefined));

const CANDIDATES = [
  Bun.env.CHROME_PATH,
  MAC_CHROME,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  ...WINDOWS_CANDIDATES,
];

/** First existing Chrome/Chromium binary, or null when none is installed. */
export function resolveChrome(): string | null {
  for (const p of CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

interface Cdp {
  send(method: string, params?: unknown, sessionId?: string): Promise<any>;
  once(event: string, sessionId: string): Promise<any>;
  close(): void;
}

interface Browser {
  proc: ReturnType<typeof Bun.spawn>;
  cdp: Cdp;
}

let browser: Promise<Browser> | null = null;

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const waiters: Array<{ event: string; sessionId: string; resolve: (v: any) => void }> = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message ?? 'error'}`));
      else p.resolve(msg.result);
      return;
    }
    // Event: fan out to any matching one-shot waiter.
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.event === msg.method && w.sessionId === (msg.sessionId ?? '')) {
        waiters.splice(i, 1);
        w.resolve(msg.params);
      }
    }
  });

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const frame: Record<string, unknown> = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(frame));
      });
    },
    once(event, sessionId) {
      return new Promise((resolve) => waiters.push({ event, sessionId, resolve }));
    },
    close() {
      ws.close();
    },
  };
}

async function launch(): Promise<Browser> {
  const bin = resolveChrome();
  if (!bin) throw new Error('No Chrome/Chromium binary found (set CHROME_PATH).');

  const proc = Bun.spawn(
    [
      bin,
      '--headless=new',
      '--remote-debugging-port=0',
      // A throwaway profile, so this NEVER touches the operator's own browser data — and,
      // on Windows specifically, so it is a real new process. Launching chrome.exe while
      // Chrome is already running hands the command line to the existing instance and
      // exits, which here means no "DevTools listening" line and a launch that times out
      // for no visible reason. A private profile forces a separate instance.
      `--user-data-dir=${join(tmpdir(), `steward-chrome-${process.pid}`)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );

  // Chrome prints "DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>"
  // to stderr once the debug endpoint is up. Scrape it, with a timeout.
  const wsUrl = await readWsEndpoint(proc.stderr as ReadableStream<Uint8Array>);
  const cdp = await connect(wsUrl);
  return { proc, cdp };
}

async function readWsEndpoint(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Bun.nanoseconds() + 15_000_000_000; // 15s
  try {
    while (Bun.nanoseconds() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) return m[0];
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error('Chrome did not expose a DevTools endpoint in time.');
}

/** CDP speaks inches. Everything else in this project speaks millimetres. */
export const mm = (v: number): number => v / 25.4;

/** A4, in the inches `Page.printToPDF` wants. */
const A4 = { width: mm(210), height: mm(297) };

/**
 * Margins and the header/footer that live inside them (0013).
 *
 * These two travel together and cannot be separated: Chrome lays the templates out in
 * the margin box that THIS CALL defines, so `preferCSSPageSize` (which hands page
 * geometry to the document's `@page`) and `footerTemplate` do not co-operate. Passing
 * any of this therefore switches the page size over to `paper`/`margins` as well.
 *
 * All values are millimetres.
 */
export interface PrintOptions {
  /** Page size. A4 unless something says otherwise. */
  paper?: { width: number; height: number };
  margins?: { top: number; right: number; bottom: number; left: number };
  /**
   * Fragments rendered into the top and bottom margin of EVERY page. Two traps:
   * they are laid out in a separate document with no access to the page's CSS
   * (so every style must be inline, and the default font size is unreadably
   * small unless set), and they are clipped to the margin — a footer needs a
   * bottom margin big enough to hold it or it silently does not appear.
   *
   * `pageNumber`/`totalPages`/`date`/`title`/`url` are Chrome's own classes:
   * an element carrying one has its text replaced.
   */
  headerTemplate?: string;
  footerTemplate?: string;
}

/** Nothing at all — NOT the same as omitting the template, which restores Chrome's default. */
const BLANK = '<span></span>';

/**
 * The CDP parameter object, split out and exported so the rules above can be tested
 * without a browser — the two traps are both "the wrong param object", and a test that
 * needs Chrome to catch them is a test CI skips.
 */
export function printParams(opts?: PrintOptions): Record<string, unknown> {
  // The no-options call must stay byte-for-byte what it was before 0013: it is
  // shared with scripts/make-icon.ts and with every caller that only wants @page honoured.
  if (!opts) return { printBackground: true, preferCSSPageSize: true };

  const paper = opts.paper ? { width: mm(opts.paper.width), height: mm(opts.paper.height) } : A4;
  const m = opts.margins ?? { top: 18, right: 16, bottom: 22, left: 16 };
  const params: Record<string, unknown> = {
    printBackground: true,
    preferCSSPageSize: false,
    paperWidth: paper.width,
    paperHeight: paper.height,
    marginTop: mm(m.top),
    marginRight: mm(m.right),
    marginBottom: mm(m.bottom),
    marginLeft: mm(m.left),
  };
  if (opts.headerTemplate !== undefined || opts.footerTemplate !== undefined) {
    params.displayHeaderFooter = true;
    // Omitting one while displaying the other is how you accidentally ship Chrome's
    // stock header — the document title and the date, on a branded document.
    params.headerTemplate = opts.headerTemplate ?? BLANK;
    params.footerTemplate = opts.footerTemplate ?? BLANK;
  }
  return params;
}

/**
 * Render an HTML document to PDF bytes via CDP `Page.printToPDF`.
 * Launches (and reuses) a headless browser; each call uses a fresh target.
 */
export async function printToPdf(html: string, opts?: PrintOptions): Promise<Uint8Array> {
  if (!browser) browser = launch().catch((e) => { browser = null; throw e; });
  const { cdp } = await browser;

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    const dataUrl = 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');
    await cdp.send('Page.navigate', { url: dataUrl }, sessionId);
    await loaded;
    const { data } = await cdp.send('Page.printToPDF', printParams(opts), sessionId);
    return new Uint8Array(Buffer.from(data, 'base64'));
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/**
 * Render an HTML document to PNG bytes at an exact pixel size.
 *
 * Same driver, same `cdp.send` — the application icon (scripts/make-icon.ts) needs a
 * rasteriser and this project already ships one, so it needs no new dependency.
 */
export async function screenshotPng(html: string, size: number): Promise<Uint8Array> {
  if (!browser) browser = launch().catch((e) => { browser = null; throw e; });
  const { cdp } = await browser;

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    // deviceScaleFactor 1 with an explicit width/height: the viewport IS the icon, so
    // there is nothing to crop and no rounding to argue with.
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: size, height: size, deviceScaleFactor: 1, mobile: false }, sessionId);
    // Without this the page composites onto opaque white, and an icon with rounded
    // corners ships four white triangles that only show up on somebody's dark taskbar.
    await cdp.send('Emulation.setDefaultBackgroundColorOverride',
      { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate',
      { url: 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64') }, sessionId);
    await loaded;
    const { data } = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    );
    return new Uint8Array(Buffer.from(data, 'base64'));
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/** Shut the browser down (registered on server signals). Safe to call twice. */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (!b) return;
  try {
    const { proc, cdp } = await b;
    cdp.close();
    proc.kill();
  } catch {
    // already gone
  }
}
