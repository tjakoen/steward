---
id: 0014-tabs-and-filtering
title: STEWARD — tabs in the panel, and a filter that is more than a box that hides rows
status: todo
owner: admin
created: 2026-08-04
milestone: M3 (ship it)
tags: [tabs, filtering, facets, grain, accessibility, drawer, sse]
tasks:
  - id: tabs-markup
    title: panelTabs() — GRAIN's `.tab` worn by a real tablist, and not one line of new CSS
    status: todo
  - id: tabs-behaviour
    title: steward-tabs.js — click, arrow keys, roving tabindex, and `?tab=` as the seam
    status: todo
  - id: panel-panes
    title: Split the three panels into panes without breaking one-builder-two-places
    status: todo
  - id: list-query
    title: The repository read stops being positional — ListScope grows into a query
    status: todo
  - id: facet-bar
    title: The facets — GRAIN's chip-group, a GET form, and a URL you can send to someone
    status: todo
  - id: list-routes
    title: The four lists read the query, and say out loud what they left out
    status: todo
  - id: filter-live
    title: The topbar box becomes a refinement, and an SSE append stops lying about it
    status: todo
  - id: activity-facets
    title: Activity — where the 200-row cap makes today's filter quietly dishonest
    status: todo
  - id: verify
    title: The gate — tsc cannot see a tablist, and the browser pass is the whole test
    status: todo
---

# STEWARD — tabs and filtering (0014)

The human's sixth and seventh wants, verbatim in substance: *tabs in the side panel and the full
page — e.g. for attachments and history*, and *better filtering, not just a search bar*.

Third in the confirmed order (`plans/BACKLOG.md`), after `0013` and `0012`. That order is not
arbitrary: `0012` is the plan that puts a visibility predicate into the repository's SQL, and
`0014` is the plan that turns that predicate into one facet among several. It says so itself —
"real filtering is `0014`'s job and it will want archived-vs-live as one facet among several;
building a filter framework here would be `0014` arriving early and badly"
(`plans/0012-archive-restore.md`). This plan honours that handoff and does not re-open it.

## What 0012 actually handed over, which is not what 0012 wrote down

Read this before writing a line, because the plan document and the code disagree. `0012`'s prose
promised "one `archived?: boolean` argument on the repository read, defaulting to live". What the
implementation shipped is a **three-valued `ListScope = 'live' | 'archived' | 'all'`**
(`app/domain/types.ts:62`), compiled to SQL once in `scopeSql` (`app/repo/sqlite.ts:64`) and
threaded through `clients.list(scope)` (`app/repo/sqlite.ts:90`),
`customers.list(clientId?, scope)` (`:136`), `customers.search(query, scope)` (`:149`) and
`tickets.list(customerId?, scope)` (`:194`).

Three values, not two, and it is the better shape: a boolean cannot express "show me everything",
and `all` is what an audit-shaped question wants. Take it as given. What is **not** given is the
calling convention, and that is this plan's first structural job — see `list-query` below.

## Tabs: GRAIN already has one, and it is the wrong one, and it still fits

The backlog records that "the drawer is GRAIN's organism (adopted in `f5ef0b3`); it has no tab
molecule." That is half right and the other half decides the whole task. GRAIN ships a **`tab`
molecule** (`node_modules/@tjakoen/grain/components/molecules/tab/`) and a **`tab-bar` organism**
(`…/organisms/tab-bar/`). Both are already on every STEWARD page: `/components.css` concatenates
every stylesheet under `components/` (`app/assets/serve.ts:53`, served at `server.ts:1605`, linked
at `server.ts:179`) — the same recursive set `app/view/css.test.ts:70-74` walks. So the CSS for tabs
is bytes STEWARD is already paying for and not using.

What GRAIN's tab *means* is an editor's open-file tab: a navigation link, active by
`aria-current="page"`, closable, driven by `grain/scripts/tabs.js`, which is a localStorage
projection of where you have been. That script is opt-in via `data-open-tabs` and STEWARD does not
load it (`PAGE_ASSETS`, `server.ts:181-190`). **Do not load it.** It would rewrite the strip out of
localStorage and delete the panes' tabs on first paint.

