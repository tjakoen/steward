// STEWARD client runtime: opens the shared SSE stream and applies render ops,
// and wires FormBuilder forms to post Intents through the single door.
// Ops it understands: append | replace | remove | flash (by data-surface target).

const session = crypto.randomUUID();

function el(surface) {
  return document.querySelector(`[data-surface="${CSS.escape(surface)}"]`);
}

function applyOp(o) {
  const t = el(o.target);
  switch (o.op) {
    case 'append':
      if (t && o.html) t.insertAdjacentHTML('beforeend', o.html);
      break;
    case 'replace':
      if (t && o.html) t.outerHTML = o.html;
      break;
    case 'remove':
      if (t) t.remove();
      break;
    case 'flash':
      if (t) { t.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 350 }); }
      break;
  }
  refreshBoardCounts();
}

// Recompute kanban column counts from the DOM after every op (moves change them).
// Counts VISIBLE cards so an active filter shows filtered totals — and counts
// `.kanban-card` specifically, because the list also holds the empty-state item.
function refreshBoardCounts() {
  document.querySelectorAll('.kanban-col').forEach((col) => {
    const count = col.querySelector('.count');
    const cards = col.querySelector('.kanban-cards');
    if (count && cards) {
      count.textContent = String([...cards.querySelectorAll('.kanban-card')].filter((c) => !c.hidden).length);
    }
  });
}

// ---- slide-in drawer (view / new / edit) -----------------------------------
// Records are read AND written in the drawer: clicking a row or board card
// loads `/<record>/panel` (the view form), and Edit swaps in the `/edit`
// fragment for the same record. The full detail page still exists for deep
// links — it renders the SAME panel markup, so the two can't drift.
const drawer = () => document.getElementById('app-drawer');
function drawerParts() {
  const d = drawer(); if (!d) return null;
  return { d, body: d.querySelector('[data-drawer-body]'), title: d.querySelector('[data-drawer-title]') };
}
// GRAIN's scripts/drawer.js owns the modal half — open, close, Escape, the scrim,
// focus in, Tab trapped, the rest of the page `inert`, focus handed back. STEWARD
// owns what goes IN the panel, and opens through the documented seam rather than
// GRAIN's `data-drawer-open` attribute: the attribute would fire first and show
// whatever content the panel last held, so the content is put in place FIRST and
// the drawer opened after, which is also what makes GRAIN focus the right field.
const openDrawer = (opener) => window.grain?.drawer?.open(drawer(), opener);

// GRAIN focuses the first control in the panel, which is the close button in the
// head. That is right for a record being READ; for a form it is one Tab short of
// where the operator is going, so the form's own first field takes over.
function focusFirstField(p) {
  const f = p.body.querySelector('input:not([type=hidden]), select, textarea');
  if (f) f.focus();
}

// The one thing a modal needs that GRAIN's script does not do: lock the scroll.
// `inert` stops Tab and the pointer, not the wheel — and this shell scrolls in
// the pane, not the document. Driven off the drawer's own events so it cannot
// fall out of step with whatever opened it.
document.addEventListener('grain:drawer-open', () => {
  document.documentElement.classList.add('is-drawer-open');
});
document.addEventListener('grain:drawer-close', (e) => {
  document.documentElement.classList.remove('is-drawer-open');
  if (e.target instanceof HTMLElement) delete e.target.dataset.recordPath;
});

// The create form ships inside the drawer; stash it so "+ New" can restore it
// after the drawer has been used to view or edit a record.
let createHTML = null, createTitle = '';
(() => { const p = drawerParts(); if (p) { createHTML = p.body.innerHTML; createTitle = p.title.textContent; } })();

