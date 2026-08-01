import { test, expect } from 'bun:test';
import { browserCommand, isPortInUse, isSteward, listen, probeExisting } from './launch.ts';

test('the Windows browser command carries the empty title argument', () => {
  // `start` reads a quoted first argument as the WINDOW TITLE. Drop the `''` and
  // `start "http://…"` opens a console window titled with the URL and no browser at all.
  // It looks like a typo, which is exactly why it needs a test naming it.
  expect(browserCommand('win32', 'http://localhost:3000')).toEqual(
    ['cmd', '/c', 'start', '', 'http://localhost:3000'],
  );
  expect(browserCommand('darwin', 'http://x')).toEqual(['open', 'http://x']);
  expect(browserCommand('linux', 'http://x')).toEqual(['xdg-open', 'http://x']);
});

test('only a STEWARD reply counts as a STEWARD', () => {
  expect(isSteward({ name: 'steward', version: '0.2.0', packaged: true })).toBe(true);
  // Whatever else is on port 3000 — another dev server, a proxy, an HTML error page.
  for (const other of [null, 'steward', {}, { name: 'grafana' }, { version: '0.2.0' }]) {
    expect(isSteward(other)).toBe(false);
  }
});

test('a busy port is recognised however the runtime words it', () => {
  expect(isPortInUse({ code: 'EADDRINUSE' })).toBe(true);
  expect(isPortInUse(new Error('Failed to start server. Is port 3000 in use?\naddress already in use'))).toBe(true);
  expect(isPortInUse(new Error('permission denied'))).toBe(false);
});

test('listen falls back to an OS-chosen port, and only for EADDRINUSE', () => {
  const tried: number[] = [];
  const got = listen((port) => {
    tried.push(port);
    if (port !== 0) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
    return 51267;
  }, 3000);
  expect(tried).toEqual([3000, 0]);
  expect(got).toBe(51267);

  // Anything else is a real failure and must surface, not be papered over with a
  // different port — binding :80 without privileges is not "try another one".
  expect(() => listen(() => { throw new Error('permission denied'); }, 80)).toThrow(/permission denied/);
});

test('probing something that is not us returns null rather than hanging', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('not steward') });
  try {
    expect(await probeExisting(server.port!)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test('probing a real STEWARD /healthz identifies it', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ name: 'steward', version: '9.9.9', packaged: true }),
  });
  try {
    expect((await probeExisting(server.port!))?.version).toBe('9.9.9');
  } finally {
    server.stop(true);
  }
});

test('probing a dead port is a null, not a throw', async () => {
  // A closed port must read as "nobody is here", because the caller's next move is to
  // bind it. A thrown error would take the whole startup down.
  const server = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const port = server.port!;
  server.stop(true);
  expect(await probeExisting(port, 200)).toBeNull();
});