But the *box* is exactly right, and — this is the decisive detail — GRAIN's active-state rule is

```css
.tab[aria-current="page"], .tab[data-active="true"] { … }
```

`data-active="true"` is a **semantics-free hook**. So STEWARD wears `.tab` for the look and
`role="tab" aria-selected="true" data-active="true"` for the meaning, and the two never argue.
No `aria-current` (this is not navigation), no new CSS for the active state, no collision.

**Decision: adopt GRAIN's `.tab` and `.tab-bar` for a disclosure tabset; do not build a STEWARD
tabs molecule, and do not upstream a `tabset` to GRAIN in this plan.** Upstreaming is the
theoretically correct answer — a disclosure tabset genuinely is a different molecule from an
editor tab — but it costs a GRAIN release the human has to cut, and everything that would go into
it is one class name and one script. Revisit it when a second consumer wants the same thing; it is
in the open questions at the foot of this plan, not silently dropped.

### The house rule this has to respect

`app/view/css.test.ts` fails on **any** class name defined in both stylesheets, and
`ADOPTED_ANYWAY` is deliberately empty ("the doctrine is that it stays empty", `:22`). So
STEWARD may not define `.tab`, `.tab-bar`, `.tab__icon`, `.tab__close`, `.tab__pin` or
`.tab-bar__close-all`. It tunes a GRAIN component by **wearing a second class of its own**, which
is the pattern already in the file three times over: `.dtable` beside `data-table`
(`frontend/client/steward.css:153-168`), `.filter-box`/`.filter-clear` beside `topbar-search` (`:57`),
`.chip` beside GRAIN's `.chips` (`:298`).

So: `<nav class="tab-bar panel-tabs" role="tablist">`, and `.panel-tabs` / `.panel-pane` are
STEWARD's. Neither name exists in GRAIN; the guard will confirm it.

**The trap, and it will look like the tabs are simply broken.** GRAIN's `.tab` was designed for an
`<a>`: it sets `text-decoration`, `color` and a font, and assumes no UA chrome. A tab in a tabset
must be a `<button type="button">`, because it discloses a pane rather than navigating. A
`<button class="tab">` therefore arrives wearing the browser's button border, background and
system font, *underneath* GRAIN's declarations, and looks nothing like the strip beside it. The fix
is the one GRAIN itself uses for the same problem — `all: unset` then rebuild the box, exactly as
`.tab-bar__close-all` does (`tab-bar.css`). Put it in `.panel-tabs button`, and note that
`all: unset` resets `display` to `inline`, so restate it.

### Accessibility, concretely

The drawer is already a real modal — `role="dialog"`, `aria-modal="true"` on the panel
(`server.ts:284`), the rest of the body `inert`, Tab trapped and focus handed back, all of it
GRAIN's `scripts/drawer.js`. Tabs inside a modal have to be as correct as the modal, or the panel
gets *less* accessible than the long scroll it replaced.

- `<nav class="tab-bar panel-tabs" role="tablist" aria-label="Record sections">`.
- Each tab: `<button type="button" class="tab" role="tab" id="…-tab-history"
  aria-controls="…-pane-history" aria-selected="false" tabindex="-1">`.
- Each pane: `<section class="panel-pane" role="tabpanel" id="…-pane-history"
  aria-labelledby="…-tab-history" tabindex="0" hidden>`.
- **Roving tabindex.** Exactly one tab is `tabindex="0"` — the selected one — and the rest are
  `-1`. A tablist is one stop in the Tab order; ← → move between tabs, Home/End jump to the ends.
  Getting this wrong is the difference between one Tab stop and five.
- **Automatic activation**: arrowing to a tab selects it. Correct here because switching costs
  nothing — every pane is already in the DOM.
- The ids must be **unique per record**, because a drawer and a full page can hold panels for
  different records in one session and the drawer's body is replaced wholesale. Derive them from
  the record id the panel already has.

Three things fall out of the scripts that are worth knowing before someone re-derives them:

