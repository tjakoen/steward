import { test, expect } from 'bun:test';
import { streamChatReply } from './chat.ts';
import type { ReasonTools } from '@tjakoen/grain/ai/reasoner.ts';
import type { RenderOp, Intent } from '@tjakoen/grain/ai/contract.ts';

function fakeTools(cancelled = false) {
  const ops: RenderOp[] = [];
  const tools = {
    emit: (op: RenderOp) => ops.push(op),
    cancelled: () => cancelled,
    delay: async () => {},
    archiveItem: async () => {},
    renderSurface: async () => '',
  } as unknown as ReasonTools;
  return { ops, tools };
}

const intent = (text: string): Intent => ({
  source: 'user', session: 's1', screen: 'test',
  surface: 'chat-log:steward', action: 'chat.send', payload: { text },
});

async function* yields(...tokens: string[]) { for (const t of tokens) yield t; }

const typed = (ops: RenderOp[]) =>
  ops.filter((o) => o.op === 'type' && typeof (o as { text?: string }).text === 'string')
    .map((o) => (o as { text?: string }).text).join('');

test('streams the reply: user echo, AI bubble, tokens, settle', async () => {
  const { ops, tools } = fakeTools();
  const decision = await streamChatReply(intent('hello'), tools, () => yields('Hi', ' there', '.'));

  expect(decision.ok).toBe(true);
  expect(decision.reply).toBe('Hi there.');
  const appends = ops.filter((o) => o.op === 'append' && o.target === 'chat-log:steward');
  expect(appends.length).toBe(2);                       // human message + empty AI bubble
  expect(typed(ops)).toBe('Hi there.');                 // streamed into the bubble
  expect(ops.some((o) => o.op === 'type' && (o as { done?: boolean }).done === true)).toBe(true); // settled
});

test('an empty message is a no-op (no model call, no ops)', async () => {
  const { ops, tools } = fakeTools();
  let called = false;
  const decision = await streamChatReply(intent('   '), tools, () => { called = true; return yields('x'); });
  expect(decision.ok).toBe(true);
  expect(called).toBe(false);
  expect(ops.length).toBe(0);
});

test('a streamer failure settles the bubble with an honest message', async () => {
  const { ops, tools } = fakeTools();
  const boom = async function* (): AsyncIterable<string> { throw new Error('daemon down'); };
  const decision = await streamChatReply(intent('hi'), tools, () => boom());
  expect(decision.ok).toBe(false);
  expect(typed(ops)).toContain('unavailable');
  expect(ops.some((o) => o.op === 'type' && (o as { done?: boolean }).done === true)).toBe(true);
});

test('respects a cancel request and stops streaming', async () => {
  const { ops, tools } = fakeTools(true); // cancelled from the start
  const decision = await streamChatReply(intent('hi'), tools, () => yields('a', 'b', 'c'));
  expect(decision.ok).toBe(true);
  expect(typed(ops)).toBe('');            // no tokens streamed
});
