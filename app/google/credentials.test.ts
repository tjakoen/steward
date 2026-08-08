import { describe, expect, test } from 'bun:test';
import type { SettingsRepository } from '../repo/ports.ts';
import {
  CREDENTIAL_KEYS, makeCredentials, normaliseCredential, parseCredentialBlob,
  projectNumberFrom, shapeComplaint,
} from './credentials.ts';
import { MIN_SECRET_LENGTH } from '../report/redact.ts';

const settingsStub = (seed: Record<string, string> = {}): SettingsRepository => {
  const m = new Map(Object.entries(seed));
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v); },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
};

// Fabricated, but the exact SHAPE of each real value — the tests are about shape, and a
// real credential in a public repository is the thing this whole plan exists to prevent.
// GitHub's push protection caught exactly that on the first attempt at this commit.
const SAMPLE = {
  clientId: '123456789012-abcdefghijklmnopqrstuvwxyz1234.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-FAKESECRETFORTESTSONLY000',
  apiKey: 'AIzaSyFAKEKEYFORTESTSONLY00000000000000',
  projectNumber: '123456789012',
} as const;

// No environment at all, which is a downloaded binary's state. Passed explicitly because
// the repository's own `.env` IS loaded into `Bun.env` while the suite runs — a test that
// let that through would pass or fail depending on the developer's machine.
const NO_ENV: Record<string, string | undefined> = {};

describe('resolution', () => {
  test('settings wins over the environment', () => {
    const creds = makeCredentials(
      settingsStub({ [CREDENTIAL_KEYS.apiKey]: 'from-settings' }),
      { GOOGLE_API_KEY: 'from-env' },
    );
    expect(creds.read('apiKey')).toBe('from-settings');
  });

  test('the environment is the fallback, so a checkout with .env still works', () => {
    const creds = makeCredentials(settingsStub(), { GOOGLE_API_KEY: 'from-env' });
    expect(creds.read('apiKey')).toBe('from-env');
  });

  test('nothing anywhere is the empty string, not undefined', () => {
    expect(makeCredentials(settingsStub(), NO_ENV).read('clientId')).toBe('');
  });

  // The point of the whole module: a value pasted into a RUNNING app is visible to the
  // next read. A boot-time `config` object could not do this, which is why these left it.
  test('a later write is seen without reconstructing anything', () => {
    const creds = makeCredentials(settingsStub(), NO_ENV);
    expect(creds.hasOAuthClient()).toBe(false);
    creds.write('clientId', SAMPLE.clientId);
    creds.write('clientSecret', SAMPLE.clientSecret);
    expect(creds.hasOAuthClient()).toBe(true);
  });

  test('clear removes it, and nothing resurrects it', () => {
    const creds = makeCredentials(settingsStub({ [CREDENTIAL_KEYS.apiKey]: 'x' }), NO_ENV);
    creds.clear('apiKey');
    expect(creds.read('apiKey')).toBe('');
  });

  // The property that makes the Settings card's "forget" control honest, and the reason
  // env is only a FALLBACK: on the maintainer's own machine a cleared field would
  // otherwise silently come back from `.env` and look like the clear had failed.
  test('a cleared field falls back to env rather than staying empty', () => {
    const creds = makeCredentials(
      settingsStub({ [CREDENTIAL_KEYS.apiKey]: 'from-settings' }),
      { GOOGLE_API_KEY: 'from-env' },
    );
    creds.clear('apiKey');
    expect(creds.read('apiKey')).toBe('from-env');
  });
});

describe('readiness', () => {
  test('the two capabilities are independent', () => {
    const creds = makeCredentials(settingsStub({
      [CREDENTIAL_KEYS.clientId]: SAMPLE.clientId,
      [CREDENTIAL_KEYS.clientSecret]: SAMPLE.clientSecret,
    }), NO_ENV);
    expect(creds.hasOAuthClient()).toBe(true);
    expect(creds.hasPicker()).toBe(false);
    expect(creds.missing()).toEqual(['apiKey', 'projectNumber']);
  });

  test('half an OAuth client is not an OAuth client', () => {
    const creds = makeCredentials(
      settingsStub({ [CREDENTIAL_KEYS.clientId]: SAMPLE.clientId }), NO_ENV,
    );
    expect(creds.hasOAuthClient()).toBe(false);
  });

  test('a fresh download is missing all four', () => {
    expect(makeCredentials(settingsStub(), NO_ENV).missing()).toEqual(
      ['clientId', 'clientSecret', 'apiKey', 'projectNumber'],
    );
  });
});

