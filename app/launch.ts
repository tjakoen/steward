// Starting up on a machine that has never run STEWARD before (0009).
//
// A checkout is started by a person who typed a command and is watching the output. A
// binary is started by a double-click, by someone who will look at a browser window and
// nothing else. Everything here exists for the second case, and none of it changes the
// first: from a checkout the preferred port is taken, no browser is opened, and this file
// is inert.
//
// The pure decisions (which command opens a browser, is that JSON one of ours) are split
// out from the effects, because a spawn and a bound socket are not things a unit test
// should have to arrange.

/** What `/healthz` answers. The marker a second launch looks for. */
export interface Health {
  name: string;
  version: string;
  packaged: boolean;
}

/** True when this JSON came from a STEWARD, not from whatever else holds the port. */
export function isSteward(body: unknown): body is Health {
  return !!body && typeof body === 'object' && (body as Health).name === 'steward';
}

/**
 * The command that opens a URL in the operator's default browser.
 *
 * Windows goes through `cmd /c start` with an EMPTY title argument: `start` treats a
 * quoted first argument as the window title, so `start "http://…"` opens a console window
 * titled with the URL and no browser at all. The empty `""` is the title, and the URL is
 * then the thing to open. It looks like a typo and is load-bearing.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  if (platform === 'darwin') return ['open', url];
  return ['xdg-open', url];
}

/** Open a browser, never throwing: no browser is a worse UX, not a failed startup. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    Bun.spawn(browserCommand(platform, url), { stdout: 'ignore', stderr: 'ignore' });
  } catch (e) {
    console.warn(`[launch] could not open a browser (${String(e)}); go to ${url}`);
  }
}

/**
 * Ask whoever holds `port` whether they are a STEWARD.
 *
 * Called before falling back to another port, so that a second double-click focuses the
 * running app instead of starting a second server on a second port. Two icons and two
 * databases is the wrong answer to "the operator clicked it again".
 *
 * Short timeout and total silence on failure: anything that is not a prompt STEWARD reply
 * is treated as "not ours", which is the safe direction — the cost of a false negative is
 * one extra port, the cost of a false positive is an app that refuses to start.
 */
export async function probeExisting(port: number, timeoutMs = 700): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isSteward(body) ? body : null;
  } catch {
    return null;
  }
}

/** An EADDRINUSE from `Bun.serve`, whatever shape the runtime gave it. */
export function isPortInUse(err: unknown): boolean {
  const s = String((err as { code?: string })?.code ?? err);
  return s.includes('EADDRINUSE') || s.toLowerCase().includes('address already in use');
}

/**
 * Bind the preferred port, or let the OS choose one.
 *
 * The OAuth redirect URI is derived from the port actually bound rather than the one asked
 * for (see server.ts), which is what makes falling back safe: a desktop OAuth client
 * accepts any loopback port, so nothing needs registering when this lands on 51267.
 */
export function listen<T>(serve: (port: number) => T, preferred: number): T {
  try {
    return serve(preferred);
  } catch (e) {
    if (!isPortInUse(e)) throw e;
    console.warn(`[launch] port ${preferred} is taken; taking one from the OS`);
    return serve(0);
  }
}
