// The GRAIN surfaces STEWARD's markup actually carries.
//
// A surface address is a contract between three places: the markup that renders
// `data-surface`, the manifest that advertises the address to a reasoner, and the
// reasoner that emits RenderOps at it. Get them out of step and nothing errors — the op
// is dispatched at a `querySelector` that finds nothing and is dropped. 0008 left exactly
// that behind (`/ai/manifest` advertising `reflection` after the last reflection surface
// was deleted), which is why these names live in one file with a test behind them rather
// than as string literals in three.

import { surface } from '@tjakoen/grain/ai/contract.ts';

/**
 * The assistant's thread. Mounted on every page by `frontend/client/steward-chat.js`
 * (its `LOG_SURFACE`), which owns the element and dispatches ops at it itself.
 */
export const CHAT_SURFACE = surface('chat-log', 'steward');

/**
 * The page itself. Ambient — `screen` is deliberately NOT a DOM node; it addresses the
 * document, which is why ai-dispatch.js handles `navigate` globally. `demo.run` and
 * `desk.stop` accept this kind.
 */
export const SCREEN_SURFACE = surface('screen');