- `focusables()` in `scripts/drawer.js:41` filters on `offsetParent !== null` and is recomputed on
  **every** Tab keypress. So a pane hidden with the `hidden` attribute drops out of the focus trap
  for free, and one hidden with `opacity` or `visibility` does not. **Hide panes with `hidden`** —
  which is also GRAIN's own state convention (`drawer.md`: "State is the plain `hidden` attribute,
  not a class") and what `sidebar-panel` does for its modes.
- `focusFirstField()` (`frontend/client/steward-live.js:64`) takes the first
  `input:not([type=hidden]), select, textarea` in the drawer body and focuses it. `querySelector`
  **finds hidden elements**, and `.focus()` on a hidden one silently does nothing — so focus stays
  on the close button and it reads as the drawer simply not focusing anything. It is called on the
  `+ New` create path (`steward-live.js:108`) and on the Edit path (`:255`), neither of which is
  tabbed here — but the moment a pane holds a form, this function has to learn to skip hidden
  elements. Fix it in `panel-panes` rather than leaving it as a landmine.
- **Edit blows the panel away, and Cancel puts back the wrong tab.** `data-form-edit`
  (`steward-live.js:248-255`) replaces the entire drawer body with the `/edit` fragment — tablist
  included — and `data-form-cancel` (`:256-258`) calls `loadPanel(path)`, which re-fetches
  `path + '/panel'` with no query. Without care, editing from the History tab and cancelling lands
  the operator on Details. `loadPanel` must carry the tab, which is the second reason `?tab=` is a
  real parameter and not a client-side toggle.

### Which tabs, and why the panel builder must not fork

The single most important property in this area is stated in the code itself, at `server.ts:352`:
"ONE builder per record kind, rendered in two places: the slide-in drawer (row click →
`/…/:id/panel` fragment) and the standalone detail page (deep link / refresh). Same markup both
ways, so the two can't drift." `clientPanel` (`server.ts:479`), `customerPanel` (`:490`),
`ticketPanel` (`:509`) and `documentPanel` (`:541`) each take an `inDrawer` flag that changes
exactly one thing — the "Open full page ↗" link (`fullPageLink`, `:430`).

**Tabs must not become a second axis on that flag.** The panes are the same in both places; the
drawer is a 28rem column (`min(28rem, 100vw)`, `drawer.css`) and the page is wide, and that is a
CSS problem, not a markup problem. The `.tab-bar` already scrolls horizontally with an edge fade,
so four tabs in 28rem degrade correctly with nothing to write.

The sections that exist today, and which of them become tabs:

| Panel | Sections today | Tabs |
|---|---|---|
| Client (`server.ts:479`) | view form, Logo (`logoSection`, `:449`), Customers chips, Documents (`documentsSection`, `:403`), History (`historySection`, `:395`) | **Details** (form + logo + customers) · **Documents** · **History** |
| Customer (`:490`) | lineage, view form, Tickets chips, Documents, History | **Details** · **Documents** · **History** |
| Ticket (`:509`) | lineage, view form, Progress log + add-update form, Documents, History | **Details** · **Progress** · **Documents** · **History** |
| Document (`:541`) | preview, download/remove | **no tabs** — one thing, one pane |

`panelMeta` (`:350`) and `lineage` (`:362`) stay **above** the tablist. They are the record's
identity, not a section of it, and burying the lineage in a Details tab would hide the answer to
"where am I" behind a click.

**Decision: every pane is rendered server-side in the one response; tabs do not lazy-load.** The
alternative — a `/…/:id/panel/history` route per tab — is how a bigger app would do it, and it is
wrong here for two reasons. It forks the single builder into one route per section, which is
exactly the drift the comment at `server.ts:352` exists to prevent. And the content is not
expensive: `audit.forEntity` and `documentsFor` are indexed SQLite reads against a local file, and
the panel already performs both on every open. The cost is a larger fragment, and a larger
fragment over localhost is not a cost.

**`?tab=` is the seam that makes this honest.** The panel builder takes the active tab name, the
routes read `?tab=` (`/clients/:id`, `/clients/:id/panel`, and the same three pairs), and the
default is `details`. Three things become true at once: a link into a record's history is a real
URL, the drawer's "Open full page ↗" can carry the tab the operator is looking at, and the AI can
land on a tab through GRAIN's existing `navigate` op without a new verb. `loadPanel`
(`steward-live.js:86`) currently builds `path + '/panel'` and must learn to carry the query.

