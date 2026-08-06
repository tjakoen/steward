// STEWARD panel tabs (0014): the behaviour half of the disclosure tabset that
// `panelTabs()` in app/view/html.ts renders.
//
// The look is GRAIN's `.tab` / `.tab-bar`. The MEANING is not: GRAIN's tab is an
// editor's open file, active by `aria-current="page"` and driven by
// `grain/scripts/tabs.js`, which is a localStorage projection of where you have
// been. STEWARD deliberately does not load that script — it would rewrite the
// strip on first paint and delete these tabs — and does not claim that meaning.
// It borrows the `data-active="true"` half of GRAIN's active-state rule, which is
// semantics-free, and supplies the disclosure semantics itself.
//
// Every listener is delegated from `document`, because the drawer's body is
// replaced wholesale on every panel load: anything bound to an element would be
// bound to an element that is no longer there.

const TABLIST = '[data-panel-tabs]';

const tabsIn = (list) => [...list.querySelectorAll('[role="tab"]')];
const paneFor = (tab) => document.getElementById(tab.getAttribute('aria-controls') ?? '');

/**
 * Keep the selected tab in view.
 *
 * The strip scrolls horizontally with an edge fade (GRAIN's `.tab-bar`), and the
 * drawer is a 28rem column — so a panel opened on a tab that is off the end would
 * otherwise show a selected tab nobody can see.
 */
function scrollIntoStrip(list, tab) {
  const strip = list.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (!strip.width || !box.width) return;
  if (box.left < strip.left) list.scrollLeft -= strip.left - box.left + 8;
  else if (box.right > strip.right) list.scrollLeft += box.right - strip.right + 8;
}

/**
 * Where the operator is, recorded so it survives the next thing that happens.
 *
 * Two different places, because there are two different kinds of "where". On a full
 * page the tab is part of the ADDRESS — a refresh, a bookmark and a link sent to
 * someone else should all land on the same pane. In the drawer there is no address
 * to speak of, so it is stashed on the drawer element, and `steward-live.js` reads
 * it back when Edit blows the panel away and Cancel has to put it back.
 */
function remember(list, tab) {
  const name = tab.dataset.tab || '';
  const drawer = list.closest('[data-drawer]');
  if (drawer) { drawer.dataset.recordTab = name; return; }

  const first = tabsIn(list)[0]?.dataset.tab;
  const url = new URL(location.href);
  // The default tab is what a bare URL already means; spelling it out would put
  // `?tab=details` in front of everyone who never touched a tab.
  if (name && name !== first) url.searchParams.set('tab', name);
  else url.searchParams.delete('tab');
  history.replaceState(history.state, '', url);
}

function select(list, tab, focus = false) {
  for (const t of tabsIn(list)) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    // Roving tabindex: exactly one tab is reachable by Tab, and the arrows move
    // between them. Get this wrong and a four-tab panel costs four Tab stops.
    t.tabIndex = on ? 0 : -1;
    if (on) t.setAttribute('data-active', 'true'); else t.removeAttribute('data-active');
    const pane = paneFor(t);
    // The `hidden` ATTRIBUTE, not a class and not opacity: GRAIN's drawer.js
    // recomputes its focus trap from `offsetParent !== null` on every Tab
    // keypress, so a hidden pane drops out of the trap for free.
    if (pane) pane.hidden = !on;
  }
  if (focus) tab.focus();
  scrollIntoStrip(list, tab);
  remember(list, tab);
}

const listFor = (target) => {
  const tab = target instanceof HTMLElement ? target.closest('[role="tab"]') : null;
  const list = tab?.closest(TABLIST);
  return list ? { list, tab } : null;
};

document.addEventListener('click', (e) => {
  const found = listFor(e.target);
  if (found) select(found.list, found.tab);
});

// ← → move, Home/End jump to the ends, and arrowing to a tab SELECTS it
// (automatic activation). That is the right choice here and only here: every pane
// is already in the DOM, so switching costs nothing — with lazy panes it would
// fire a request per keypress and manual activation would be the answer instead.
document.addEventListener('keydown', (e) => {
  const found = listFor(e.target);
  if (!found) return;
  const tabs = tabsIn(found.list);
  const i = tabs.indexOf(found.tab);
  let next = null;
  if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  else return;
  e.preventDefault();
  if (next) select(found.list, next, true);
});

/**
 * The server already rendered the right tab selected and the rest hidden — this is
 * only the one thing markup cannot do, which is scroll a strip that overflows.
 * Runs on load and again whenever the drawer takes on a new panel.
 */
function mount() {
  for (const list of document.querySelectorAll(TABLIST)) {
    const current = list.querySelector('[aria-selected="true"]') ?? tabsIn(list)[0];
    if (current) scrollIntoStrip(list, current);
  }
}

document.addEventListener('steward:panel-loaded', mount);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
