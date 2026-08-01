// Replacing the running binary with a newer one from GitHub Releases (0009).
//
// This is the most dangerous code in STEWARD: it writes an executable and restarts the
// process. Three rules hold it together, and each exists because of what happens without
// it.
//
//   1. The bytes are CHECKSUMMED before anything is swapped. A binary that overwrites
//      itself with unverified bytes off the network is a remote-code-execution hole with
//      an update button on it.
//   2. The running binary is not touched until the new one is fully written and verified.
//      A half-finished swap leaves a machine with no working STEWARD and no way to get
//      one, which is worse than never updating.
//   3. Nothing downloads or swaps without a click. An application that silently replaces
//      its own executable is taking an irreversible action on someone else's machine
//      without asking; the boot-time check only ever REPORTS.
//
// The releases are public (the human's call, recorded in plans/0009-shell.md), so there is
// no token here and none in the artifact.

import { rename, unlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VERSION } from './paths.ts';

/**
 * The slice of `fetch` this module actually uses, so a test can hand it a two-line stub.
 * `typeof fetch` would drag in Bun's `preconnect` and force every fake to implement it.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const REPO = 'tjakoen/steward';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const SUMS_ASSET = 'SHA256SUMS';

/** The release asset this build would replace itself with. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return `steward-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * Compare two versions the way releases are actually tagged: `v0.3.0`, `0.3.0`, and
 * pre-release suffixes that sort BEFORE their release (`0.3.0-rc.1` < `0.3.0`).
 *
 * Returns >0 when `a` is newer. `dev` is not a version — a checkout must never decide it
 * is out of date and start downloading binaries over itself.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'dev' || b === 'dev') return 0;

  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  // Same numbers: no suffix beats a suffix, otherwise compare the suffixes as text.
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** One line of a `sha256sum` file: `<hex>  <name>`. Returns the digest for `name`. */
export function digestFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

export interface Available {
  version: string;
  notes: string;
  assetUrl: string;
  sumsUrl: string;
}

export type CheckResult =
  | { state: 'current'; version: string }
  | { state: 'available'; version: string; release: Available }
  | { state: 'unsupported'; reason: string }
  | { state: 'error'; reason: string };

interface GhAsset { name: string; browser_download_url: string }
interface GhRelease { tag_name?: string; body?: string; assets?: GhAsset[] }

/**
 * Ask GitHub what the latest release is. Never throws: no network is an ordinary state
 * for a desktop app, and it must not colour anything else in the UI red.
 */
export async function checkForUpdate(
  fetchImpl: FetchLike = fetch,
  current: string = VERSION,
  wanted: string = assetName(),
): Promise<CheckResult> {
  if (current === 'dev') {
    return { state: 'unsupported', reason: 'Running from a checkout — update with git, not with this.' };
  }
  try {
    const res = await fetchImpl(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `steward/${current}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { state: 'error', reason: `GitHub answered ${res.status}` };

    const rel = (await res.json()) as GhRelease;
    const version = (rel.tag_name ?? '').replace(/^v/, '');
    if (!version) return { state: 'error', reason: 'That release has no tag.' };
    if (compareVersions(version, current) <= 0) return { state: 'current', version: current };

    const asset = rel.assets?.find((a) => a.name === wanted);
    const sums = rel.assets?.find((a) => a.name === SUMS_ASSET);
    // A release with no build for this platform is not an error to shout about — it is a
    // release that has nothing to offer this machine.
    if (!asset) return { state: 'unsupported', reason: `${version} ships no ${wanted}.` };
    // …but a release with a binary and no checksums IS refused. Unverifiable bytes are
    // exactly what rule 1 exists to stop, and "the sums file is missing" is not a reason
    // to relax it.
    if (!sums) return { state: 'error', reason: `${version} publishes no ${SUMS_ASSET}; refusing to update.` };

    return {
      state: 'available',
      version,
      release: {
        version,
        notes: rel.body ?? '',
        assetUrl: asset.browser_download_url,
        sumsUrl: sums.browser_download_url,
      },
    };
  } catch (e) {
    return { state: 'error', reason: String((e as Error)?.message ?? e) };
  }
}

export const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/**
 * Download, verify, and swap in the new binary. Returns the path that will be running
 * after a restart, or throws with a reason the operator can act on.
 *
 * The swap is a RENAME, not an overwrite, because Windows will not let a running
 * executable be deleted — but it will let it be moved out of the way. The old file is
 * left behind on purpose and cleaned up by the next boot: deleting it here would mean
 * deleting the only copy that is known to work, at the exact moment the new one has not
 * yet proved it starts.
 */
export async function applyUpdate(
  release: Available,
  exePath: string = process.execPath,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const wanted = assetName();

  const [binRes, sumsRes] = await Promise.all([
    fetchImpl(release.assetUrl, { signal: AbortSignal.timeout(300_000) }),
    fetchImpl(release.sumsUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!binRes.ok) throw new Error(`Download failed (${binRes.status}).`);
  if (!sumsRes.ok) throw new Error(`Could not fetch ${SUMS_ASSET} (${sumsRes.status}).`);

  const expected = digestFor(await sumsRes.text(), wanted);
  if (!expected) throw new Error(`${SUMS_ASSET} lists no digest for ${wanted}.`);

  const bytes = new Uint8Array(await binRes.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch — expected ${expected}, got ${actual}. Nothing was changed.`);
  }

  // Write beside the target, so the rename is within one filesystem and is atomic.
  const dir = dirname(exePath);
  const staged = join(dir, `.steward-${release.version}.new`);
  await Bun.write(staged, bytes);
  await chmod(staged, 0o755);

  const parked = join(dir, `.steward-${release.version}.old`);
  await rename(exePath, parked);          // the running binary — allowed while running
  try {
    await rename(staged, exePath);
  } catch (e) {
    await rename(parked, exePath);        // put it back; a machine with no STEWARD is worse
    throw e;
  }
  return exePath;
}

/**
 * Remove binaries parked by a previous update. Runs at boot, when the new binary has
 * demonstrably started — the only moment at which throwing the old one away is safe.
 */
export async function cleanupOldBinaries(exeDir: string, names: string[]): Promise<void> {
  for (const n of names) {
    if (!/^\.steward-.*\.(old|new)$/.test(n)) continue;
    await unlink(join(exeDir, n)).catch(() => {});
  }
}