## Filtering: the box hides rows that are already there, which is the whole problem

Today, filtering is one client-side input in the topbar. `ShellOpts.filter`
(`server.ts:242`) is `{ target: string; placeholder?: string }`, the box is rendered at
`server.ts:262-266`, and `applyFilter` (`frontend/client/steward-live.js:151`) does the work:

```js
const rows = scope.querySelectorAll('tr.row, li.kanban-card, li.audit__row');
rows.forEach((r) => { r.hidden = q ? !r.textContent.toLowerCase().includes(q) : false; … });
```

Five surfaces pass a `target`: `[data-surface="client-list"]` (`server.ts:946`),
`[data-surface="customer-list"]` (`:1019`), `.kanban` (`:1063`),
`[data-surface="document-list"]` (`:1208`) and `.audit` (`:1334`).

Credit where it is due: it is honest about being a filter — `.filter-note` says "Showing 3 of 12",
Escape and a Clear button are the ways out, and the kanban's empty-state ships on every column so a
column the filter emptied says the same thing an empty one does (`app/view/html.ts:237-254`). None
of that is thrown away.

What it cannot do is the ask. It is substring-matching `textContent`, so `filter: waiting` matches
a ticket whose *summary* contains the word. It cannot express "waiting tickets for this client". It
cannot survive a reload, cannot be sent to anyone, and cannot be reached by the AI. And it cannot
filter what was never sent.

### Server or client — the decision, with the reason

**Decision: facets are a server round trip; the text box stays client-side and becomes a
refinement *within* the server's answer. Both, layered, with the server as the source of truth.**

The reasons, in the order they matter:

1. **A filter that is a URL is a filter you can send, bookmark, reload into, and hand to the AI.**
   GRAIN's dispatcher already has a `navigate` op with an href validator
   (`isSafeNavigateHref`, `@tjakoen/grain/ai/contract.ts:218`), so `/tickets?status=Waiting` is
   reachable by the reasoner the moment it exists, with no new action, no new surface kind, and no
   entry in `STEWARD_ACTIONS`. A DOM state nobody can name is reachable by nothing.
2. **The predicate already lives in SQL and it is the only place it is safe.** `0012` put
   `scopeSql` in the repository precisely because "there are a dozen callers and every one that
   forgot would be a leak" (`app/repo/sqlite.ts:55-63`). A second filtering mechanism in the
   browser, over the same rows, is that argument run backwards.
3. **It cannot filter what was never sent, and one surface is already past that line.**
   `/activity` renders `audit.recent(200)` (`server.ts:1335`) and then filters the DOM. Type a
   customer's name and the note says "Showing 3 of 200" — which reads as three matches in the
   audit trail, and is three matches in the *most recent two hundred rows*. That is a wrong answer
   delivered confidently, and it is checkable today. `customers.search` is capped at
   `LIMIT 50` (`app/repo/sqlite.ts:149-156`) for the same reason and is not wired to any list.
4. **Facet counts need the whole set.** "Waiting (7)" cannot be computed from rows the page did not
   receive, and a facet bar without counts is a guessing game.

And the reason the text box stays: typing should narrow **instantly**, with no round trip, and the
existing behaviour is good. So the box gets `name="q"` and lives inside the facet form. Typing
narrows what is on screen; **Enter submits**, the URL gains `?q=…`, and the server re-queries.
That also gives the box a zero-JS existence for the first time.

The note has to stop being ambiguous when both are live. `Showing 3 of 12` where 12 was already a
filtered set is a lie by omission. Make it name the whole: `3 of 12 shown · 12 of 47 match the
filters`.

### The repository read stops being positional

`customers.list(clientId?, scope?)` and `tickets.list(customerId?, scope?)`
(`app/repo/ports.ts:35,46`) already carry two optional positional arguments, and this plan wants
four or five more. `list(undefined, 'live', undefined, 'Waiting')` is a bug waiting to be typed.

