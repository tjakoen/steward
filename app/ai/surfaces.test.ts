// A surface address is a contract across three files, and breaking it errors nowhere:
// the op is dispatched at a `querySelector` that matches nothing and is dropped. 0008
// left `/ai/manifest` advertising `reflection` after the last reflection surface was
// deleted, and nobody noticed because a manifest that lies looks exactly like one that
// does not. These are the mechanisms that make it noticeable.

import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { actionsForKind, surfaceKind } from '@tjakoen/grain/ai/contract.ts';
import { config } from '../../config.ts';
import { CHAT_SURFACE, SCREEN_SURFACE } from './surfaces.ts';

const read = (...p: string[]) => readFileSync(join(config.root, ...p), 'utf8');

test('the chat surface the server advertises is the one the client renders', () => {
  const client = read('frontend', 'client', 'steward-chat.js');

  // Declared once client-side, as `const LOG_SURFACE = '…'`.
  const declared = /const LOG_SURFACE = '([^']+)'/.exec(client)?.[1];
  expect(declared).toBe(CHAT_SURFACE);

  // …and actually written into the markup as a data-surface, not merely declared.
  expect(client).toContain('data-surface="${LOG_SURFACE}"');
});

test('every advertised surface is a kind that accepts at least one verb', () => {
  // An address nothing can be done to is not worth advertising: a reasoner reading the
  // manifest would see a target with an empty verb list and no way to act on it.
  for (const s of [CHAT_SURFACE, SCREEN_SURFACE]) {
    expect(actionsForKind(surfaceKind(s)).length).toBeGreaterThan(0);
  }
});

test('nothing advertises the reflection surface any more', () => {
  // The specific regression 0009 closed. STEWARD renders no reflection surface, so
  // naming one — in the manifest or in a RenderOp target — streams to nothing.
  for (const f of [['server.ts'], ['app', 'ai', 'reasoner.ts'], ['app', 'ai', 'surfaces.ts']]) {
    expect(read(...f)).not.toMatch(/surface\(\s*'reflection'/);
  }
});
