// 0014 — the markup for the panel tabset and the facet bar.
//
// `tsc` cannot see a tablist. It cannot see that exactly one pane is visible, that the ids
// pair up, that only one tab is in the Tab order, or that STEWARD is wearing GRAIN's class
// rather than redefining it. Those are the failures this file exists to catch, because the
// alternative is catching them in a browser — which 0013 proved is where they hide.

import { test, expect } from 'bun:test';
import {
  facetBar, facetChips, facetDate, facetSelect, panelTabs, resolveTab, tableFilteredEmpty,
  type PanelTab,
} from './html.ts';

const tabs = (): PanelTab[] => [
  { id: 'details', label: 'Details', body: '<p>D</p>' },
  { id: 'documents', label: 'Documents', body: '<p>F</p>' },
  { id: 'history', label: 'History', body: '<p>H</p>' },
];

// ---- which tab -------------------------------------------------------------

test('an unknown, empty or missing ?tab= falls back to the first tab', () => {
  // A panel with every pane hidden is a blank drawer, which reads as a broken app rather
  // than as a bad link.
  expect(resolveTab(tabs(), 'history')).toBe('history');
  expect(resolveTab(tabs(), 'HISTORY')).toBe('history');
  expect(resolveTab(tabs(), 'nonsense')).toBe('details');
  expect(resolveTab(tabs(), '')).toBe('details');
  expect(resolveTab(tabs(), null)).toBe('details');
  expect(resolveTab(tabs(), undefined)).toBe('details');
  expect(resolveTab([], 'x')).toBe('');
});

// ---- the tablist -----------------------------------------------------------

test('the strip wears GRAIN classes and claims none of its own', () => {
  const html = panelTabs('ticket-1', tabs(), 'details');
  expect(html).toContain('class="tab-bar panel-tabs"');
  expect(html).toContain('class="tab"');
  // GRAIN's tab means an editor's open FILE, active by aria-current. This is a disclosure
  // tabset; claiming the navigation meaning would be a lie to every screen reader.
  expect(html).not.toContain('aria-current');
  // A tab discloses a pane, so it is a button — and a button that is not a submit.
  expect(html).toContain('<button type="button" class="tab" role="tab"');
});

