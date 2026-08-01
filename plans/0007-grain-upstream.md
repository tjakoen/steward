---
id: 0007-grain-upstream
title: STEWARD — push the shell, the data table and the drawer up into GRAIN
status: done
owner: admin
created: 2026-07-31
milestone: M2 (AI-native cockpit)
tags: [grain, design-system, upstream, css, release]
tasks:
  - id: shell-collision
    title: Prove and remove the .app-shell class collision (STEWARD redefines GRAIN's)
    status: done
  - id: rail-gaps
    title: side-rail — section label, per-item count, footer identity strip
    status: done
  - id: topbar-gaps
    title: topbar — breadcrumb slot + the filter searchbar
    status: done
  - id: data-table
    title: New molecule data-table (STEWARD's .dtable) with the grain pending idiom
    status: done
  - id: drawer
    title: New organism drawer + scripts/drawer.js (open/close/escape/backdrop/focus)
    status: done
  - id: grain-tests
    title: Unit + conformance tests for every new surface; tsc and bun test green
    status: done
  - id: grain-docs
    title: Component .md files, README sync in grain
    status: done
  - id: publish
    title: Bump @tjakoen/grain to 0.1.13 and let CI publish it (GATED ON HUMAN)
    status: done
  - id: steward-adopt
    title: Bump the dep, delete the upstreamed CSS, reclass the markup, reverify
    status: done
  - id: narrow
    title: 700px — collapse the rail instead of spending 34% of the window on it
    status: done
---

# STEWARD — GRAIN upstream (0007)

STEWARD grew an admin chrome that is not STEWARD's: a sidebar-plus-topbar shell, a dense
data table, and a slide-in drawer. None of it names a client, a customer or a ticket.
By grain's own test — *would another product on GRAIN want this?* — it belongs upstream.

This plan moves it, and it moves it **through the registry**. STEWARD consumes the
published `@tjakoen/grain` tarball (`^0.1.12`), resolved at runtime by
`config.ts` through `import.meta.resolve`. Editing `node_modules` would appear to work
and would evaporate on the next install. The only real path is: change grain, bump the
version, publish, bump the dependency here.

## The thing found while scoping this: a live class collision

STEWARD's `frontend/client/steward.css` defines `.app-shell` as a two-column grid
(sidebar plus content). GRAIN **already owns that class name** — `components/organisms/
app-shell/app-shell.css` defines it as a five-region workspace grid (window, rail,
topbar, main, aside, console).

Both files load on every STEWARD page, in this order (`server.ts:103-108`):

```
/styles/variables.css → /styles/global.css → /components.css → /app/steward.css
```

`/components.css` is the bundle over `config.styleRoots`, which starts at GRAIN's
`components/` — so grain's `app-shell.css` is in there, and STEWARD's copy wins only
because it loads last and at equal specificity. That is a coin-flip, not a design.

Worse, one part of grain's rules cannot be overridden by load order, because STEWARD
never writes the matching selectors:

- `body:has(.app-shell) { container-type: inline-size; container-name: shell-frame }`
  is unconditional — every STEWARD page already establishes grain's container.
- `@container shell-frame (max-width: 768px)` then rewrites `.app-shell` to a single
  column with `grid-template-areas: "window" "topbar" "main" "console" "status"` —
  area names STEWARD's `.sidebar` and `.content` do not carry, so below 768px the two
  children fall to auto-placement inside a one-column grid.

So STEWARD's shell is already half-driven by grain's shell, invisibly. Adopting grain's
app-shell properly is not a nicety here; it is the fix.

**Verify the collision before touching anything, and again after** — with the app running
on `PORT=3211`, at a 700px-wide window:

```js
getComputedStyle(document.querySelector('.app-shell')).gridTemplateAreas
```

Today that returns grain's mobile areas. After the adoption it must return grain's areas
*and* the sidebar must sit in `rail`.

## What moves up, and what deliberately does not

Everything below is judged by the grain rule: nothing product- or page-specific.

**Moves up.**

| STEWARD today | Lands in GRAIN as |
|---|---|
| `.app-shell`, `.content`, `.pane` | *nothing new* — adopt grain's `app-shell` regions |
| `.sidebar`, `.sidebar__brand`, `.nav`, `.nav a` | *nothing new* — adopt `side-rail` + `nav-item` |
| `.nav__label`, `.nav__count`, `.sidebar__foot` | gap-fills on `side-rail` / `nav-item` (below) |
| `.topbar`, `.topbar__actions` | adopt `app-shell__topbar` + `topbar-ctl` |
| `.topbar__crumbs`, `.searchbar` | gap-fills on `topbar` (below) |
| `.dtable` | **new molecule `data-table`** |
| `.drawer` and its parts | **new organism `drawer`** + `scripts/drawer.js` |

**Stays in STEWARD.** The kanban board (`.board`, `.card`, ticket statuses), the audit
trail (`.audit`, the human/ai actor stamp), the document chips and previews, the chat
panel, `.panel-meta`, `.lineage`. Each names a STEWARD concept.

**Deliberately deferred, not forgotten.** `.panel` overlaps grain's `card` molecule and
`.fb` (FormBuilder) is arguably a BATCH concern, not a design-system one — both are worth
a look, neither is in this plan's scope. Say so in the plan's closing note rather than
scope-creeping mid-flight.

### The rail gaps

Grain's `side-rail` + `nav-item` already cover the brand row, the icon gutter, hover and
`aria-current="page"`. Three things STEWARD needs that are missing, all generic:

1. **`side-rail__label`** — the small uppercase section heading ("Workspace"). A rail with
   more than a handful of destinations needs grouping that is not a `<details>` group.
2. **`nav-item__count`** — a trailing tabular-nums count. `nav-item`'s grid already has the
   trailing column (`auto`, today used by the chevron); this only adds the styling, and
   must invert with the item's active state.
3. **`side-rail__foot`** — the bottom identity strip (avatar plus two lines). Persona-neutral:
   grain supplies the shape, the consumer supplies who it is.

All three must survive `data-rail-collapsed="true"` — the label and the foot's text hide,
the count hides, the avatar stays. That is the same rule the existing collapsed block
follows, so extend that block, do not write a parallel one.

### The topbar gaps

1. **`topbar__crumbs`** — a left-aligned context slot. `topbar-ctl` already right-aligns
   itself with `margin-left: auto`, so a crumb slot composes with no change to it.
2. **`searchbar`** — the filter box. Careful here: STEWARD's version is a *client-side
   row filter* (`[data-filter]` handled in `steward-live.js:120`), not a search. Grain
   should ship the **box**; the filtering behavior is the consumer's, and the `.md` must
   say so. A component that implies behavior it does not ship is exactly the silent
   contract failure grain's lesson 3 is about.

### data-table (new molecule)

Grain's existing `table` is a *content* table — MILL maps Markdown pipe tables to it,
prose padding, `padding-left: 0` on the first column. STEWARD's `.dtable` is a different
animal: sticky uppercase header, dense cells, full-width rules, row hover, clickable rows
(`tr[data-href]`), an `.empty` state. Two components, not one variant — the `table.md`
must point at `data-table` and vice versa so nobody has to guess which to reach for.

It must carry the grain idioms `table` already carries:

```css
.data-table[data-commit="pending"], [data-grade="grain"] .data-table { … }
```

Sticky header note: `position: sticky; top: 0` only works because the scroll container is
`.app-shell__main`. That is a **parent-context requirement** — state it in the `.md`
(lesson 3), or the header silently does not stick for a consumer who scrolls elsewhere.

### drawer (new organism)

Grain has no drawer. STEWARD's is complete and generic: fixed backdrop, right-hand panel
capped at `min(440px, 100vw)`, head/body column, slide-in plus fade keyframes, a
`prefers-reduced-motion` opt-out.

Its behavior lives in `frontend/client/steward-live.js:45-100` — open, close, close on
backdrop click, close on Escape, swap the title, load a fragment into the body. The first
four are the drawer; the last two are STEWARD's. Split there: `grain/scripts/drawer.js`
gets open/close/backdrop/Escape driven off `data-drawer-open` / `data-drawer-close`, and
STEWARD keeps the fragment loading.

Two things the current implementation does not do, which a grain organism must:

- **Focus.** Move focus into the panel on open, restore it to the opener on close, and
  trap Tab inside while open. A modal overlay that leaves focus behind it is broken for
  keyboard and screen-reader use.
- **`inert` or `aria-modal`** on the rest of the page while open.

Do not add these to STEWARD first and upstream them later — write them in grain.

## Sequencing

Grain first, in one branch off `main`, then one publish, then STEWARD.

1. **Grain, no version bump yet.** side-rail and topbar gap-fills; `data-table`;
   `drawer` plus `scripts/drawer.js`. Each with its `.md` (parent-context requirements
   spelled out), each with unit tests, and a conformance assertion for the drawer's focus
   behavior — the motion/behavior claims are the ones tests must cover, per grain's
   lesson 9 (a documented behavior with no mechanism is the worst drift).
2. **`tsc --noEmit` and `bun test` green in grain.** Definition of done there, not here.
3. **Bump `packages/grain/package.json` to `0.1.13`.** Additive only, so a patch bump.
   Check whether `mill`/`proof`/`crumb` pin a grain range that needs to move with it —
   internal deps are `workspace:*`, but the *published* tarballs carry concrete versions.
4. **Publish — ASK FIRST.** Push to `main` and `.github/workflows/publish.yml` publishes
   via npm trusted publishing (OIDC, no token). This is outward-facing and irreversible:
   npm does not allow republishing a version. Do not push without the go-ahead.
5. **STEWARD adopts.** `"@tjakoen/grain": "^0.1.13"`, then:
   ```bash
   rm -rf ~/.bun/install/cache/@tjakoen && bun install && bun run check
   ```
   The cache wipe matters — a warm bun cache will happily serve the old tarball and make
   a broken install look fine (RELEASE.md says this in as many words).
6. **Reclass the markup in `server.ts:190-206`** — `.sidebar` → `.app-shell__rail` hosting
   a `.side-rail`, `.content`+`.pane` → `.app-shell__main`, `.topbar` → `.app-shell__topbar`,
   nav links → `.nav-item`, `.dtable` → `.data-table`. Hide the regions STEWARD has no use
   for with the shell's own attributes (`data-aside-hidden`, `data-console-hidden`) rather
   than by redefining the grid.
7. **Delete the upstreamed blocks from `frontend/client/steward.css`.** The file should
   end up roughly half its 386 lines, holding only STEWARD's own surfaces. Deleting them
   is the proof the upstream worked; leaving them in means two sources of truth and the
   collision comes straight back.

## How this is verified

- Grain: `tsc` plus `bun test` green, new tests included.
- STEWARD: `bun test` — all 77 must still pass — plus `bun run check`.
- In a real browser on `PORT=3211`: every route renders unchanged (`/`, `/clients`,
  `/customers`, `/tickets`, `/files`, `/activity`, `/settings`, `/help`, `/plans`), the
  drawer opens and closes on the "+ New" button, backdrop and Escape, the topbar filter
  still hides rows, and the kanban drag-and-drop still works — the board's class names are
  a live-JS contract, so a reclass that touches them breaks it silently.
- The `gridTemplateAreas` check from the collision section, at 700px, before and after.
- Keyboard: tab into the drawer, tab around it, Escape out, and confirm focus lands back
  on the button that opened it.

## Built so far (2026-07-31) — grain side, unbumped and unpushed

On branch `0007-admin-surfaces` in `bread-repos/grain`, version deliberately left at 0.1.12:

- `nav-item.css` — `.nav-item__count`, in the grid's existing trailing column.
- `side-rail.css` — `.side-rail__label`, `.side-rail__foot` with `__avatar` / `__who`, and the
  matching entries in the collapsed block (which now owns every collapsed rule, including the
  nav-item count's, so there is one place to read them).
- `topbar.css` — `.topbar-crumbs`, `.topbar-search`.
- `components/molecules/data-table/` — new, with `.md` and conformance tests.
- `components/organisms/drawer/` + `scripts/drawer.js` — new, with `.md` and tests.
- `.md` updates for each, `table.md` ↔ `data-table.md` cross-references, and a README entry
  under the standalone islands.

284 tests pass, `tsc --noEmit` clean. Two decisions worth recording:

**The drawer ships the modal obligations, not just the panel.** STEWARD's version had none of
them. `drawer.js` moves focus into the panel, traps Tab at both ends, marks every other body
child `inert`, and returns focus to the opener. A consumer should not have to remember any of
that, and the version that shipped without it was quietly unusable by keyboard.

**The script tests are drift guards, not behavior tests — stated in the file.** This package has
no DOM in test and zero runtime deps, so a focus-trap assertion here would be testing a
hand-rolled fake. The guards catch an obligation being *deleted*, which is the realistic
regression. The behavior itself gets asserted in the browser at step 6, and that pass is not
optional.

## Done 2026-08-01 — `shell-collision`

Measured before, on `/clients`, with the app on `PORT=3211`:

| | 1440px | 700px |
|---|---|---|
| `gridTemplateAreas` | GRAIN's five regions, three columns | GRAIN's mobile single column |
| `gridTemplateColumns` | `236px 1204px` | `236px 464px` |
| `gridTemplateRows` | `900px 0 0 0 0` | `900px 0 0 0 0` |

So the areas were GRAIN's and the tracks were STEWARD's at **both** widths — every child
auto-placed, and at 700px the rail still ate 34% of the window inside a grid that had been
told to be one column wide.

The fix is the adoption the plan called for, and it needed no publish: `app-shell` is already
in 0.1.12. `steward.css` no longer defines `.app-shell` or `.content` at all; the markup carries
`app-shell__rail` / `__topbar` / `__main` and switches the two unused regions off with
`data-aside-hidden` / `data-console-hidden`. After: rail in `rail`, topbar in `topbar`, main in
`main`, aside and console at zero, in both schemes.

Three things worth recording, because none were in the plan:

- **A hidden console still reserves its row.** `data-console-hidden` only sets `display: none`;
  the row's floor is `minmax(var(--shell-console-min, 2.75rem), …)`, a length. STEWARD zeroes the
  token on `body` — a token, not a class, so the no-GRAIN-class doctrine holds.
- **Below 768px GRAIN's rail is an off-canvas drawer, so it needs a toggle.** Adopting without one
  would have left the nav unreachable at exactly the widths `narrow` exists to fix. The shell's
  own island (`scripts/shell.js`, now loaded) drives it off `data-shell="rail-toggle"`; the markup
  gains that button and `.app-shell__scrim`. The button is hidden above 768px on purpose: there the
  same control collapses the rail to an icon gutter, which STEWARD's `.sidebar` cannot render until
  it becomes `side-rail` in `steward-adopt`.
- **`narrow` is most of the way done as a side effect.** At 700px the rail is now off-canvas at zero
  width and the table has the whole 700px. What is left for that task is the *desktop* half —
  the collapsed icon rail — which is exactly what `steward-adopt` unlocks.

`ADOPTED_ANYWAY` in `app/view/css.test.ts` is now empty, and the doctrine is that it stays empty.
84 tests green, `tsc` clean, all nine routes 200, drawer open/Escape/focus-restore and the row
filter reverified in the browser at 1440px and 700px, light and dark.

## Done 2026-08-01 — `publish`

`@tjakoen/grain@0.1.13` is on the public registry, published by CI (trusted publishing, OIDC)
off `9a8900a` on grain's `main` — the human gave the go-ahead, and the branch
`0007-admin-surfaces` fast-forwarded into `main` unchanged from how it was built. 476 monorepo
tests and `tsc` green before the push. Step 3's question answered: `mill`, `proof` and `crumb`
pin `^0.1.8` / `^0.1.10`, caret ranges that already admit 0.1.13, so nothing moved with it.

## Done 2026-08-01 — `steward-adopt` and `narrow`

`"@tjakoen/grain": "^0.1.13"`, installed after `rm -rf ~/.bun/install/cache/@tjakoen` — the
cache wipe RELEASE.md insists on. The markup now reads as composition:

| was | is |
|---|---|
| `.sidebar` + `.nav` + `.nav a` | `<nav class="app-shell__rail side-rail">` of `.nav-item`s |
| `.nav__label` / `.nav__count` / `.nav__spacer` | `.side-rail__label` / `.nav-item__count` / `.side-rail__spacer` |
| `.sidebar__foot .avatar .who` | `.side-rail__foot` / `__avatar` / `__who` |
| `.topbar` + `.topbar__crumbs` + `.topbar__actions` | the `__topbar` region + `.topbar-crumbs` + `.topbar-ctl` |
| `.searchbar` | `.topbar-search` |
| `.dtable` | `.data-table` (`.dtable` stays, wearing two tunings) |
| STEWARD's `.drawer` CSS + its open/close code | GRAIN's `drawer` + `scripts/drawer.js` |

`steward.css` is 408 lines, down from 494, and every line of shell, rail, topbar, table and
drawer *mechanism* in it is gone. What survived is what GRAIN does not ship and STEWARD does:
the `.rail-mark` badge, `.rail-brand` (GRAIN's brand row is a `<div>`; STEWARD's is the link
home, so it has to lose the underline), the filter's clear button, a focus-within row highlight,
a 52ch cap on the free-text column, and the scroll lock.

Four things learnt, all of them the seam rather than the CSS:

- **The drawer is driven through `window.grain.drawer`, not `data-drawer-open`.** GRAIN's
  delegated opener fires before STEWARD's listener, so a declarative "+ New" would show whatever
  the panel last held and focus the wrong control. STEWARD puts the content in place first and
  opens after — which is also what makes GRAIN focus the right thing.
- **GRAIN focuses the first control in the panel, which is the close button.** Right for a record
  being read, one Tab short for a form, so STEWARD moves focus to the form's first field after
  loading one. Everything else modal — Tab trapped at both ends, the rest of the page `inert`,
  focus returned to the opener — is now GRAIN's and was verified in the browser.
- **A GRAIN class in a descendant selector is still a collision.** `.topbar-ctl a` failed the
  guard. The fix is the same doctrine as everywhere else: wear a second class (`topbar-actions`)
  and hang the rule off that. Same for the drawer body (`drawer-content`).
- **`narrow` fell out of this.** With the rail finally being `side-rail`, the topbar's ☰ does the
  right thing at both ends: above 768px it collapses the rail to a 3.25rem icon gutter (labels,
  counts, section label and the foot's text go; the avatar and the brand mark stay), and below it
  the rail is an off-canvas drawer over a scrim, so the 700px window spends 0% on navigation
  instead of 34%. Measured both, in both schemes.

Verified in the browser at 1440px and 700px, light and dark: nine routes 200; drawer open on
"+ New" focusing the first field, Tab wrapping, Escape closing, focus returning; a row click
loading its panel fragment and the title following it; the filter hiding rows with its honest
count and the Clear button; the kanban drag posting `ticket.status` and the card moving over SSE.

One thing the browser pass re-found, unchanged and still unfixed: `Bun.serve` drops `/stream`
after 10 seconds of quiet, so an op fired at a page that has been idle lands nowhere until
EventSource reconnects. It cost an hour of chasing a phantom drag-and-drop regression here —
the move was always reaching the server. It wants `idleTimeout`; it is 0009's.

## Risks

**The reclass is broad and mostly untypechecked.** These are HTML strings — `tsc` cannot
see a class rename, and `bun test` mostly asserts server behavior, not markup. The browser
pass is the real gate, not an optional nicety.

**A published version cannot be taken back.** If 0.1.13 ships wrong, the fix is 0.1.14.
That is the argument for doing the whole grain side, including tests, before step 4.

**Scope drift into grain.** Every "while I'm here" in grain costs another publish cycle.
Anything not in the table above goes on a list, not into this branch.

## Closing note

Two things this plan looked at and set aside on purpose: STEWARD's `.panel` against
grain's `card` molecule, and whether FormBuilder (`.fb` plus `app/view/html.ts`) belongs
in BATCH. Both are real questions. Neither is worth holding this release for.

Next after this: 0009-shell (the `bun build --compile` binary), then 0010-sheets-sync.

## Amended 2026-08-01 — 0008 runs first

A UI audit found that `.app-shell` is one of **twelve** class names STEWARD and GRAIN both
define, four of them doing visible damage (`.board` caps the kanban at GRAIN's prose measure,
`.icon` clips the theme toggle to 34×20, `.btn` gives the app two button languages,
`.chat-message` double-borders every AI reply). The `.app-shell` collision is also live at
every width, not only below 768px: at 1440px the computed areas are already GRAIN's while the
columns are STEWARD's.

Adopting GRAIN's app-shell fixes one of the four and leaves three, so the browser gate at
step 6 would sign off a shell that is still half-GRAIN. `plans/0008-ui-audit.md` closes the
collisions first; this plan resumes after it, unchanged apart from the sequencing. The grain
branch `0007-admin-surfaces` stays as built — nothing found here changes what was upstreamed.

**0008 is now closed except one task, which moved here: `narrow`.** At 700px STEWARD spends 34%
of the window on a fixed 236px rail. Fixing that in 0008 would have meant writing a collapse
STEWARD owns, and GRAIN's `side-rail` already ships `data-rail-collapsed` — the same duplication
this plan exists to end. It becomes near-free once `steward-adopt` lands, so it is sequenced
after it: adopt the rail, then drive the attribute, then re-measure at 700px in both schemes.
Everything else 0008 found is fixed and committed (`396daf4`, `bd387aa`, `5388be0`), including
the doctrine this plan must keep honouring: **steward.css names no GRAIN class at all**, enforced
by `app/view/css.test.ts`, whose allow-list holds exactly one name — `.app-shell`, until
`shell-collision` here removes the need for it.