**Decision: one options object per repository read, `scope` folded into it, defaulting to `live`.**

```ts
interface ClientQuery   { scope?: ListScope; q?: string }
interface CustomerQuery { scope?: ListScope; clientId?: string; q?: string }
interface TicketQuery   { scope?: ListScope; clientId?: string; customerId?: string;
                          status?: TicketStatus[]; q?: string }
```

Keep `scopeSql` exactly as `0012` wrote it and compose the rest of the `WHERE` beside it — the
same function, more clauses, still one place. `tickets` already joins customers **and** clients for
the descent rule (`app/repo/sqlite.ts:194-203`), so `clientId` on a ticket query is a predicate on
a join that is already there and costs nothing.

Two consequences to handle rather than discover:

- **`byStatus()` (`app/repo/ports.ts:48`) takes no scope and calls `this.list()` internally.** It
  is correct today only because the default is `live`. Give it the same query object, or the board
  and the facet counts will disagree the first time anyone asks for an archived view.
- **`q` is `LIKE`, not full-text.** `customers.search` already establishes the shape —
  `lower(col) LIKE ?` over a few columns (`app/repo/sqlite.ts:149-156`). Do the same and do not
  reach for FTS5; a workspace this size does not need an index and adding one is a migration.

### The facet control is GRAIN's, and STEWARD is already wearing half of it

`chip-group` (`node_modules/@tjakoen/grain/components/molecules/chip-group/chip-group.md`) opens
with: *"A set of selectable pills acting as a form control (single- or multi-select) — a filter
bar / tag picker / facet control. Native inputs → zero JS, form-postable, keyboard + AX for
free."* It is the facet bar, already written, already shipped in `/components.css`.

The markup is a `<fieldset class="chips" data-select="multi">` of
`<label class="chips__chip"><input type="checkbox" …><span>…</span></label>`. The native input is
sr-only rather than `display: none` — which is what keeps it keyboard-operable — and the checked
state is `:has(:checked)`. Nothing to write.

**One thing to be careful about, because it is already true in this codebase.** STEWARD uses
`.chips` as the layout row for a `<div>` of `<a class="chip">` links (`server.ts:361`), noted in
`frontend/client/steward.css:298`: "GRAIN's chip-group supplies the row (`.chips`); `.chip` is
STEWARD's own." So `.chips` is doing double duty — a flex-wrap row for links in the panels, and a
real fieldset in the facet bar. That is legal and the collision guard is satisfied, but a rule
written for one will land on the other. Scope any facet-bar tuning under a STEWARD class on the
form, not under `.chips`.

The bar is a plain `<form method="get">` around the facet fieldsets and the text box, with a real
submit button. Checking a chip and pressing the button reloads with a new URL. That works with no
JavaScript at all, which is the BREAD-stack answer and also the reason this does not need a new
client module.

### The facets, per surface

- **`/clients`** — scope (Live · Archived · All). Little else exists to facet on; a client has a
  name, a code and branding.
- **`/customers`** — scope, and **client**. "Show me this client's customers" is the question the
  client detail page already answers by hand (`server.ts:480`), and this makes it addressable.
- **`/tickets`** — scope, **status** (multi-select; the enum is `TICKET_STATUSES`,
  `app/domain/types.ts`), **client**, and **customer**. Status is the one that earns counts,
  because `byStatus()` already computes them.
- **`/files`** — **source** (`upload` · `generated` · `link`) and **storage** (`local` · `drive`),
  both fields on `DocumentRef` (`app/domain/types.ts:124-125`). `source` is already a badge on
  every row (`server.ts:1205`); `storage` is on the record and shown nowhere, which is why "which
  of my files are not in Drive" is currently an unanswerable question. **No scope facet**: `0012`
  decided `/files` must not hide
  archived records' documents, "the documents are still real files in Drive; a document list that
  silently shortens is worse than one that shows where a file came from."
- **`/activity`** — see below; it is its own task.

The nav counts (`server.ts:211-216`) stay **totals**. A rail that changed when you filtered a list
would make the workspace look like it shrank.

