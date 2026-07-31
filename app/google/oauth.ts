// Google OAuth 2.0 for an INSTALLED app: user consent, PKCE, loopback redirect.
//
// Why this flow and not a service account: files land in the operator's OWN
// Drive, owned by them — and a service-account key would have to ship inside
// the distributed binary (0007), which is a secret-distribution problem with no
// good answer for a desktop app.
//
// Scope is `drive.file` — per-file access to what STEWARD creates. It is a
// NON-SENSITIVE scope, so publishing the OAuth app to Production (which is what
// stops Google expiring refresh tokens after 7 days) needs no verification
// review. Widening this scope changes that, so don't widen it casually.
//
// Tokens are CREDENTIALS: stored locally, never audited, never rendered.

import type { SettingsRepository } from '../repo/ports.ts';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';

const KEY = {
  refresh: 'google.refresh_token',
  access: 'google.access_token',
  expires: 'google.access_expires_at',
  account: 'google.account', // the signed-in address, shown in Settings
} as const;

export interface GoogleOAuthConfig {
  clientId: string;
  /** Google issues one for "Desktop app" clients; it is not truly secret. */
  clientSecret: string;
  redirectUri: string;
}

// ---- PKCE ------------------------------------------------------------------

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh high-entropy code verifier (RFC 7636 allows 43–128 chars). */
export function makeVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(64)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/**
 * The URL to send the operator to. `state` guards the callback against
 * cross-site request forgery; the verifier never leaves this machine.
 */
export function authUrl(cfg: GoogleOAuthConfig, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // offline + consent is what actually yields a refresh token, rather than a
    // one-hour access token that silently strands the connection.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${q}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

type Fetcher = typeof fetch;

async function postToken(body: URLSearchParams, fetchImpl: Fetcher): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`google token exchange failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json;
}

/** Connection state as Settings should describe it — never includes a token. */
export interface GoogleStatus {
  configured: boolean; // a client id exists
  connected: boolean; // we hold a refresh token
  account: string | null;
}

export function makeGoogleAuth(
  settings: SettingsRepository,
  cfg: GoogleOAuthConfig,
  fetchImpl: Fetcher = fetch,
) {
  const now = () => Date.now();

  return {
    scope: GOOGLE_SCOPE,

    status(): GoogleStatus {
      return {
        configured: Boolean(cfg.clientId),
        connected: Boolean(settings.get(KEY.refresh)),
        account: settings.get(KEY.account),
      };
    },

    /** Exchange the one-time code for tokens and remember the refresh token. */
    async completeLogin(code: string, verifier: string): Promise<void> {
      const token = await postToken(new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }), fetchImpl);

      if (!token.refresh_token) {
        throw new Error('google returned no refresh token — re-consent is required');
      }
      settings.set(KEY.refresh, token.refresh_token);
      if (token.access_token) {
        settings.set(KEY.access, token.access_token);
        settings.set(KEY.expires, String(now() + (token.expires_in ?? 3600) * 1000));
        try {
          const who = await fetchImpl(USERINFO_ENDPOINT, {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          const info = (await who.json()) as { email?: string };
          if (info.email) settings.set(KEY.account, info.email);
        } catch { /* the address is a nicety; the connection still works */ }
      }
    },

    /**
     * A usable access token, refreshing when the cached one is near expiry.
     * Returns null when not connected — callers fall back rather than throw.
     */
    async accessToken(): Promise<string | null> {
      const refresh = settings.get(KEY.refresh);
      if (!refresh) return null;

      const cached = settings.get(KEY.access);
      const expires = Number(settings.get(KEY.expires) ?? 0);
      // 60s of slack so a token can't expire mid-request.
      if (cached && expires > now() + 60_000) return cached;

      const token = await postToken(new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }), fetchImpl);

      if (!token.access_token) return null;
      settings.set(KEY.access, token.access_token);
      settings.set(KEY.expires, String(now() + (token.expires_in ?? 3600) * 1000));
      return token.access_token;
    },

    /** Forget the connection locally. Files already in Drive stay in Drive. */
    disconnect(): void {
      for (const k of Object.values(KEY)) settings.remove(k);
    },
  };
}

export type GoogleAuth = ReturnType<typeof makeGoogleAuth>;
