// Serving, from the embedded manifest rather than from disk (0009).
//
// This replaces `makeStatic`, `createStyleBundle` and the two `import.meta.resolve`
// helpers in the composition root. It is not a packaged-only path: a checkout runs these
// same functions over the same map, where each entry happens to be a real path on disk.
// A packaging layer that only executes on a release machine is a packaging layer that is
// broken on every release but the one somebody remembered to test.
//
// The traversal guard `makeStatic` needed is not lost here, it is retired: a map lookup
// has no root to escape. `/app/../../etc/passwd` is simply not a key.

import { ASSETS, CONTENT, BUNDLE } from '../../build/assets.gen.ts';

const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.html': 'text/html',
};

const contentType = (key: string): string =>
  TYPES[key.slice(key.lastIndexOf('.'))] ?? 'application/octet-stream';

/** True when this URL path is something the manifest can answer. */
export const isAsset = (path: string): boolean => path in ASSETS;

/**
 * Serve one embedded file, or 404. Never throws: an unknown key is a miss, not an error,
 * because this sits on the request path for every unmatched URL in the app.
 */
export function serveAsset(path: string): Response {
  const embedded = ASSETS[path];
  if (!embedded) return new Response('Not found', { status: 404 });
  return new Response(Bun.file(embedded), {
    headers: {
      'Content-Type': contentType(path),
      // Content changes only when the binary does, but the binary is replaced in place by
      // the updater — so no far-future immutable caching without a fingerprint in the URL.
      'Cache-Control': 'no-cache',
    },
  });
}

let bundleCache: string | null = null;

/**
 * `/components.css` — every component stylesheet concatenated, in the order recorded at
 * generation time.
 *
 * The order is NOT recomputed here. `createStyleBundle` derives it by sorting absolute
 * paths, which inside the binary are `/$bunfs/root/…` and sort differently; re-deriving
 * would load every rule in a different cascade, silently. The proof this is right is a
 * byte-for-byte `diff` of this route against the dev server's — see build/assets.test.ts.
 */
export async function componentsCss(): Promise<string> {
  if (bundleCache != null) return bundleCache;
  const parts = await Promise.all(BUNDLE.map((p) => Bun.file(p).text()));
  bundleCache = parts.join('\n');
  return bundleCache;
}

/**
 * MILL's `ContentSource`, backed by the manifest. MILL needs no change — it asks for a
 * slug list and a slug's Markdown, which is a two-method port, and this is another
 * implementation of it.
 *
 * Slug rules are copied from MILL's own `dirSource` deliberately: filename minus `.md`,
 * lowercased. Diverging would make `/help/getting-started` resolve in dev and 404 in the
 * binary, which is exactly the class of bug this whole task exists to prevent.
 */
export function embeddedSource(prefix: string): { list(): Promise<string[]>; read(slug: string): Promise<string | null> } {
  const files = new Map<string, string>();
  for (const [key, embedded] of Object.entries(CONTENT)) {
    if (!key.startsWith(`${prefix}/`)) continue;
    const file = key.slice(prefix.length + 1);
    files.set(file.slice(0, -'.md'.length).toLowerCase(), embedded);
  }
  return {
    list: async () => [...files.keys()].sort(),
    read: async (slug) => {
      const embedded = files.get(slug.toLowerCase());
      return embedded ? Bun.file(embedded).text() : null;
    },
  };
}
