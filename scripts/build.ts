// Cross-compiles the shipped binaries (0009). `bun run build` — or `bun run build:win`
// for the one target that is the point of the plan.
//
// The manifest is regenerated first, every time. A build against a stale
// `build/assets.gen.ts` produces a binary that is missing files, boots perfectly, and
// serves an unstyled page to whoever downloads it — so the one thing that must never be
// left to a developer's memory is the step that keeps it fresh.

import { readdirSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { assetName } from '../app/update.ts';

const VERSION = (await Bun.file(join(config.root, 'package.json')).json()).version as string;
const DIST = join(config.root, 'dist');

interface Target { bun: string; platform: NodeJS.Platform; arch: string }

const TARGETS: Target[] = [
  { bun: 'bun-windows-x64', platform: 'win32', arch: 'x64' },
  { bun: 'bun-darwin-arm64', platform: 'darwin', arch: 'arm64' },
  { bun: 'bun-linux-x64', platform: 'linux', arch: 'x64' },
];

/**
 * Build-time constants, substituted into `config.ts`.
 *
 * **No credential appears here, and none may be added.** Until 0017 this block baked the
 * Google client id, client secret, API key and project number in from CI secrets, on the
 * reasoning that a Desktop client secret is not truly secret and that an exe with no Drive
 * until somebody edits a file is not a shipped product.
 *
 * Open sourcing killed that argument. The repository and its releases are public, so
 * `strings` over a published binary handed anyone all four — measured on `v0.3.1`, not
 * feared — and the project has billing attached. The operator now pastes credentials into
 * Settings (`app/google/credentials.ts`) and hands them to their own users out of band.
 *
 * A second thing died with them, worth keeping dead: `v0.3.0` shipped with Google entirely
 * switched off because four Actions secrets had never been set, `--define` substituted four
 * empty strings, and CI stayed green through all of it. With no build-time secrets there is
 * no such failure to have.
 */
const defines: Record<string, string> = {
  'process.env.STEWARD_PACKAGED': '"true"',
  'process.env.STEWARD_VERSION': JSON.stringify(VERSION),
};

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.slice(0, 3).join(' ')}…`);
}

/**
 * Windows-only flags (0010).
 *
 * 0009 refused `--windows-hide-console` while the console was the only feedback a first
 * run had. It is not any more: packaged runs mirror everything into
 * `<dataDir>\steward.log`, including a crash out of top-level await, and Settings prints
 * the path. That is what makes hiding the window an interface decision rather than a way
 * to lose the evidence.
 *
 * Both flags need a WINDOWS HOST. Bun 1.3.14 refuses them when cross-compiling — "Using
 * --windows-icon is only available when compiling on Windows" — which is why the release
 * workflow builds this one target on a windows runner. A cross-compiled exe is still a
 * working exe; it just has the default icon and a console window, and the build says so
 * rather than quietly producing a different artifact than the release does.
 */
const windowsFlags = (target: Target): string[] => {
  if (target.platform !== 'win32') return [];
  if (process.platform !== 'win32') {
    console.log('  (no icon, console visible — those flags need a Windows host; CI builds this target there)');
    return [];
  }
  return [
    '--windows-hide-console',
    `--windows-icon=${join(config.root, 'assets', 'steward.ico')}`,
  ];
};

async function build(target: Target): Promise<string> {
  const out = join(DIST, assetName(target.platform, target.arch));
  await run([
    // `--sourcemap` (external) drops a `server.js.map` into dist/, which then rides along
    // into a release as an asset nobody asked for. Inline keeps readable stack traces
    // inside the binary and leaves dist/ holding exactly what gets published.
    'bun', 'build', '--compile', '--minify', '--sourcemap=inline',
    `--target=${target.bun}`,
    ...windowsFlags(target),
    ...Object.entries(defines).flatMap(([k, v]) => ['--define', `${k}=${v}`]),
    join(config.root, 'server.ts'),
    '--outfile', out,
  ]);
  return out;
}

const only = Bun.argv.slice(2).filter((a) => !a.startsWith('-'));
const chosen = only.length ? TARGETS.filter((t) => only.some((o) => t.bun.includes(o))) : TARGETS;
if (!chosen.length) throw new Error(`No target matches ${only.join(', ')}`);

console.log(`STEWARD ${VERSION} → ${chosen.map((t) => t.bun).join(', ')}`);

// Never build against a stale manifest.
await run(['bun', join(config.root, 'scripts', 'gen-assets.ts')]);

const built: string[] = [];
for (const t of chosen) built.push(await build(t));

// `--compile` writes a `server.js.map` beside the binary whatever `--sourcemap` is set to
// (`inline` included — checked, not assumed). It is a build artifact, not a release asset,
// and dist/ is what CI uploads, so it goes: an unexplained `server.js.map` attached to a
// release is a question every future reader has to answer again.
await unlink(join(DIST, 'server.js.map')).catch(() => {});

// A checksums file in `sha256sum` format, which is what `app/update.ts` verifies against
// before it will replace a running binary. A release without this one is refused by the
// updater, deliberately — so it is generated here rather than by hand at release time.
//
// Over everything in dist/, not just what this run built: the release workflow compiles
// the Windows target on a Windows runner (the icon and console flags need one) and drops
// it here before this runs, and a checksums file that silently omitted it would make the
// updater refuse the one binary most people download.
const sums = await Promise.all(
  readdirSync(DIST).filter((f) => f !== 'SHA256SUMS').sort().map(async (f) => {
    const bytes = new Uint8Array(await Bun.file(join(DIST, f)).arrayBuffer());
    return `${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${f}`;
  }),
);
await Bun.write(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`);

for (const f of readdirSync(DIST).sort()) {
  const size = statSync(join(DIST, f)).size;
  console.log(`  ${f.padEnd(28)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`\n${built.length} binaries + SHA256SUMS in dist/`);
