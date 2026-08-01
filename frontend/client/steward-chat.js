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
      if (o.done) { t.classList.add('settled'); setBusy(false); }
      scrollLog();
      break;
    default:
      break; // timeline `log` ops etc. — no surface here, ignore
  }
}

let logEl, input, statusEl, panelEl, toggleEl, sendEl;

function buildPanel() {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn chat-toggle';
  toggle.textContent = '✶ Assistant';
  // The toggle is the panel's only opener AND its only closer, so it has to
  // report the panel's state rather than just carrying a label.
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'chat-panel');

  const panel = document.createElement('section');
  panel.className = 'chat-panel';
  panel.id = 'chat-panel';
  panel.hidden = true;
  // A <section> with no accessible name is announced as an unnamed region; the
  // heading it already displays is the name.
  panel.setAttribute('aria-labelledby', 'chat-panel-title');
  panel.innerHTML =
    '<header class="chat-panel__head"><strong id="chat-panel-title">Assistant</strong>' +
    '<span class="chat-status" data-surface="chat-status"></span>' +
    '<button type="button" class="btn topbar__btn" data-chat-close aria-label="Close assistant">✕</button>' +
    '</header>' +
    // GRAIN's chat-log owns the thread (bubbles align themselves inside it);
    // chat-panel__log is STEWARD's — it makes the log fill and scroll THIS panel.
    `<div class="chat-log chat-panel__log" data-surface="${LOG_SURFACE}" data-kind="chat-log" aria-live="polite"></div>` +
    '<form class="chat-composer"><textarea rows="2" placeholder="Ask about STEWARD…" ' +
    'aria-label="Message the assistant"></textarea>' +
    '<button type="submit" class="btn chat-send">Send</button></form>';

  document.body.append(toggle, panel);
  panelEl = panel;
  toggleEl = toggle;
  logEl = panel.querySelector('.chat-log');
  input = panel.querySelector('textarea');
  statusEl = panel.querySelector('.chat-status');
  sendEl = panel.querySelector('.chat-send');

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.querySelector('[data-chat-close]').addEventListener('click', () => setOpen(false));
  panel.querySelector('form').addEventListener('submit', onSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
  });
  // Escape closes the panel, and stops there: the app's own Escape handler closes
  // the record drawer, and one key press should not dismiss two things.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  });
}

/** Open or close the panel, moving focus with it and saying so on the toggle. */
function setOpen(open) {
  panelEl.hidden = !open;
  toggleEl.setAttribute('aria-expanded', String(open));
  if (open) input.focus();
  else toggleEl.focus();
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
function scrollLog() { if (logEl) logEl.scrollTop = logEl.scrollHeight; }

// The composer is dead while a reply streams — the :disabled styling for it has
// existed since 0005 with nothing ever setting the property. A reply ends when
// the server marks a `type` op done; the timer is the backstop for a reply that
// never finishes, because a permanently disabled composer is worse than a
// second question arriving mid-answer.
let busy = false;
let busyTimer;

function setBusy(b) {
  busy = b;
  if (input) input.disabled = b;
  if (sendEl) sendEl.disabled = b;
  clearTimeout(busyTimer);
  if (b) busyTimer = setTimeout(() => setBusy(false), 60_000);
  if (!b && panelEl && !panelEl.hidden && document.activeElement === document.body) input.focus();
}

async function onSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  setBusy(true);
  setStatus('Thinking…');
  try {
    const res = await fetch('/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, screen: location.pathname, surface: LOG_SURFACE, action: 'chat.send', payload: { text } }),
    });
    if (res.status !== 202) { setStatus('Error ' + res.status); setBusy(false); }
    else setStatus('');
  } catch (err) {
    setStatus('Offline — is the server running?');
    setBusy(false);
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