async function loadPanel(path, opener) {
  const p = drawerParts(); if (!p) return;
  p.body.innerHTML = '<p class="muted">Loading…</p>';
  p.title.textContent = 'Details';
  openDrawer(opener);
  p.d.dataset.recordPath = path;   // after opening: closing clears it
  p.body.innerHTML = await (await fetch(path + '/panel')).text();
  const marker = p.body.querySelector('[data-panel-title]');
  if (marker) p.title.textContent = marker.getAttribute('data-panel-title');
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const newBtn = t.closest('[data-drawer-new]');
  if (newBtn) {
    const p = drawerParts();
    if (p && createHTML !== null) {
      p.body.innerHTML = createHTML;
      p.title.textContent = createTitle;
    }
    openDrawer(newBtn);
    if (p) focusFirstField(p);
    return;
  }
  // A record row / board card opens its panel — but let modified clicks and
  // links inside the drawer (PDF, "open full page") behave normally.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const rec = t.closest('[data-href]');
  if (rec && !t.closest('.drawer')) {
    e.preventDefault();
    loadPanel(rec.getAttribute('data-href'), t.closest('a') ?? rec);
  }
});
// Escape clears the filter it is typed into. Closing the drawer on Escape is
// GRAIN's (drawer.js); this only handles the case its own handler cannot see,
// because the filter box lives outside the drawer and is never focused while
// one is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t instanceof HTMLElement && t.hasAttribute('data-filter') && t.value) clearFilter(t);
});

// ---- Drive picker ----------------------------------------------------------
// Loaded only when asked for, so Google's SDK is not fetched by every page.
document.addEventListener('click', async (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest('[data-picker]') : null;
  if (!btn) return;
  e.preventDefault();
  const { openPicker } = await import('/app/steward-picker.js');
  openPicker(btn);
});

// Re-read whatever surface the user is looking at. The drawer holds a fragment,
// so reloading the page there would throw away the panel they are working in.
document.addEventListener('steward:refresh', () => {
  const path = drawer()?.dataset.recordPath;
  if (path && !drawer().hidden) loadPanel(path); else location.reload();
});

// ---- instant client-side filter (topbar box filters a table body or board) -
// It hides rows, so it has to SAY it hid them: a filtered list with no running
// total reads exactly like the whole list, and the page-head count above it does
// not move. The note is the honest total; Clear and Escape are the way out.
function applyFilter(inp) {
  const scope = document.querySelector(inp.getAttribute('data-filter'));
  if (!scope) return;
  const q = inp.value.trim().toLowerCase();
  const rows = scope.querySelectorAll('tr.row, li.kanban-card, li.audit__row');
  let shown = 0;
  rows.forEach((r) => {
    const hide = q ? !r.textContent.toLowerCase().includes(q) : false;
    r.hidden = hide;
    if (!hide) shown++;
  });
  refreshBoardCounts();

  const clear = inp.closest('.topbar-search')?.querySelector('[data-filter-clear]');
  if (clear) clear.hidden = !q;
  const note = document.querySelector('[data-filter-note]');
  if (note) note.textContent = q ? `Showing ${shown} of ${rows.length}` : '';
}

function clearFilter(inp) {
  inp.value = '';
  applyFilter(inp);
  inp.focus();
}

document.addEventListener('input', (e) => {
  const inp = e.target;
  if (inp instanceof HTMLElement && inp.hasAttribute('data-filter')) applyFilter(inp);
});
document.addEventListener('click', (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest('[data-filter-clear]') : null;
  const inp = btn?.closest('.topbar-search')?.querySelector('[data-filter]');
  if (inp) clearFilter(inp);
});

const es = new EventSource('/stream?session=' + session);
es.addEventListener('op', (e) => {
  try { applyOp(JSON.parse(e.data)); } catch { /* ignore */ }
});

// ---- snackbar ---------------------------------------------------------------
// Every verb composes a sentence and the browser used to discard it, printing
// "Saved." at the foot of a form nobody was looking at any more. An archive is
// the case that made that plainly wrong: the record leaves the list, the drawer
// stays open showing it, and "Saved" is the wrong word for what happened.
//
// One live region, reused. `role="status"` + aria-live="polite" so a screen
// reader is told without stealing focus — a message that grabbed focus mid-task
// would be worse than the silence it replaces.
const SNACK_MS = 6000;