### The Archived view is a facet, not a page

`0012` ships `/clients?archived=1` as "deliberately the cheap version". This plan absorbs it:
`?scope=archived` becomes one value of the scope facet, `archived=1` keeps working as an alias so
nothing that was linked breaks, and the "N archived" link `0012` puts on the live list becomes a
pre-set facet URL rather than a separate route. The Restore button and the archived badge are
`0012`'s and are not touched.

### The SSE append, and the row that should not be there

This is the interaction the ask does not mention and the one most likely to ship broken.

`applyOp` (`frontend/client/steward-live.js:11-27`) inserts server-pushed HTML at a
`data-surface` and then calls `refreshBoardCounts()`. It never re-runs `applyFilter`. So today,
with a filter typed, a ticket created in another tab appears in the board **regardless of the
query**, and `.filter-note` keeps showing the count it computed before. That is a live bug, not a
new risk.

Two halves, two answers:

- **The text filter is the client's own and the client can re-apply it.** After every op, re-run
  `applyFilter` for any `[data-filter]` box holding a value. Cheap, exactly correct, and it fixes
  the existing bug.
- **The server's facets are not the client's to re-evaluate.** The server generating the op does
  not know each viewer's query — the ops go to every session on `/stream`. A row that arrives into
  a facet-filtered list may not belong there, and the markup does not always carry enough to tell:
  a kanban card has `data-status` (`app/view/html.ts:227-228`) but a client row carries only
  `data-surface="client:<id>"` (`:179`). **Do not guess.** When the URL carries any facet and an
  op lands in the filtered surface, show a one-line "1 record changed — reload to re-apply the
  filters" notice beside the filter note, with the reload as a link. Honest, one line of state, and
  it never shows a row the operator asked not to see while pretending the list is current.

Two smaller things in the same area:

- **`refreshBoardCounts` counts visible cards** (`steward-live.js:33-39`) so that a filtered board
  shows filtered totals. Under server-side facets the column count is *already* the filtered count
  and the page head's "N tickets" (`server.ts:1068`) is the total. Those two numbers sitting on the
  same screen with no explanation is the same dishonesty `.filter-note` was invented to fix — make
  the page head state the pair.
- **The board's filter target is `.kanban`, a class, not a `data-surface`** (`server.ts:1070`), and
  the board has no wrapping surface of its own. If a facet change ever becomes a `replace` op
  rather than a page load, it needs one. It does not in this plan — facets are a GET — but write it
  down.

## Activity, and the cap that makes today's answer wrong

`/activity` (`server.ts:1332-1341`) renders `audit.recent(200)` and hands `.audit` to the client
filter. Everything above about "cannot filter what was never sent" is concretely true here and
nowhere else in the app, because it is the only list with a `LIMIT` on the read.

`AuditRepository` (`app/repo/ports.ts:55-59`) has `append`, `forEntity` and `recent(limit)` and
nothing else, so this task adds a real read: entity kind, action, actor, and a date range, in SQL,
with the limit still there but applied **after** the predicate rather than before it. The facets
are the four columns the audit row already has, and `auditVerb`'s label map
(`app/view/html.ts:311`) is the source for the action names so the facet says "archived" where the
timeline says "archived".

The audit trail is append-only and never filtered by scope — `0012` was explicit: "an archived
record's history is exactly what someone asks for later. `auditFor` filters nothing." Nothing here
changes that.

## Verify — the gate

`tsc` cannot see a tablist. It cannot see that a pane is hidden, that focus moved, that ← selected
the next tab, or that a filtered list and a filtered count disagree. `0013` is the precedent that
settles this: its worst defect was a footer template whose `style="…"` attribute was closed early
by a quote inside `"Segoe UI"` — not a missing footer, which anyone would notice, but a nearly
invisible one, and *"only looking found it."* The browser pass is the gate.

What must be **executed**:

- **Keyboard, on both surfaces.** Open a ticket in the drawer: Tab reaches the tablist as **one**
  stop; ← → move and select; Home/End jump; Tab from the tablist lands in the visible pane and
  never in a hidden one; Tab wraps at the end of the panel rather than escaping behind the scrim.
  Then the same record's full page at `/tickets/:id`, where there is no focus trap, and confirm the
  tablist behaves identically. A screen reader announcing "tab 2 of 4, selected" is the check that
  the ARIA is real and not decorative.
