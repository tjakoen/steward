import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyUpdate, assetName, checkForUpdate, cleanupOldBinaries, compareVersions, digestFor, sha256,
  type Available, type FetchLike,
} from './update.ts';

test('asset names match what scripts/build.ts emits', () => {
  // If these two drift, every update check reports "ships no binary for this platform"
  // and the updater is silently dead.
  expect(assetName('win32', 'x64')).toBe('steward-windows-x64.exe');
  expect(assetName('darwin', 'arm64')).toBe('steward-darwin-arm64');
  expect(assetName('linux', 'x64')).toBe('steward-linux-x64');
});

test('version comparison handles the way releases are actually tagged', () => {
  expect(compareVersions('0.3.0', '0.2.0')).toBeGreaterThan(0);
  expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
  expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);   // not a string compare
  expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
  // A pre-release is OLDER than the release it leads to.
  expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0);
  expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBeGreaterThan(0);
});

test('a checkout never considers itself out of date', () => {
  // The nightmare case: a `bun server.ts` in a git worktree deciding to download a binary
  // and rename source files over itself.
  expect(compareVersions('99.0.0', 'dev')).toBe(0);
  expect(compareVersions('dev', '0.1.0')).toBe(0);
});

test('checkForUpdate refuses to run from a checkout at all', async () => {
  const res = await checkForUpdate(async () => { throw new Error('must not be called'); }, 'dev');
  expect(res.state).toBe('unsupported');
});

const release = (assets: string[], tag = 'v0.3.0') => new Response(JSON.stringify({
  tag_name: tag,
  body: 'notes',
  assets: assets.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
}), { headers: { 'Content-Type': 'application/json' } });

test('a newer release with a binary and checksums is offered', async () => {
  const res = await checkForUpdate(
    async () => release(['steward-windows-x64.exe', 'SHA256SUMS']),
    '0.2.0',
    'steward-windows-x64.exe',
  );
  expect(res.state).toBe('available');
  if (res.state === 'available') {
    expect(res.version).toBe('0.3.0');
    expect(res.release.assetUrl).toContain('steward-windows-x64.exe');
  }
});

test('a release without a SHA256SUMS is refused, not downloaded anyway', async () => {
  // Rule 1. "The sums file is missing" is not a reason to relax the one check standing
  // between an update button and arbitrary code execution.
  const res = await checkForUpdate(
    async () => release(['steward-windows-x64.exe']),
    '0.2.0',
    'steward-windows-x64.exe',
  );
  expect(res.state).toBe('error');
  if (res.state === 'error') expect(res.reason).toContain('refusing');
});

test('a release with no build for this platform is not an error', async () => {
  const res = await checkForUpdate(
    async () => release(['steward-linux-x64', 'SHA256SUMS']),
    '0.2.0',
    'steward-windows-x64.exe',
  );
  expect(res.state).toBe('unsupported');
});

test('an older or equal release reports current', async () => {
  for (const tag of ['v0.2.0', 'v0.1.0']) {
    const res = await checkForUpdate(async () => release(['steward-linux-x64', 'SHA256SUMS'], tag), '0.2.0');
    expect(res.state).toBe('current');
  }
});

test('no network is a reported state, never a thrown one', async () => {
  const res = await checkForUpdate(async () => { throw new Error('getaddrinfo ENOTFOUND'); }, '0.2.0');
  expect(res.state).toBe('error');
});

test('digestFor reads sha256sum output, including the binary-mode asterisk', () => {
  const hex = 'a'.repeat(64);
  const sums = [`${hex}  steward-linux-x64`, `${'b'.repeat(64)} *steward-windows-x64.exe`].join('\n');
  expect(digestFor(sums, 'steward-linux-x64')).toBe(hex);
  expect(digestFor(sums, 'steward-windows-x64.exe')).toBe('b'.repeat(64));
  expect(digestFor(sums, 'steward-darwin-arm64')).toBeNull();
});

// ---- the swap ----------------------------------------------------------------------

const stage = () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-update-'));
  const exe = join(dir, 'steward');
  writeFileSync(exe, 'OLD BINARY');
  return { dir, exe };
};

const fetcher = (bin: Uint8Array, sums: string): FetchLike => async (url) =>
  url.endsWith('SHA256SUMS') ? new Response(sums) : new Response(bin.slice().buffer);

const AVAILABLE: Available = {
  version: '0.3.0',
  notes: '',
  assetUrl: 'https://example.test/steward',
  sumsUrl: 'https://example.test/SHA256SUMS',
};

test('a verified binary replaces the running one, and the old one is parked not deleted', async () => {
  const { dir, exe } = stage();
  const bytes = new TextEncoder().encode('NEW BINARY');
  const sums = `${sha256(bytes)}  ${assetName()}`;

  await applyUpdate(AVAILABLE, exe, fetcher(bytes, sums));

  expect(readFileSync(exe, 'utf8')).toBe('NEW BINARY');
  // Parked, because at this instant the new binary has not yet proved it starts. The next
  // boot deletes it — that is the moment it is safe to.
  const parked = readdirSync(dir).filter((f) => f.endsWith('.old'));
  expect(parked.length).toBe(1);
  expect(readFileSync(join(dir, parked[0]!), 'utf8')).toBe('OLD BINARY');
});

test('a checksum mismatch changes nothing at all', async () => {
  const { dir, exe } = stage();
  const bytes = new TextEncoder().encode('TAMPERED');
  const sums = `${'0'.repeat(64)}  ${assetName()}`;

  await expect(applyUpdate(AVAILABLE, exe, fetcher(bytes, sums))).rejects.toThrow(/Checksum mismatch/);

  // Rule 2: the working binary is untouched, and no half-written file is left lying about.
  expect(readFileSync(exe, 'utf8')).toBe('OLD BINARY');
  expect(readdirSync(dir)).toEqual(['steward']);
});

test('a sums file that never mentions this asset is a refusal', async () => {
  const { exe } = stage();
  const bytes = new TextEncoder().encode('NEW BINARY');
  await expect(
    applyUpdate(AVAILABLE, exe, fetcher(bytes, `${sha256(bytes)}  something-else`)),
  ).rejects.toThrow(/no digest/);
  expect(readFileSync(exe, 'utf8')).toBe('OLD BINARY');
});

test('cleanup removes parked binaries and touches nothing else', async () => {
  const { dir, exe } = stage();
  writeFileSync(join(dir, '.steward-0.2.0.old'), 'x');
  writeFileSync(join(dir, '.steward-0.2.0.new'), 'x');
  writeFileSync(join(dir, 'steward.db'), 'PRECIOUS');

  await cleanupOldBinaries(dir, readdirSync(dir));

  expect(existsSync(join(dir, '.steward-0.2.0.old'))).toBe(false);
  expect(existsSync(join(dir, '.steward-0.2.0.new'))).toBe(false);
  expect(readFileSync(join(dir, 'steward.db'), 'utf8')).toBe('PRECIOUS');
  expect(existsSync(exe)).toBe(true);
});
