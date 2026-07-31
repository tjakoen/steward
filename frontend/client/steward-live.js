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
}

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

// FormBuilder view↔edit toggle: fetch the edit fragment, swap it in place.
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.hasAttribute('data-form-edit')) {
    const host = document.querySelector('[data-surface="customer-detail"]');
    if (host) host.innerHTML = await (await fetch(location.pathname + '/edit')).text();
  } else if (t.hasAttribute('data-form-cancel')) {
    location.reload();
  }
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