- **The button-in-a-tab-bar look.** Render the tablist and *look at it* beside GRAIN's own
  `.tab-bar` in the catalog. A `<button class="tab">` that still carries UA chrome is the failure
  mode described above and it does not fail any test.
- **`?tab=`.** `/tickets/:id?tab=history` opens on History. The drawer's "Open full page ↗" carries
  the tab the operator was on. An unknown `?tab=` value falls back to Details rather than showing
  no pane at all — a panel with every pane hidden is a blank drawer.
- **Edit, then Cancel, from a tab that is not Details.** Open a record's History, press Edit,
  press Cancel, and land back on History. This is the round trip the two scripts get wrong by
  default and it costs one click to check.
- **The narrow column.** Four tabs in the drawer's 28rem panel, with a long ticket title above
  them: the strip scrolls, the fade appears, nothing wraps, and the selected tab is scrolled into
  view when the panel opens on a tab that is off-screen.
- **`bun test`, and `app/view/css.test.ts` specifically.** `ADOPTED_ANYWAY` must still be empty.
  If `.panel-tabs` or `.panel-pane` ever collides, rename STEWARD's — do not add an exception.
- **Facets against real data.** `/tickets?status=Waiting&clientId=…` returns the right set, the
  count in the page head matches the rows, the chips come back checked from the URL, and the
  Clear-all link returns to the unfiltered list. Then the same URL in a fresh window, to prove it
  is a URL and not session state.
- **Facets with JavaScript disabled.** Check a chip, press the button, get a filtered list. This is
  the claim the whole server-side decision rests on and it takes thirty seconds to check.
- **The `q` box, both halves.** Typing narrows instantly with the note showing both totals; Enter
  reloads into a URL carrying `?q=`; Escape and Clear still work (`steward-live.js:124-128,180-184`).
- **The SSE interaction.** Two windows. Filter the board in one; create a ticket in the other.
  With a text filter only: the new card is judged by the filter, and the note updates. With a facet
  in the URL: the stale notice appears and the reload link returns a correct list. Then do it with
  no filter at all and confirm nothing changed about today's behaviour.
- **Activity's cap.** With more than 200 audit rows, filter by a customer that has activity older
  than the 200th row and confirm the older entries are found — and confirm the *unfixed* version
  does not find them, so the test is testing something.
- **The archived facet against `0012`.** `?scope=archived` shows what `0012`'s `?archived=1`
  showed, the old URL still works, and Restore still works from the facet view.

## Still open, and deliberately not decided here

- **Pagination.** Nothing in STEWARD is paginated — every list is an unbounded `SELECT`
  (`app/repo/sqlite.ts:90,136,194`). Server-side filtering is the *prerequisite* for pagination,
  not a substitute for it, and this plan deliberately does not add one. When a workspace is large
  enough for it to matter, the query object already has the shape to take `limit`/`offset`.
- **Sorting.** Every list has one fixed `ORDER BY` and nobody has asked to change it. A sortable
  column header is a different feature with a different URL parameter and its own keyboard story.
- **Saved views.** "My waiting tickets" as a named thing the operator can pin to the rail is a real
  idea and a bigger one; the URL is already the primitive it would be built from.
- **Upstreaming a `tabset` molecule to GRAIN.** Per the decision above: adopt `.tab` now, revisit
  when a second consumer wants the same thing. Whoever picks it up should know that the only
  STEWARD-side pieces are `.panel-tabs`, `.panel-pane` and one small script.
- **Full-text search.** `q` is `LIKE` over a few columns. FTS5 is a migration and an index, and
  `0012` has only just built the first migration ladder rung.
- **Tabs on the list pages.** A "Live | Archived" tabset above `/clients` would be a second way to
  express the scope facet, and two controls for one predicate is worse than one. Facets won. If
  the human reads the scope facet as too quiet, the tabset is the alternative to try.