test('exactly one tab is selected, exactly one pane is visible', () => {
  const html = panelTabs('ticket-1', tabs(), 'documents');
  expect([...html.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  expect([...html.matchAll(/aria-selected="false"/g)]).toHaveLength(2);
  // `data-active` is the semantics-free half of GRAIN's own active rule — the look, with
  // no claim attached — so it rides exactly with the selection and nowhere else.
  expect([...html.matchAll(/data-active="true"/g)]).toHaveLength(1);
  expect([...html.matchAll(/ hidden>/g)]).toHaveLength(2);
  expect(html).toContain('id="ticket-1-pane-documents" aria-labelledby="ticket-1-tab-documents" tabindex="0">');
});

test('roving tabindex: a tablist is ONE stop in the Tab order', () => {
  const html = panelTabs('ticket-1', tabs(), 'history');
  // Getting this wrong is the difference between one Tab stop and three.
  expect([...html.matchAll(/tabindex="0" data-tab/g)]).toHaveLength(1);
  expect([...html.matchAll(/tabindex="-1" data-tab/g)]).toHaveLength(2);
});

test('every aria-controls points at a pane that exists, and back again', () => {
  const html = panelTabs('client-abc', tabs(), 'details');
  for (const [, id] of html.matchAll(/aria-controls="([^"]+)"/g)) {
    expect(html).toContain(`id="${id}"`);
  }
  for (const [, id] of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
    expect(html).toContain(`id="${id}"`);
  }
});

test('ids are per RECORD, because a drawer and a page can hold two of them', () => {
  const a = panelTabs('ticket-aaa', tabs(), 'details');
  const b = panelTabs('ticket-bbb', tabs(), 'details');
  expect(a).toContain('id="ticket-aaa-tab-details"');
  expect(b).toContain('id="ticket-bbb-tab-details"');
  expect(a).not.toContain('ticket-bbb');
});

test('a record id reaches the ids escaped', () => {
  const html = panelTabs('client-<script>', tabs(), 'details');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

test('one section is not a tabset — the panes render bare', () => {
  // A document's panel is one thing; a tab strip over a single pane is chrome that
  // discloses nothing.
  const html = panelTabs('doc-1', [{ id: 'details', label: 'Details', body: '<p>only</p>' }], 'details');
  expect(html).toBe('<p>only</p>');
  expect(panelTabs('doc-1', [], null)).toBe('');
});

// ---- facets ----------------------------------------------------------------

test('a chip group is GRAIN\'s fieldset, with the real input inside the label', () => {
  const html = facetChips('status', 'Status',
    [{ value: 'Waiting', label: 'Waiting', count: 7 }, { value: 'Completed', label: 'Completed', count: 0 }],
    ['Waiting']);
  expect(html).toContain('<fieldset class="chips" data-select="multi" aria-label="Status">');
  expect(html).toContain('<label class="chips__chip"><input type="checkbox" name="status" value="Waiting" checked>');
  expect(html).toContain('value="Completed"><span>Completed');
  expect(html).not.toContain('value="Completed" checked');
  // The count is the reason facets are a server round trip: "Waiting (7)" cannot be
  // computed from rows the page never received.
  expect(html).toContain('<span class="facets__count">7</span>');
  expect(html).toContain('<span class="facets__count">0</span>');
  // A <legend> inside a display:flex fieldset is laid out by the UA outside the flex flow
  // and lands among the pills; the name is a sibling and an aria-label instead.
  expect(html).not.toContain('<legend');
});

test('a single-select facet is radios, and the current value comes back checked', () => {
  const html = facetChips('scope', 'Show',
    [{ value: 'live', label: 'Live' }, { value: 'archived', label: 'Archived' }], ['archived'], false);
  expect(html).toContain('data-select="single"');
  expect(html).toContain('type="radio" name="scope" value="archived" checked');
  expect(html).toContain('type="radio" name="scope" value="live"><span>');
});

test('a select facet offers "all" first and marks the current one', () => {
  const html = facetSelect('clientId', 'Client',
    [{ value: 'c1', label: 'Acme' }, { value: 'c2', label: 'Beta' }], 'c2', 'All clients');
  expect(html).toContain('<option value="">All clients</option>');
  expect(html).toContain('<option value="c2" selected>Beta</option>');
  expect(html).toContain('<label class="facets__label" for="facet_clientId">Client</label>');
  // Nothing to pick from is not a facet.
  expect(facetSelect('clientId', 'Client', [], '', 'All')).toBe('');
});

test('the bar is a GET form, and Clear appears only when there is something to clear', () => {
  const groups = facetChips('scope', 'Show', [{ value: 'live', label: 'Live' }], ['live'], false);
  const off = facetBar('facets', '/clients', groups, false);
  expect(off).toContain('<form class="facets" id="facets" method="get" action="/clients">');
  // A real submit button, so a checked chip and a press works with JavaScript switched
  // off entirely — the claim the whole server-side decision rests on.
  expect(off).toContain('<button type="submit"');
  expect(off).not.toContain('facets__clear');

  const on = facetBar('facets', '/clients', groups, true);
  expect(on).toContain('<a class="linkish facets__clear" href="/clients">Clear filters</a>');
  // No facets on this surface, no bar.
  expect(facetBar('facets', '/clients', '', true)).toBe('');
});

test('a date bound is a real date input carrying its value back', () => {
  expect(facetDate('from', 'From', '2026-08-01'))
    .toContain('<input id="facet_from" type="date" name="from" value="2026-08-01"');
});

test('the filtered-empty row names the way out', () => {
  const row = tableFilteredEmpty(4);
  expect(row).toContain('colspan="4"');
  // Clear and Escape both already existed and went unmentioned at exactly the moment they
  // were needed. "0 of 2" is not a sentence anyone can act on.
  expect(row).toContain('Escape');
  expect(row).toContain('Clear');
  expect(row).toContain('class="dtable-none"');
});
