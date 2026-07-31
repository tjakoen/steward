// Server-side chat transport: stream tokens from a local Ollama daemon (0005). STEWARD
// has a server (unlike the static portfolio), so the model runs HERE, not in the browser
// — weights live on disk (pulled once via `ollama pull`), and any browser gets a reply
// over the existing SSE door. No WebGPU, no per-browser weight cache.
//
// Pure transport: NDJSON line parsing + an async-iterable of content tokens. `fetchImpl`
// is injectable so the streamer is unit-testable without a running daemon.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaOptions {
  /** Base URL of the Ollama HTTP API. Default from OLLAMA_URL env or localhost:11434. */
  url?: string;
  /** Model tag. Default from OLLAMA_MODEL env or "llama3.2:3b". */
  model?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Abort in-flight generation (a stop button, a dropped SSE client). */
  signal?: AbortSignal;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const OLLAMA_URL = Bun.env.OLLAMA_URL ?? 'http://localhost:11434';
export const OLLAMA_MODEL = Bun.env.OLLAMA_MODEL ?? 'llama3.2:3b';

/**
 * Stream a chat completion from Ollama as content-only token deltas. Yields each
 * `message.content` chunk in order; ends when the daemon reports `done`. Throws on a
 * non-OK response so the caller can surface an honest failure (daemon down, model missing).
 */
export async function* streamOllama(
  messages: ChatMessage[],
  opts: OllamaOptions = {},
): AsyncIterable<string> {
  const url = (opts.url ?? OLLAMA_URL).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model ?? OLLAMA_MODEL,
      messages,
      stream: true,
      options: opts.temperature != null ? { temperature: opts.temperature } : undefined,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ollama ${res.status} ${res.statusText || ''} — is the daemon running and the model pulled?`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Ollama streams newline-delimited JSON objects.
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const token = parseLine(line);
        if (token) yield token;
      }
    }
    const last = buf.trim();
    if (last) { const t = parseLine(last); if (t) yield t; }
  } finally {
    reader.releaseLock();
  }
}

/** One NDJSON line → its content token (empty string / malformed lines are skipped). */
function parseLine(line: string): string {
  try {
    const obj = JSON.parse(line) as { message?: { content?: string } };
    return obj.message?.content ?? '';
  } catch {
    return '';
  }
}
