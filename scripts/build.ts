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
 * The Google client id and secret are BAKED IN on purpose. `config.ts` argues it at
 * length: an installed-app client secret is not truly secret — Google says so — and PKCE
 * is what protects the exchange. The alternative is an exe that has no Drive until
 * somebody hand-edits a file, which is not a shipped product. Values come from the
 * environment (CI secrets), so they never enter the tree; an unset one yields a working
 * binary with Drive switched off rather than a broken one.
 */
const defines: Record<string, string> = {
  'process.env.STEWARD_PACKAGED': '"true"',
  'process.env.STEWARD_VERSION': JSON.stringify(VERSION),
  'process.env.BUILD_GOOGLE_CLIENT_ID': JSON.stringify(Bun.env.GOOGLE_CLIENT_ID ?? ''),
  'process.env.BUILD_GOOGLE_CLIENT_SECRET': JSON.stringify(Bun.env.GOOGLE_CLIENT_SECRET ?? ''),
  'process.env.BUILD_GOOGLE_API_KEY': JSON.stringify(Bun.env.GOOGLE_API_KEY ?? ''),
  'process.env.BUILD_GOOGLE_PROJECT_NUMBER': JSON.stringify(Bun.env.GOOGLE_PROJECT_NUMBER ?? ''),
};

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.slice(0, 3).join(' ')}…`);
}

async function build(target: Target): Promise<string> {
  const out = join(DIST, assetName(target.platform, target.arch));
  await run([
    // `--sourcemap` (external) drops a `server.js.map` into dist/, which then rides along
    // into a release as an asset nobody asked for. Inline keeps readable stack traces
    // inside the binary and leaves dist/ holding exactly what gets published.
    'bun', 'build', '--compile', '--minify', '--sourcemap=inline',
    `--target=${target.bun}`,
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
const sums = await Promise.all(
  built.map(async (p) => {
    const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
    return `${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${p.slice(DIST.length + 1)}`;
  }),
);
await Bun.write(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`);

for (const f of readdirSync(DIST).sort()) {
  const size = statSync(join(DIST, f)).size;
  console.log(`  ${f.padEnd(28)} ${(size / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`\n${built.length} binaries + SHA256SUMS in dist/`);