function snackHost() {
  let host = document.getElementById('snackbar');
  if (!host) {
    host = document.createElement('div');
    host.id = 'snackbar';
    host.className = 'snackbar';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

// A message that survives exactly one navigation.
//
// Archiving changes more than the row it removes: the "6 records" beside the title,
// the nav counts for Customers AND Tickets, the archived-view link that should now
// appear. Patching each of those from the client is a second source of truth that
// drifts; reloading makes the page server-truth again. So the sentence is parked
// first and shown by the page that comes back.
const SNACK_PENDING = 'steward.snack';

function snackLater(msg, ok = true) {
  try { sessionStorage.setItem(SNACK_PENDING, JSON.stringify({ msg, ok })); } catch { /* noop */ }
}

function drainSnack() {
  let raw = null;
  try { raw = sessionStorage.getItem(SNACK_PENDING); sessionStorage.removeItem(SNACK_PENDING); } catch { return; }
  if (!raw) return;
  try { const { msg, ok } = JSON.parse(raw); snack(msg, ok); } catch { /* noop */ }
}

function snack(msg, ok = true) {
  if (!msg) return;
  const host = snackHost();
  const item = document.createElement('div');
  item.className = 'snack';
  item.dataset.ok = String(ok);
  const text = document.createElement('span');
  text.textContent = msg; // textContent, not innerHTML: this carries record names
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'snack__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  const dismiss = () => { clearTimeout(timer); item.remove(); };
  close.addEventListener('click', dismiss);
  item.append(text, close);
  host.appendChild(item);
  // An error stays until it is read; a success is transient. Someone who needs to
  // copy a failure message should not be racing a timer to do it.
  const timer = ok ? setTimeout(dismiss, SNACK_MS) : 0;
}

function status(form, msg, ok) {
  let s = form.querySelector('.form-status');
  if (!s) { s = document.createElement('p'); s.className = 'form-status'; form.appendChild(s); }
  s.textContent = msg;
  s.dataset.ok = String(ok);
}

async function submitForm(form) {
  const fd = new FormData(form);
  const payload = {};
  for (const [k, v] of fd.entries()) payload[k] = v;
  const res = await fetch('/intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, screen: location.pathname, surface: 'screen', action: form.dataset.action, payload }),
  });
  if (res.status === 202) {
    let reply = '', dismiss = false;
    try { const b = await res.json(); reply = b.reply || ''; dismiss = !!b.dismiss; } catch { /* noop */ }
    // `dismiss` means the record has left the surface it was opened on — an archive or
    // a restore. The row goes over SSE, but the counts beside the title and in the rail
    // do not, and neither does the "N archived" link. Reload so everything agrees, and
    // park the sentence so the page that comes back is the one that tells the operator.
    if (dismiss) {
      window.grain?.drawer?.close();
      snackLater(reply || 'Done.', true);
      location.reload();
      return;
    }

    snack(reply || 'Saved.', true);
    if (form.dataset.mode === 'create') form.reset();

    // In the drawer, what to do next depends on WHAT was submitted:
    //  - edit of the record the page itself shows → reload (the page behind is stale)
    //  - edit of a record opened from a list      → back to its view panel
    //  - new-record form (no record open)         → close; its row arrives over SSE
    //  - a sub-form inside a record panel (add progress) → stay put; SSE appends it
    if (form.closest('.drawer')) {
      const path = drawer().dataset.recordPath;
      if (form.dataset.mode === 'edit') {
        // The reload wipes an on-screen snack, so this one is parked too.
        if (path && location.pathname !== path) loadPanel(path);
        else { snackLater(reply || 'Saved.', true); location.reload(); }
        return;
      }
      if (!path) window.grain?.drawer?.close();
    }
  } else {
    let msg = 'Error ' + res.status;
    try { const b = await res.json(); if (b.error) msg = b.error; } catch { /* noop */ }
    // Both: the snackbar is seen wherever you are, the inline status keeps the
    // message beside the field that caused it.
    snack(msg, false);
    status(form, msg, false);
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target;
  // A form with a real `action` posts to that URL itself (uploads carry bytes,
  // which the JSON door doesn't take) — leave it to the browser.
  if (form instanceof HTMLFormElement && form.classList.contains('fb')
      && !form.getAttribute('action') && form.dataset.action !== 'customer.search') {
    e.preventDefault();
    submitForm(form);
  }
});

// FormBuilder view→edit: swap the edit fragment into the drawer. Works both
// from a panel already open in the drawer and from a full detail page.
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const p = drawerParts(); if (!p) return;
  if (t.hasAttribute('data-form-edit')) {
    const path = p.d.dataset.recordPath || location.pathname;
    p.body.innerHTML = '<p class="muted">Loading…</p>';
    p.title.textContent = 'Edit';
    openDrawer(t);                 // a no-op when it is already the open drawer
    p.d.dataset.recordPath = path;
    p.body.innerHTML = await (await fetch(path + '/edit')).text();
    focusFirstField(p);
  } else if (t.hasAttribute('data-form-cancel')) {
    const path = p.d.dataset.recordPath;
    if (path) loadPanel(path, t); else window.grain?.drawer?.close();
  }
});

