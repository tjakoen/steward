---
id: 0008-ui-audit
title: STEWARD — UI audit; close the GRAIN class collisions before the upstream ships
status: in-progress
owner: admin
created: 2026-08-01
milestone: M2 (AI-native cockpit)
tags: [ui, css, collisions, accessibility, density, audit]
tasks:
  - id: collision-guard
    title: A test that fails when steward.css defines a class GRAIN already owns
    status: done
  - id: fix-board
    title: .board/.card/.cards → .kanban* (live-JS contract, rename in lockstep)
    status: done
  - id: fix-icon
    title: Remove button.icon — GRAIN owns .icon and leaks height:1.25rem
    status: done
  - id: fix-btn
    title: One button language — adopt GRAIN's .btn, retire the bare `button` selector
    status: done
  - id: fix-chat
    title: Delete STEWARD's duplicate .chat-message/.chat-log rules (double bubble)
    status: done
  - id: fix-latent
    title: .badge .chips .muted .card — delete duplicates, keep only what GRAIN lacks
    status: done
  - id: measure
    title: A content measure on .pane, and pair the page-head count with its title
    status: todo
  - id: board-height
    title: Kanban columns stop stretching; per-column empty state
    status: todo
  - id: narrow
    title: 700px — collapse the rail instead of spending 34% of the window on it
    status: todo
  - id: row-keyboard
    title: Rows reachable and openable by keyboard, to the SAME place as a click
    status: todo
  - id: drawer-semantics
    title: Dialog semantics + scroll lock + a backdrop that actually dims in dark
    status: todo
  - id: chat-affordances
    title: Chat close button, Escape, aria-expanded, labelled panel, disabled send
    status: todo
  - id: settings-state
    title: Mode/flavor buttons show which one is current (aria-pressed), real labels
    status: todo
  - id: filter-feedback
    title: Filter reports what it hid, and can be cleared
    status: todo
  - id: audit-verbs
    title: Activity speaks English, not diff keys
    status: todo
  - id: home
    title: Replace the 0001 "proof of life" dev page with a real Home
    status: todo
  - id: nav-icons
    title: Nav glyphs → GRAIN's icon system
    status: todo
---

# STEWARD — UI audit (0008)

Run before resuming 0007. Everything below was measured in a browser on `PORT=3211`,
both schemes, at 1440px and 700px — computed styles, not readings of the source.

## The finding that reorders the roadmap

0007 opens on a class collision: STEWARD's `.app-shell` against GRAIN's. That collision is
real, and it is **one of twelve**. Diffing the class names in `frontend/client/steward.css`
against the served `/components.css` + `/styles/global.css`:

```
.app-shell  .badge  .board  .btn  .card
.chat-log  .chat-message  .chat-message__body  .chat-message__who
.chips  .icon  .muted
```

Four of them are doing visible damage right now, and none of the four is fixed by adopting
GRAIN's app-shell. That is the argument for this plan running first: if `data-table` and
`drawer` land in 0.1.13 while `.board` still means two things, the browser gate at 0007's
step 6 signs off a shell that is still half-GRAIN, and the collision that motivated the whole
upstream survives it.

### `.board` — the kanban is capped at 768px

GRAIN's `global.css` owns `.board` as a *reading column*, deliberately, for MILL content
inside a shell pane:

```css
.board { max-width: var(--content-max); margin: var(--space-8) auto; padding: 0 var(--page-pad); }
```

STEWARD's kanban never resets those. Measured on `/tickets` at 1440px: pane `1204px`, board
`768px`, `padding-left: 40px`, four columns of `163px`. "Service Agreement Renewal" wraps to
three lines in a column that had 300px of unused pane beside it. This is not a taste question
— it is GRAIN's prose measure applied to a drag-and-drop board.

### `.icon` — the theme toggle is clipped

GRAIN's `.icon` is a sized glyph box: `width: 1.25rem; height: 1.25rem`. STEWARD writes
`button.icon` (0-1-1), which beats it on `width` — and says nothing about `height`. Measured:
**34px × 20px**. The `◐` is cut off in the topbar of every screenshot in this repo.

### `.btn` — two button languages in the same chrome

