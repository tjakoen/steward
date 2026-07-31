import { test, expect } from 'bun:test';
import {
  makeVerifier, challengeFor, authUrl, makeGoogleAuth, GOOGLE_SCOPE,
} from './oauth.ts';
import type { SettingsRepository } from '../repo/ports.ts';

const cfg = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'http://127.0.0.1:3211/oauth/google/callback',
};

/** In-memory settings, so these tests never touch a real database. */
function memorySettings(seed: Record<string, string> = {}): SettingsRepository {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
  };
}

test('verifiers are URL-safe, long enough for RFC 7636, and never repeat', () => {
  const a = makeVerifier(), b = makeVerifier();
  expect(a).not.toBe(b);
  expect(a.length).toBeGreaterThanOrEqual(43);
  expect(a.length).toBeLessThanOrEqual(128);
  expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
});

test('the challenge is a stable S256 digest, not the verifier itself', async () => {
  const v = makeVerifier();
  const c = await challengeFor(v);
  expect(c).not.toBe(v);
  expect(c).toBe(await challengeFor(v));
  expect(c).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url: no padding, no +/
});

test('the auth URL asks for offline access and the narrow drive.file scope', async () => {
  const url = new URL(authUrl(cfg, await challengeFor('v'), 'state123'));
  const q = url.searchParams;
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(q.get('scope')).toBe(GOOGLE_SCOPE);
  expect(GOOGLE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('access_type')).toBe('offline'); // or no refresh token is issued
  expect(q.get('state')).toBe('state123');
  expect(q.get('redirect_uri')).toBe(cfg.redirectUri);
});

test('the auth URL never carries the verifier or the client secret', async () => {
  const url = authUrl(cfg, await challengeFor('verifier-value'), 's');
  expect(url).not.toContain('verifier-value');
  expect(url).not.toContain(cfg.clientSecret);
});

test('status reports configured/connected without exposing the token', () => {
  const disconnected = makeGoogleAuth(memorySettings(), cfg).status();
  expect(disconnected).toEqual({ configured: true, connected: false, account: null });

  const connected = makeGoogleAuth(
    memorySettings({ 'google.refresh_token': 'rt', 'google.account': 'me@example.com' }), cfg,
  ).status();
  expect(connected).toEqual({ configured: true, connected: true, account: 'me@example.com' });
  expect(JSON.stringify(connected)).not.toContain('rt');
});

test('no client id means not configured', () => {
  expect(makeGoogleAuth(memorySettings(), { ...cfg, clientId: '' }).status().configured).toBe(false);
});

test('accessToken returns null when disconnected rather than throwing', async () => {
  const auth = makeGoogleAuth(memorySettings(), cfg, (async () => {
    throw new Error('must not call the network when there is no refresh token');
  }) as unknown as typeof fetch);
  expect(await auth.accessToken()).toBeNull();
});

test('a cached access token is reused until it nears expiry', async () => {
  const settings = memorySettings({
    'google.refresh_token': 'rt',
    'google.access_token': 'cached',
    'google.access_expires_at': String(Date.now() + 10 * 60_000),
  });
  const auth = makeGoogleAuth(settings, cfg, (async () => {
    throw new Error('must not refresh a token that is still valid');
  }) as unknown as typeof fetch);
  expect(await auth.accessToken()).toBe('cached');
});

test('an expired access token is refreshed with the refresh token', async () => {
  const settings = memorySettings({
    'google.refresh_token': 'rt',
    'google.access_token': 'stale',
    'google.access_expires_at': String(Date.now() - 1000),
  });
  let sentBody = '';
  const auth = makeGoogleAuth(settings, cfg, (async (_url: string, init: RequestInit) => {
    sentBody = String(init.body);
    return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch);

  expect(await auth.accessToken()).toBe('fresh');
  expect(sentBody).toContain('grant_type=refresh_token');
  expect(settings.get('google.access_token')).toBe('fresh');
});

test('disconnect forgets every credential it stored', async () => {
  const settings = memorySettings({
    'google.refresh_token': 'rt', 'google.access_token': 'at',
    'google.access_expires_at': '123', 'google.account': 'me@example.com',
  });
  makeGoogleAuth(settings, cfg).disconnect();
  for (const k of ['google.refresh_token', 'google.access_token', 'google.access_expires_at', 'google.account']) {
    expect(settings.get(k)).toBeNull();
  }
});

test('a login that yields no refresh token fails loudly', async () => {
  const auth = makeGoogleAuth(memorySettings(), cfg, (async () =>
    new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
  ) as unknown as typeof fetch);
  expect(auth.completeLogin('code', 'verifier')).rejects.toThrow(/refresh token/);
});

test('the code exchange sends the verifier, and a rejection surfaces', async () => {
  let body = '';
  const auth = makeGoogleAuth(memorySettings(), cfg, (async (_u: string, init: RequestInit) => {
    body = String(init.body);
    return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), { status: 400 });
  }) as unknown as typeof fetch);

  expect(auth.completeLogin('the-code', 'the-verifier')).rejects.toThrow(/bad code/);
  expect(body).toContain('code_verifier=the-verifier');
  expect(body).toContain('grant_type=authorization_code');
});

test('the connected account is read from Drive, not an email scope endpoint', async () => {
  const settings = memorySettings();
  const urls: string[] = [];
  const auth = makeGoogleAuth(settings, cfg, (async (url: string) => {
    urls.push(url);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ user: { emailAddress: 'me@example.com' } }), { status: 200 });
  }) as unknown as typeof fetch);

  await auth.completeLogin('code', 'verifier');
  expect(settings.get('google.account')).toBe('me@example.com');
  expect(urls.some((u) => u.includes('/drive/v3/about'))).toBe(true);
  expect(urls.some((u) => u.includes('userinfo'))).toBe(false);
});

test('a failure to name the account does not break the connection', async () => {
  const settings = memorySettings();
  const auth = makeGoogleAuth(settings, cfg, (async (url: string) => {
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    }
    throw new Error('network down');
  }) as unknown as typeof fetch);

  await auth.completeLogin('code', 'verifier');
  expect(auth.status().connected).toBe(true);
  expect(settings.get('google.account')).toBeNull();
});

test('ensureAccount backfills a connection made before we asked, then stops asking', async () => {
  const settings = memorySettings({
    'google.refresh_token': 'rt',
    'google.access_token': 'at',
    'google.access_expires_at': String(Date.now() + 600_000),
  });
  let aboutCalls = 0;
  const auth = makeGoogleAuth(settings, cfg, (async () => {
    aboutCalls++;
    return new Response(JSON.stringify({ user: { emailAddress: 'me@example.com' } }), { status: 200 });
  }) as unknown as typeof fetch);

  await auth.ensureAccount();
  expect(settings.get('google.account')).toBe('me@example.com');
  await auth.ensureAccount(); // already known — must not call again
  expect(aboutCalls).toBe(1);
});
