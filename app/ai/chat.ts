// The chat verb, server-side (0005). On a `chat.send` turn STEWARD echoes the human's
// message, opens an AI bubble, and streams a model reply into it token-by-token — the
// same kit ops GRAIN's reasoners emit, so the browser renders it identically to any other
// door crossing. The model runs on the server (Ollama); ops ride the existing SSE hub.
//
// `streamReply` is injected (the real one is streamOllama) so this is unit-testable with a
// fake streamer and fake tools — no daemon, no network.

import type { Intent, Decision } from '@tjakoen/grain/ai/contract.ts';
import type { ReasonTools } from '@tjakoen/grain/ai/reasoner.ts';
import { userMessageOp, aiBubbleOp, typeToken, settleOp } from '@tjakoen/grain/ai/reasoner-kit.ts';
import type { ChatMessage } from './ollama.ts';

const SYSTEM = [
  'You are STEWARD, a concise assistant inside an admin cockpit — a task-ticket CRM where',
  'a Client (branded firm) has Customers, each with Tickets that move across a kanban board',
  '(Not Commenced, In Progress, Waiting, Completed) and render to branded PDFs.',
  'Answer the operator plainly and briefly. You cannot take actions yet — you advise only.',
].join(' ');

export type ReplyStreamer = (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<string>;

/**
 * Handle a `chat.send` intent by streaming a reply into a fresh chat bubble. Emits, in
 * order: the human's message (append), an empty AI bubble (append), the reply tokens
 * (type), and a settle. Returns a Decision whose ops are [] because everything is emitted
 * inline (the streaming pattern the interaction layer counts via `emit`).
 */
export async function streamChatReply(
  intent: Intent,
  tools: ReasonTools,
  streamReply: ReplyStreamer,
): Promise<Decision> {
  const message = String(intent.payload?.text ?? '').trim();
  if (!message) return { ok: true, ops: [], reply: '' };

  tools.emit(userMessageOp(intent.surface, message));
  const replyTarget = `chat-msg:${intent.session}:${nextId()}`;
  tools.emit(aiBubbleOp(intent.surface, replyTarget));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: message },
  ];

  let full = '';
  try {
    for await (const token of streamReply(messages)) {
      if (tools.cancelled()) break;
      full += token;
      tools.emit(typeToken(replyTarget, token));
    }
  } catch (e) {
    if (!full) tools.emit(typeToken(replyTarget, 'The local model is unavailable — is Ollama running?'));
    tools.emit(settleOp(replyTarget));
    return { ok: false, reason: `chat stream failed: ${String(e)}`, ops: [] };
  }

  tools.emit(settleOp(replyTarget));
  return { ok: true, ops: [], reply: full };
}

// Monotonic per-process id so concurrent turns get distinct bubble surfaces. (Not time —
// two turns in the same ms would collide.)
let counter = 0;
const nextId = () => `${++counter}`;