GRAIN's `.btn` carries `text-transform: uppercase; letter-spacing: .08em; min-height: 2.75rem;
display: inline-flex`. STEWARD's later `button, .btn` rule overrides colour, padding and border
but not those four. So on a ticket page, `<a class="btn">` renders **DOWNLOAD PDF**, 44px tall,
directly above `<button>Edit</button>` in sentence case at 40px. Same page, same role, two
typographic voices.

### `.chat-message` — every AI reply is a box in a box

GRAIN puts the border, padding and radius on `.chat-message`. STEWARD puts a *second* border,
padding and fill on `.chat-message__body` inside it. Measured on an injected message: outer
`1px solid rgba(28,27,23,.14)` + `8px 12px`, inner `1px solid rgba(28,27,23,.14)` + `8px 12px`.

### `.app-shell` — worse than 0007 records

0007 says the collision bites below 768px. It bites everywhere. At 1440px, computed
`grid-template-areas` is already GRAIN's five-region map while `grid-template-columns` is
STEWARD's two. At 700px:

```
grid-template-rows: 900px 0px 0px 0px 0px
```

GRAIN's container query supplies five rows; STEWARD's `100vh` fills the first; `.sidebar` and
`.content` auto-place into it and the other four collapse to zero. The narrow layout renders
correctly **by accident**, and any change to GRAIN's mobile row template silently reflows
STEWARD. Keep this fix in 0007 (adopt the real shell); it is recorded here because the
severity was understated.

## How the collisions get fixed

Two available moves per name: **adopt** GRAIN's component (delete STEWARD's rules, change the
markup) or **rename** STEWARD's (keep the behaviour, stop squatting on the name). The rule
used below is 0007's own: if another product on GRAIN would want it, adopt; if it names a
STEWARD concept, rename.

| Name | Move | Why |
|---|---|---|
| `.board` `.card` `.cards` | rename → `.kanban` `.kanban-card` `.kanban-cards` | a ticket board is STEWARD's concept; GRAIN's `.board` is a measure |
| `.icon` | delete `button.icon` → `.topbar__btn` | GRAIN owns `.icon`; STEWARD only ever wanted a square button |
| `.btn` | adopt | there should be one button, and GRAIN already ships it |
| `.chat-message*` `.chat-log` | adopt | already GRAIN components; STEWARD is re-declaring them |
| `.badge` `.chips` `.muted` | adopt | GRAIN's are equivalent or better; delete the duplicates |
| `.app-shell` | adopt — **in 0007** | that is the whole point of the upstream |

**`.btn` is a visual decision, not a mechanical one.** Adopting it means every button in
STEWARD goes uppercase at a 44px touch target, because that is GRAIN's button. The alternative
is to keep sentence-case buttons and stop calling them `.btn` — which means STEWARD has a
button GRAIN does not, and the design system does not describe the app. Recommend adopting;
flag it before doing it, because it changes the look of every surface.

**The kanban rename touches a live-JS contract.** `steward-live.js` queries `.board-col`,
`.card[draggable]`, `.cards`, `.count` for the drag handlers and `li.card` in the filter;
`renderBoard` in `app/view/html.ts` emits them. `tsc` cannot see a class rename and
`html.test.ts` asserts none of these names — so the rename and the drag test in the browser
are one task, not two.

### The guard

Renaming twelve classes fixes today. It does not stop the thirteenth. Add a test that reads
`frontend/client/steward.css` and the resolved GRAIN CSS and fails on any class defined in
both, with an explicit allow-list for names STEWARD has consciously adopted. A collision that
only a human eye catches will come back the next time GRAIN grows a component — GRAIN's own
lesson 9, applied here: a rule with no mechanism drifts.

## Layout and density

- **No content measure anywhere.** `.pane` is edge to edge, so Settings prose runs ~110ch at
  1440px and Clients' "Company info" column runs to 1900px. Tables want the width; prose does
  not. A measure on the prose surfaces, not on `.pane` wholesale.
- **`page-head .sub { margin-left: auto }`** puts "2 records" 1600px from the "Clients" it
  counts. Pair it with the title.
- **Kanban columns stretch to the full viewport** on one card (`flex: 1`, `min-height: 22rem`)
  and empty columns say nothing. Cap the stretch; give each column an empty state.
- **700px spends 34% of the window on a fixed 236px rail.** GRAIN's rail already ships
  `data-rail-collapsed`; this becomes free once 0007 lands, so do the collapse there and only
  keep the finding here.
- **Detail pages name the record three times** — crumb, `← Board` back-link, `<h1>`
  (`server.ts:645-646`). Two of those are enough.
- **`panelMeta` leaves a dangling `·`** when `form.inline` wraps to the next line
  (`server.ts:243`), on every ticket panel.

## Interaction and accessibility

- **Rows are mouse-only, and the mouse goes somewhere else.** `tr[data-href]` has
  `tabIndex -1` and no role. A click opens the drawer; the inner `<a>` — the only keyboard
  path — opens the full page. Same row, two destinations, depending on input device.
- **The drawer is not a dialog.** No `role`, no `aria-modal`, no label, the page behind is not
  `inert`, no focus restore, and `body` keeps `overflow: visible` so the list scrolls under it.
  0007's GRAIN drawer ships focus, trap and `inert`; scroll lock and the label are STEWARD's.
- **The backdrop barely dims in dark mode** (`rgba(0,0,0,.32)` over a near-black pane). It
  needs to read as a modal in both schemes.
- **The chat panel cannot be closed from itself** — no button, no Escape, no `aria-expanded`
  on the toggle, no label on the panel. `steward-chat.js` never disables the send button
  despite the `:disabled` styling existing.
- **Settings never says which theme is current** (`server.ts:977-984`): six buttons, no
  `aria-pressed`, no selected styling, and the `<label>`s wrap no control.
- **The filter is silent.** Board counts recompute; the table's "N records" does not; nothing
  reports how many rows were hidden, and there is no clear.

## Content

- **Activity shows the operator raw diff keys** — "attached, source", "persons, email, phone,
  notes", "ticketId, customerId, title, dateInitiated +8 more", "removedDocument"
  (`app/view/html.ts:288-302`). `auditSummary` deliberately withholds values, which is right;
  it should withhold field names too and say what happened.
- **Home is still the 0001 dev page**: "Proof of life", "Run demo intent", an inline `<script>`
  (`server.ts:911-930`). It is the landing route of the product.
- **Nav icons are text glyphs** (`◆ ▤ ☰ ◧ ❐ ↻ ⚙ ?`) at mismatched optical sizes and baselines.
  GRAIN ships an icon system; this is what it is for.
- Settings renders an empty `<pre class="log">` box before anything has run.

## How this is verified

`bun test` — all 77 still green — plus `bun run check`, and then in a real browser on
`PORT=3211`, because none of this is typechecked:

- `getComputedStyle($('.kanban')).maxWidth` is `none` and its width equals the pane's.
- The topbar button's computed `height` equals its `width`.
- A chat message has exactly one border between the log and the text.
- Every button on a record page shares one case and one height.
- Drag a card between columns, and the filter still hides cards **after** the rename — the
  live-JS contract is the thing most likely to break silently.
- Tab to a row, open it with Enter, and land where a click lands.
- Open the drawer: focus moves in, Tab stays in, Escape closes, focus returns to the opener,
  the page behind does not scroll.
- The collision guard fails when a deliberate duplicate class is added, and passes when it is
  removed.

## Risks

**The rename is broad and untypechecked.** Same risk 0007 carries, same answer: the browser
pass is the gate.

**This plan and 0007 touch the same markup twice.** `server.ts:190-206` gets reclassed here
for the kanban and again in 0007 for the shell. Accepted deliberately: doing 0007 first means
publishing 0.1.13 against a collision, and a published version cannot be taken back.

**Adopting `.btn` changes how the whole app looks.** It is the right call for a design-system
build and it is still a visible change to every screen. Get the go-ahead before, not after.

## What the collision pass actually did (2026-08-01)

Six tasks are done — the guard plus the five renames/adoptions. `bun test` is 80 green
(77 + the guard's 3), `tsc` clean, and every browser check above was measured on `PORT=3211`
at 1440px.

- **The guard found a thirteenth.** `.dtable td .name` against GRAIN's `.eyebrow .name`.
  Scoped on both sides, so it was doing no damage — and dead: no markup emits `class="name"`.
  Deleted. The guard is deliberately strict (any class defined in both, allow-list of one:
  `.app-shell`, until 0007), which forces a doctrine worth keeping: **steward.css names no GRAIN
  class at all.** Where STEWARD needs to tune a GRAIN component it wears a second class of its
  own — `btn topbar__btn`, `chat-log chat-panel__log`, `badge badge-accent` — and styles that.
  Refining `.chat-log .chat-message__body` in place is exactly how the double bubble happened.
- **The rename broke the filter, silently, as predicted.** `server.ts` passed the filter box
  `target: '.board'`; after the rename that selector matched nothing, so typing hid nothing and
  said nothing. `tsc` was clean and all tests passed through it. The browser caught it. Now
  `.kanban`: a query hides 4 of 6 cards and the column counts follow (1/1/0/0 → 6 restored on
  clear). Drag also survives: card moved between columns over SSE, counts recomputed.
- **`.btn` adopted, with the go-ahead.** Every button carries `class="btn"`; uppercase at 44px
  app-wide. `data-size="sm"` was tried on the dense in-form actions and then dropped — one
  button language means one height. Two shapes stay STEWARD's: `.topbar__btn` (a 36px square
  glyph button, now 36×36 with nothing clipped, was 34×20) and `.linkish` (an inline text verb,
  never a control). `.primary` is gone; emphasis is `data-variant="soft"`, GRAIN's vocabulary.
- **The kanban is the pane's width.** `max-width: none`, 1156px board in a 1156px pane content
  box, four 280px columns (was a 768px board with 163px columns).
- **One border per chat message.** Log 0, `.chat-message` 1, `.chat-message__body` 0 — and the
  AI's line renders Redaction 35 through GRAIN's own `data-grade`, not a STEWARD font rule.
- `.board-col` was renamed to `.kanban-col` alongside the three collisions. Not a collision,
  but leaving it would have split the board's vocabulary across two names.

## Roadmap note

This plan takes the 0008 slot; the previously-sketched roadmap shifts to
0007-grain-upstream → **0008-ui-audit** → 0009-shell → 0010-sheets-sync.

## Still open from 0006

Confirmed on 2026-08-01, both still undone: **no file has been picked** through the Drive
Picker from a browser signed in as the connected account (0006's last unexercised step — the
headless run got as far as Google's sign-in wall), and the **`GOOGLE_API_KEY` is unrestricted**
in Cloud Console. The key is browser-exposed by design — the Picker needs it client-side — so
restricting it to this origin is the only thing standing between it and anyone who reads the
page source.