describe('shape checks', () => {
  test('every real value passes its own check', () => {
    for (const [field, value] of Object.entries(SAMPLE)) {
      expect(shapeComplaint(field as keyof typeof SAMPLE, value)).toBeNull();
    }
  });

  // The mistake this form invites: four opaque strings out of the same Console, four
  // boxes, nothing on screen to tell them apart once pasted. A client id in the API key
  // box surfaces hours later as "The API developer key is invalid" — 0016 records what
  // diagnosing that message costs, so it is caught at the door instead.
  test('every value is rejected by every other field', () => {
    const fields = Object.keys(SAMPLE) as (keyof typeof SAMPLE)[];
    for (const field of fields) {
      for (const other of fields) {
        if (field === other) continue;
        expect(shapeComplaint(field, SAMPLE[other])).not.toBeNull();
      }
    }
  });

  test('a truncated API key is refused', () => {
    expect(shapeComplaint('apiKey', 'AIzaSyC24XDnzb')).not.toBeNull();
  });

  test('the project id is refused where the project NUMBER belongs', () => {
    expect(shapeComplaint('projectNumber', 'steward-app-42')).not.toBeNull();
  });
});

describe('paste hygiene', () => {
  test('whitespace from a console copy comes off', () => {
    expect(normaliseCredential(`  ${SAMPLE.apiKey}\n`)).toBe(SAMPLE.apiKey);
  });

  test('a value broken across lines is repaired rather than rejected', () => {
    const split = `${SAMPLE.clientId.slice(0, 20)}\n  ${SAMPLE.clientId.slice(20)}`;
    expect(normaliseCredential(split)).toBe(SAMPLE.clientId);
    expect(shapeComplaint('clientId', normaliseCredential(split))).toBeNull();
  });
});

describe('the project number is already in the client id', () => {
  test('read off a real client id', () => {
    expect(projectNumberFrom(SAMPLE.clientId)).toBe(SAMPLE.projectNumber);
  });

  // Returns empty rather than guessing, so a project where the assumption does not hold
  // still configures by hand instead of silently storing a wrong appId.
  test('anything else derives nothing', () => {
    expect(projectNumberFrom('not-a-client-id')).toBe('');
    expect(projectNumberFrom('abc-123.apps.googleusercontent.com')).toBe('');
    expect(projectNumberFrom('123456789012-hash.example.com')).toBe('');
    expect(projectNumberFrom('')).toBe('');
  });
});

describe('importing a file', () => {
  // The exact shape Console downloads for a Desktop client. Accepting it as-is is the
  // point: the operator is holding this file already, and retyping out of it is how a
  // transcription error gets in.
  const GOOGLE_DESKTOP_JSON = JSON.stringify({
    installed: {
      client_id: SAMPLE.clientId,
      project_id: 'steward-app',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_secret: SAMPLE.clientSecret,
      redirect_uris: ['http://localhost'],
    },
  });

  test("Google's own client_secret file yields three of the four", () => {
    const { values } = parseCredentialBlob(GOOGLE_DESKTOP_JSON);
    expect(values.clientId).toBe(SAMPLE.clientId);
    expect(values.clientSecret).toBe(SAMPLE.clientSecret);
    expect(values.projectNumber).toBe(SAMPLE.projectNumber);
    expect(values.apiKey).toBeUndefined();
  });

  // Silence here would leave the operator thinking they had finished, and the failure
  // would surface much later as a Picker that will not open.
  test('and says why the API key is not there', () => {
    expect(parseCredentialBlob(GOOGLE_DESKTOP_JSON).complaints[0]).toContain('API key');
  });

  test('a web client nests under a different key and is read too', () => {
    const web = JSON.stringify({ web: { client_id: SAMPLE.clientId, client_secret: SAMPLE.clientSecret } });
    expect(parseCredentialBlob(web).values.clientId).toBe(SAMPLE.clientId);
  });

  test("STEWARD's own export round-trips with no complaint", () => {
    const { values, complaints } = parseCredentialBlob(JSON.stringify(SAMPLE));
    expect(values).toEqual({ ...SAMPLE });
    expect(complaints).toEqual([]);
  });

  test('an explicit project number beats the derived one', () => {
    const blob = JSON.stringify({ clientId: SAMPLE.clientId, projectNumber: '999999999' });
    expect(parseCredentialBlob(blob).values.projectNumber).toBe('999999999');
  });

  test('junk is refused in words rather than throwing', () => {
    expect(parseCredentialBlob('not json at all').complaints[0]).toContain('not valid JSON');
    expect(parseCredentialBlob('[]').values).toEqual({});
    expect(parseCredentialBlob('{"unrelated":"thing"}').complaints[0]).toContain('No credentials found');
  });

  // The file path must not be a way around the checks the typed fields enforce. The parser
  // deliberately does not validate — the route runs `shapeComplaint` over what comes out —
  // so this asserts the value survives to be caught rather than being silently dropped.
  test('a malformed value is returned, so the caller can refuse it', () => {
    const blob = JSON.stringify({ clientId: SAMPLE.clientId, apiKey: 'AIzaTooShort' });
    expect(parseCredentialBlob(blob).values.apiKey).toBe('AIzaTooShort');
    expect(shapeComplaint('apiKey', 'AIzaTooShort')).not.toBeNull();
  });
});

// The reason these live in `settings` rather than beside them: 0015 redacts the contents
// of that table out of a bug report as a SWEEP, with no list to maintain. A baked constant
// was never covered by it. This asserts the property the sweep depends on.
test('all four are long enough for the bug report to redact', () => {
  for (const value of Object.values(SAMPLE)) {
    expect(value.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
  }
});
