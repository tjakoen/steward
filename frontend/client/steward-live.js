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
// Counts VISIBLE cards so an active filter shows filtered totals.
function refreshBoardCounts() {
  document.querySelectorAll('.board-col').forEach((col) => {
    const count = col.querySelector('.count');
    const cards = col.querySelector('.cards');
    if (count && cards) count.textContent = String([...cards.children].filter((c) => !c.hidden).length);
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
function openDrawer(title) {
  const p = drawerParts(); if (!p) return;
  if (title) p.title.textContent = title;
  p.d.hidden = false;
  const f = p.d.querySelector('input, select, textarea'); if (f) f.focus();
}
function closeDrawer() {
  const p = drawerParts(); if (!p) return;
  p.d.hidden = true;
  delete p.d.dataset.recordPath;
}

// The create form ships inside the drawer; stash it so "+ New" can restore it
// after the drawer has been used to view or edit a record.
let createHTML = null, createTitle = '';
(() => { const p = drawerParts(); if (p) { createHTML = p.body.innerHTML; createTitle = p.title.textContent; } })();

async function loadPanel(path) {
  const p = drawerParts(); if (!p) return;
  p.body.innerHTML = '<p class="muted">Loading…</p>';
  p.d.dataset.recordPath = path;
  openDrawer('Details');
  p.body.innerHTML = await (await fetch(path + '/panel')).text();
  const marker = p.body.querySelector('[data-panel-title]');
  if (marker) p.title.textContent = marker.getAttribute('data-panel-title');
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.closest('[data-drawer-close]') || t.classList.contains('drawer__backdrop')) { closeDrawer(); return; }
  if (t.closest('[data-drawer-open]')) {
    const p = drawerParts();
    if (p && createHTML !== null) {
      p.body.innerHTML = createHTML;
      p.title.textContent = createTitle;
      delete p.d.dataset.recordPath;
    }
    openDrawer();
    return;
  }
  // A record row / board card opens its panel — but let modified clicks and
  // links inside the drawer (PDF, "open full page") behave normally.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const rec = t.closest('[data-href]');
  if (rec && !t.closest('.drawer')) {
    e.preventDefault();
    loadPanel(rec.getAttribute('data-href'));
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---- instant client-side filter (topbar box filters a table body or board) -
document.addEventListener('input', (e) => {
  const inp = e.target;
  if (!(inp instanceof HTMLElement) || !inp.hasAttribute('data-filter')) return;
  const scope = document.querySelector(inp.getAttribute('data-filter'));
  if (!scope) return;
  const q = inp.value.trim().toLowerCase();
  scope.querySelectorAll('tr.row, li.card').forEach((r) => {
    r.hidden = q ? !r.textContent.toLowerCase().includes(q) : false;
  });
  refreshBoardCounts();
});

const es = new EventSource('/stream?session=' + session);
es.addEventListener('op', (e) => {
  try { applyOp(JSON.parse(e.data)); } catch { /* ignore */ }
});

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
    status(form, 'Saved.', true);
    if (form.dataset.mode === 'create') form.reset();
    // In the drawer, what to do next depends on WHAT was submitted:
    //  - edit of the record the page itself shows → reload (the page behind is stale)
    //  - edit of a record opened from a list      → back to its view panel
    //  - new-record form (no record open)         → close; its row arrives over SSE
    //  - a sub-form inside a record panel (add progress) → stay put; SSE appends it
    if (form.closest('.drawer')) {
      const path = drawer().dataset.recordPath;
      if (form.dataset.mode === 'edit') {
        if (path && location.pathname !== path) loadPanel(path);
        else location.reload();
        return;
      }
      if (!path) closeDrawer();
    }
  } else {
    let msg = 'Error ' + res.status;
    try { const b = await res.json(); if (b.error) msg = b.error; } catch { /* noop */ }
    status(form, msg, false);
  }
}

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.classList.contains('fb') && form.dataset.action !== 'customer.search') {
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
    openDrawer('Edit');
    p.d.dataset.recordPath = path;
    p.body.innerHTML = await (await fetch(path + '/edit')).text();
  } else if (t.hasAttribute('data-form-cancel')) {
    const path = p.d.dataset.recordPath;
    if (path) loadPanel(path); else closeDrawer();
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
  const card = e.target instanceof HTMLElement ? e.target.closest('.card[draggable]') : null;
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
  const col = e.target instanceof HTMLElement ? e.target.closest('.board-col') : null;
  if (col && dragId) { e.preventDefault(); col.classList.add('drop-target'); }
});
document.addEventListener('dragleave', (e) => {
  const col = e.target instanceof HTMLElement ? e.target.closest('.board-col') : null;
  if (col) col.classList.remove('drop-target');
});
document.addEventListener('drop', (e) => {
  const col = e.target instanceof HTMLElement ? e.target.closest('.board-col') : null;
  if (!col || !dragId) return;
  e.preventDefault();
  col.classList.remove('drop-target');
  const status = col.dataset.status;
  const card = document.querySelector(`[data-surface="ticket:${CSS.escape(dragId)}"]`);
  // No-op if dropped on the same column; server (SSE) performs the real move.
  if (status && card && card.dataset.status !== status) postIntent('ticket.status', { id: dragId, status });
  dragId = null;
});

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
