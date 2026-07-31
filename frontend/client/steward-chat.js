// STEWARD chat island (0005) — a server-side assistant panel.
//
// Unlike GRAIN's static portfolio (which had to run the model in-browser over WebGPU),
// STEWARD has a server: the model runs THERE (Ollama), and the reply streams back over the
// SAME /intent door + SSE hub every other STEWARD intent uses. So this island is pure
// vanilla JS — no WebGPU, no model download, works in any browser. It just posts a
// `chat.send` intent and renders the ops the server pushes back (the human echo, the AI
// bubble, streamed tokens), addressed by data-surface.

const LOG_SURFACE = 'chat-log:steward';
const session = crypto.randomUUID();

const find = (surface) => document.querySelector(`[data-surface="${CSS.escape(surface)}"]`);

// ---- render ops the server streams back (append | replace | remove | flash | type) ----
function applyOp(o) {
  const t = find(o.target);
  if (!t) return;
  switch (o.op) {
    case 'append':
      if (o.html) t.insertAdjacentHTML('beforeend', o.html);
      scrollLog();
      break;
    case 'replace':
      if (o.html) t.outerHTML = o.html;
      break;
    case 'remove':
      t.remove();
      break;
    case 'flash':
      t.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 350 });
      break;
    case 'type':
      // Stream a token into a bubble body; text only, never innerHTML the raw stream.
      if (typeof o.back === 'number') t.textContent = [...t.textContent].slice(0, -o.back).join('');
      else if (typeof o.text === 'string') t.textContent += o.text;
      if (o.done) t.classList.add('settled');
      scrollLog();
      break;
    default:
      break; // timeline `log` ops etc. — no surface here, ignore
  }
}

let logEl, input, statusEl;

function buildPanel() {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chat-toggle';
  toggle.textContent = '✶ Assistant';

  const panel = document.createElement('section');
  panel.className = 'chat-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<header class="chat-panel__head"><strong>Assistant</strong>' +
    '<span class="chat-status" data-surface="chat-status"></span></header>' +
    `<div class="chat-log" data-surface="${LOG_SURFACE}" data-kind="chat-log" aria-live="polite"></div>` +
    '<form class="chat-composer"><textarea rows="2" placeholder="Ask about STEWARD…" ' +
    'aria-label="Message the assistant"></textarea><button type="submit">Send</button></form>';

  document.body.append(toggle, panel);
  logEl = panel.querySelector('.chat-log');
  input = panel.querySelector('textarea');
  statusEl = panel.querySelector('.chat-status');

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  panel.querySelector('form').addEventListener('submit', onSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
  });
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
function scrollLog() { if (logEl) logEl.scrollTop = logEl.scrollHeight; }

async function onSubmit(e) {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  setStatus('Thinking…');
  try {
    const res = await fetch('/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, screen: location.pathname, surface: LOG_SURFACE, action: 'chat.send', payload: { text } }),
    });
    if (res.status !== 202) setStatus('Error ' + res.status);
    else setStatus('');
  } catch (err) {
    setStatus('Offline — is the server running?');
    console.error('[steward-chat]', err);
  }
}

function init() {
  buildPanel();
  // The reply streams over this session's SSE (same hub the app uses).
  const es = new EventSource('/stream?session=' + encodeURIComponent(session));
  es.addEventListener('op', (ev) => { try { applyOp(JSON.parse(ev.data)); } catch { /* ignore */ } });
  es.addEventListener('error', () => setStatus('Reconnecting…'));
  es.addEventListener('open', () => setStatus(''));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
