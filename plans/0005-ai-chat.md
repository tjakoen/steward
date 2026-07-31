---
id: 0005-ai-chat
title: STEWARD — Server-side AI chat (local Ollama over the /intent door)
status: done
owner: admin
created: 2026-07-31
milestone: M2 (AI-native cockpit)
tags: [ai, ollama, chat, sse, intent]
tasks:
  - id: ollama-transport
    title: streamOllama — NDJSON token stream from the local Ollama daemon (injectable fetch)
    status: done
  - id: chat-verb
    title: streamChatReply — chat.send → echo + AI bubble + streamed tokens as kit ops
    status: done
  - id: reasoner-wire
    title: Route chat.send/say.set through makeStewardReasoner → Ollama, ops over SSE
    status: done
  - id: chat-panel
    title: Vanilla chat panel (own SSE + applyOp), no WebGPU / no client model
    status: done
  - id: tests
    title: Ollama stream-parse tests + chat-verb tests (fakes) + headless E2E over SSE
    status: done
---

# STEWARD — Server-side AI chat (0005)

Milestone-2 opener: a chat panel where the operator talks to a local model. **STEWARD
has a server** (unlike GRAIN's static portfolio, which had to run the model in-browser
over WebGPU), so the model runs **server-side on Ollama** and the reply streams back over
the **same `/intent` door + SSE hub** every other STEWARD intent already uses. Result:
works in any browser, no WebGPU, no per-browser weight cache — and it's **headlessly
end-to-end testable**.

## Why this shape (and what it replaced)

A first cut ran WebLLM in-browser (WebGPU) with GRAIN's manifest-driven move-reasoner. Two
problems: (1) a ~3B local model is unreliable at the strict JSON that reasoner demands, so
it often didn't reply; (2) in-browser inference needs WebGPU + a hundreds-of-MB per-browser
download and can't be verified headlessly. Since STEWARD ships a server, the honest fit is
server-side inference. Agentic verb-execution (the model *doing* things) still waits for
0006-grain-upstream — until STEWARD verbs are in GRAIN's vocabulary there's nothing to
validate a move against. 0005 delivers a reliable conversational assistant; the door +
bubble surfaces it uses are reused unchanged when 0006 makes it agentic.

## Transport (`app/ai/ollama.ts`)

`streamOllama(messages, opts)` → `AsyncIterable<string>`: POST to Ollama's
`/api/chat` with `stream:true`, parse the newline-delimited JSON, yield each
`message.content` token. `OLLAMA_URL` (default `localhost:11434`) and `OLLAMA_MODEL`
(default `llama3.2:3b`) are env-config. `fetchImpl` is injectable so the NDJSON parsing
(including a JSON object split across network chunks, malformed lines, non-OK responses) is
unit-tested without a daemon. Model weights live on disk once (`ollama pull llama3.2:3b`).

## The chat verb (`app/ai/chat.ts`)

`streamChatReply(intent, tools, streamReply)`: on a `chat.send` turn, emit — in order —
the human's message (`userMessageOp`, append), an empty AI bubble (`aiBubbleOp`, append),
the reply tokens (`typeToken`), and a `settleOp`. Same kit op-builders GRAIN's reasoners
emit, so the browser renders a server reply identically to any door crossing. `streamReply`
is injected (real = `streamOllama`) so the verb is unit-tested with a fake streamer + fake
tools; honours `tools.cancelled()` (stop) and settles the bubble with an honest message if
the daemon is down. A concise STEWARD system prompt gives the model domain context.

## Wiring (`app/ai/reasoner.ts`, `server.ts`)

`chat.send`/`say.set` are GRAIN vocabulary, so they already reach `makeStewardReasoner`
via the interaction layer (`/intent` → `aiLayer.handleIntent`). The reasoner now routes
those to `streamChatReply`; `tools.emit` pushes each op over the SSE hub to the raising
session — no new route, no new door. (The earlier WebGPU cut's module server + client model
were removed.)

## Chat panel (`frontend/client/steward-chat.js`)

Pure vanilla JS, no imports: self-injects a floating ✶ Assistant panel (composer + a
`chat-log:steward` surface), opens its own SSE on a session, and POSTs `chat.send` to
`/intent`. The server-streamed ops (echo, bubble, tokens) render via a small `applyOp`
(append/replace/remove/flash/type). Works in every browser; degrades honestly if the
server/daemon is offline.

## Definition of done

- `POST /intent {action:"chat.send", text}` streams a real model reply back over SSE as
  `append` (echo + bubble) then `type` tokens — **verified headlessly** (boot server,
  subscribe `/stream`, post, observe 22 token ops reconstructing a coherent reply).
- Any browser (no WebGPU) shows the panel and a streamed reply; offline degrades honestly.
- `streamOllama` parses NDJSON incl. chunk-split objects, skips malformed lines, throws on
  non-OK — unit-tested.
- `streamChatReply` emits echo → bubble → tokens → settle, no-ops an empty message, settles
  on failure, respects cancel — unit-tested with fakes.
- `bun run check` clean; `bun test` green (39 tests).
- Follow-up: agentic verb-execution (the model driving `ticket.*`/`customer.*`) lands in
  0006-grain-upstream, reusing this door + bubble surfaces.

## Operator note

Requires a running Ollama with the model pulled: `ollama serve` (daemon) +
`ollama pull llama3.2:3b`. For the 0007 Windows binary, the friend installs Ollama the same
way (or we revisit a bundled GGUF runtime then).