// --- Kanban drag: drop a card on a column → ticket.status intent -------------
function postIntent(action, payload) {
  return fetch('/intent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, screen: location.pathname, surface: 'screen', action, payload }),
  });
}

let dragId = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target instanceof HTMLElement ? e.target.closest('.kanban-card[draggable]') : null;
  if (!card) return;
  dragId = card.dataset.ticketId;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
document.addEventListener('dragend', (e) => {
  if (e.target instanceof HTMLElement) e.target.classList.remove('dragging');
  dragId = null;
});
document.addEventListener('dragover', (e) => {
  const col = e.target instanceof HTMLElement ? e.target.closest('.kanban-col') : null;
  if (col && dragId) { e.preventDefault(); col.classList.add('drop-target'); }
});
document.addEventListener('dragleave', (e) => {
  const col = e.target instanceof HTMLElement ? e.target.closest('.kanban-col') : null;
  if (col) col.classList.remove('drop-target');
});
document.addEventListener('drop', (e) => {
  const col = e.target instanceof HTMLElement ? e.target.closest('.kanban-col') : null;
  if (!col || !dragId) return;
  e.preventDefault();
  col.classList.remove('drop-target');
  const status = col.dataset.status;
  const card = document.querySelector(`[data-surface="ticket:${CSS.escape(dragId)}"]`);
  // No-op if dropped on the same column; server (SSE) performs the real move.
  if (status && card && card.dataset.status !== status) postIntent('ticket.status', { id: dragId, status });
  dragId = null;
});

// ---- theme controls: report which setting is current ------------------------
// GRAIN's theme.js owns the switching and records the choice on <html> (an unset
// attribute means "auto" / the first flavor). Settings only ever RENDERED the
// six buttons, so nothing said which one was on. This reads the attributes back;
// theme.js is loaded before this module and its click listener therefore runs
// first, so by the time this fires the attributes are already the new ones.
function syncThemeButtons() {
  const html = document.documentElement;
  const scheme = html.getAttribute('data-color-scheme') || 'auto';
  const flavors = (html.getAttribute('data-themes') || '').split(/\s+/).filter(Boolean);
  const flavor = html.getAttribute('data-theme') || flavors[0] || '';
  for (const [attr, current] of [['data-set-scheme', scheme], ['data-set-theme', flavor]]) {
    document.querySelectorAll(`[${attr}]`).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === current));
    });
  }
}
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('[data-set-scheme], [data-set-theme], [data-toggle-scheme]')) {
    syncThemeButtons();
  }
});
syncThemeButtons();

// Live search: type in the query box → customer.search intent → list replaced over SSE.
let searchTimer;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.name !== 'query') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    fetch('/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, screen: location.pathname, surface: 'screen', action: 'customer.search', payload: { query: t.value } }),
    });
  }, 200);
});

// A sentence parked by the page before this one — an archive, a restore, an edit that
// had to reload. Drained once, on arrival.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', drainSnack, { once: true });
} else {
  drainSnack();
}
