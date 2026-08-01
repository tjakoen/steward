---
id: 0010-sheets-sync
title: STEWARD — a Google Sheets mirror, and the two things 0009 left behind
status: done
owner: admin
created: 2026-08-01
milestone: M3 (ship it)
tags: [sheets, google, export, reporting, batch-upstream, windows, packaging]
tasks:
  - id: sheets-client
    title: app/google/sheets.ts — the Sheets API behind the same OAuth the Drive store uses
    status: done
  - id: mirror-shape
    title: The four tabs and their columns, as a pure records→rows mapping
    status: done
  - id: push
    title: Create-or-reuse the spreadsheet, rewrite it whole, leave no stale rows
    status: done
  - id: settings-surface
    title: A Settings card that states what is true and pushes on a click
    status: done
  - id: intent-action
    title: `sheet.push` through the /intent door, so the AI can refresh the mirror
    status: done
  - id: batch-templates
    title: A `templates` option on BATCH's createRenderer — retires app/assets/components.ts
    status: done
  - id: boot-log
    title: A log file in the data directory — the prerequisite for hiding the console
    status: done
  - id: windows-console
    title: --windows-hide-console and --windows-icon, once a failed launch is still visible
    status: done
  - id: verify
    title: The gate — what this Mac and a connected account can actually prove
    status: done
---

# STEWARD — the Sheets mirror (0010)

The roadmap has carried `sheets-sync` since 0001 with no specification behind the name.
This plan gives it one, and the specification is deliberately narrower than the name: a
**one-way mirror**. STEWARD writes a spreadsheet into the operator's own Drive and rewrites
it on demand. It never reads it back.

## Why one-way, and why that is not a smaller version of the real thing

SQLite is the source of truth and every mutation appends an audit row. That sentence is the
product. A spreadsheet that writes back would let a record change with no actor, no
timestamp and no diff — the audit trail would develop holes exactly where someone did the
most convenient thing available to them, which is edit a cell.

A round trip also needs answers this plan would have to invent: what identifies a row when
someone inserts one, which side wins when both changed since the last push, what a deleted
row means (archive? nothing?), and what happens when a paste shifts a whole column by one.
Every one of those is a way to silently overwrite real customer data, and none of them is
made safer by being written quickly.

So the mirror is a **reporting and sharing surface**: the spreadsheet is where someone who
does not have STEWARD reads the state of the work, filters it, pivots it, sends it on. That
is a real job and it is fully served by a push. The door back is not nailed shut — a later
plan can add a pull with the row identity this one already puts in column A — but nothing
here pretends to have opened it.

## What it costs to be wrong about that

Someone will edit the mirror. It looks like a spreadsheet, it *is* a spreadsheet, and the
next push overwrites their work without asking. Three guards, none of them decorative:

1. The file is named **`STEWARD mirror (read-only)`**.
2. Row 1 of every tab is a banner: *"Read-only mirror of STEWARD. Rewritten on every push —
   edits made here are lost. Last pushed: <ISO timestamp>."* The header row is row 2.
3. Every tab gets a Sheets **protected range** with `warningOnly: true`, so an edit raises
   Google's own "you're editing a protected cell" dialog. `warningOnly` rather than a real
   permission because the operator owns the file and shares it themselves; a hard protection
   would be a permissions problem for them to fight, and a warning is what actually reaches
   the person about to lose their typing.

The timestamp in the banner is not garnish either — a stale mirror that looks live is the
other way this feature misleads, and the only cheap answer is for the sheet to say when it
was last written.

## Scope, credentials, and what does not change

Sheets lives in the **same Cloud project and the same OAuth client as Drive**, and the
`drive.file` scope already granted covers it: `spreadsheets.create` accepts `drive.file`, and
every `spreadsheets.values.*` and `spreadsheets.batchUpdate` call accepts it for a file the
app itself created. So:

- **No new scope.** The consent screen does not change, and `drive.file` is non-sensitive, so
  nothing here drags the OAuth app into a verification review. (0006's note stands: widening
  the scope is what would, and this does not widen it.)
- **No new environment variable, no new key.** `GOOGLE_CLIENT_ID`/`SECRET` are what already
  exist; `scripts/build.ts` bakes them and needs no change.
- **One thing the human must click**: the **Sheets API has to be enabled** in the Cloud
  project, once. It is a toggle in the console, not a review. Until it is, Google answers 403
  with `Google Sheets API has not been used in project <n> before or it is disabled` and an
  activation URL — which the Settings card surfaces verbatim with the link, rather than
  reporting a generic failure (the Picker's missing-key message is the idiom to copy).

There is a route that avoids the Sheets API entirely — upload a CSV through the Drive API
with `mimeType: application/vnd.google-apps.spreadsheet` and let Drive convert it. It was
considered and rejected: a CSV converts to exactly one tab with no formatting, no frozen
header and no protected range, so the guards above would all be gone and a multi-tab mirror
would need an XLSX writer. The Sheets API is one more API to enable and considerably less
machinery.

## The shape of the mirror

Four tabs. Column A is always the STEWARD id — it is what makes the sheet joinable, and it is
what a future pull would key on.

| Tab | Columns |
|---|---|
| **Clients** | id, code, name, active, created, updated |
| **Customers** | id, client code, customer code, persons, email, phone, external id, notes, created, updated |
| **Tickets** | id, ticket id, customer, client code, title, status, initiated, last updated, waiting on, waiting since, next action, summary |
| **Progress** | ticket id, date, update |

`progressLog` is a list per ticket, and a list does not fit a cell honestly — truncated into
one it becomes unreadable, joined with newlines it becomes a cell nobody can filter. It gets
its own tab, keyed by the human ticket id, which is also the shape someone building a pivot
actually wants.

Two deliberate omissions:

- **`branding.logoDataUrl` never goes in.** It is a base64 image, frequently over Sheets'
  50,000-character cell limit, and it would be written on every push for no reader.
- **Documents are not mirrored.** A tab of Drive links duplicates `/files` for an audience
  that cannot click through to STEWARD anyway. Cheap to add later; not obviously wanted now.

`mirror-shape` builds this as a **pure function from records to rows** — no fetch, no auth, no
Sheets types. That is what makes the mapping testable without touching the network, and the
mapping is where the bugs will be.

## Pushing

`app/google/sheets.ts`, constructed with the existing `GoogleAuth` and an injected `Fetcher`,
exactly like `GoogleDriveStore` (same testing seam, same "returns a reason rather than
throwing when not connected" contract).

The push, in order:

1. **Find the spreadsheet.** `settings.get('sheets.spreadsheet_id')`. If there is none, create
   one (`POST https://sheets.googleapis.com/v4/spreadsheets` with the four tabs), then move it
   into the existing `STEWARD` Drive folder with `files.update?addParents=…` — `spreadsheets.create`
   drops the file in My Drive root and takes no parent. Store the id and the `spreadsheetUrl`.
2. **Format, once, at creation:** freeze the top two rows, bold the header row, size the
   columns, add the four `warningOnly` protected ranges. A single `batchUpdate`. Re-running it
   on every push would burn quota to re-assert what is already true.
3. **Clear, then write.** `values.batchClear` over each tab's data range, then
   `values.batchUpdate` with the new rectangle. The order matters and it is the pessimistic
   one on purpose: a failure between the two leaves tabs that are visibly *empty*, which
   someone notices, rather than tabs holding a mix of old and new rows, which nobody does.
   Writing without clearing is the actual bug this avoids — delete three tickets and their
   rows sit at the bottom of the tab forever.
4. **Banner and timestamp** go in with the same write.
5. **Record `sheets.pushed_at`** in settings.

**Gone-away handling.** The operator can trash the file. A 404 (or Drive's `File not found`)
on any call means: forget the stored id, create a new spreadsheet, say so in the result — *"The
previous mirror was gone, so a new one was created."* Silently recreating without saying it is
how someone ends up with three mirrors and a share link that points at a dead one.

**Never automatic.** The push is a click, or an explicit `sheet.push` intent. It copies customer
names, emails and phone numbers into a file that is one button away from being shared with
anyone — the operator already chose Drive for documents in 0006, but a spreadsheet is a far more
shareable object than a PDF attached to a record, and that is a decision that belongs at the
moment it happens. This is the same argument 0009 made for not auto-applying updates, and it
lands the same way: consent at the moment of the outward-facing act.

Quota is not a consideration at this size (Sheets allows 60 write requests per minute per user;
a full push is about five), but the on-demand model means it never will be either.

## Surfaces

**Settings → Google Sheets**, below the Drive card, and it says exactly one true thing at a time:

| State | What it says |
|---|---|
| Drive not configured / not connected | The mirror needs a connected Google account. (No button.) |
| Connected, never pushed | What the mirror is, that edits to it are lost, and **Create the mirror**. |
| Connected, mirror exists | A link to the spreadsheet, the last-push timestamp, and **Push now**. |
| Sheets API disabled | Google's own message and the activation link. |

**`sheet.push`** joins `STEWARD_ACTIONS`, so the same refresh is reachable through the `/intent`
door the AI and the UI share — that is the project's rule, not a feature invented here. It returns
a reply naming the row counts and a link, and it emits no render op at a surface it cannot see
(0009's `manifest-truth` lesson: a target nothing occupies is worse than no target).

No new CSS class: `app/view/css.test.ts` forbids `steward.css` naming a GRAIN class, and the card
is built from `panel`, `form-controls`, `btn` and `muted` like every other one.

## `batch-templates` — retiring a workaround 0009 wrote down as one

`app/assets/components.ts` writes ten component templates into the data directory at boot so
`createRenderer` has a real directory to walk. 0009 named it a workaround for a missing injection
point and named the honest fix: a `templates` option upstream. BATCH is checked out at
`~/Local/Development/bread-repos/batch`, and 0007 already established that upstreaming to a BREAD
package is normal work here rather than a special occasion.

The change to `render/render.ts`:

```ts
export interface RenderConfig {
  componentsDir?: string | string[];        // now optional
  templates?: Record<string, string>;       // component name → template SOURCE
  missing: MissingMode;
}
```

`refresh()` walks `componentsDir` when there is one, then applies `templates` over the result;
explicit templates win over discovered files, because a caller that passed a template by hand
meant it. The registry stops being `Map<string, string>` (name → path) and becomes
`Map<string, { path?: string; source?: string }>`, with `template()` reading the file only when
there is no inline source. `componentsDir` becoming optional is additive, so this is a minor
version — `0.1.0` → `0.2.0`, published through the existing `publish.yml`.

STEWARD then passes the ten templates as source, read at import time from their embedded paths
(`readFileSync` on `/$bunfs` works — 0009 verified it), `app/assets/components.ts` is deleted, and
nothing is written into the data directory any more. **The absence of that directory is the proof**,
and the verification says so.

Ordering, and it is not negotiable: BATCH ships and STEWARD installs the published version before
`components.ts` is deleted. A local `bun link` that passes here and a registry that does not have
the version is how the next clean install breaks.

## `boot-log` then `windows-console` — in that order, for the reason 0009 gave

0009 declined `--windows-hide-console` with a specific argument: the console is the only feedback a
first run has, and hiding it before the update path is proven turns a failed launch into an
invisible one. That argument is not answered by time passing. It is answered by giving a failed
launch somewhere else to be visible.

So `boot-log` comes first: when packaged, `console.log`/`console.error` are also appended to
`<dataDir>/steward.log` (truncated when it passes a megabyte — an unbounded log on someone's laptop
is its own bug), and a top-level failure writes the error there before exiting non-zero. Settings
already prints the data directory; it gains the log's name next to it. **Only then** does
`scripts/build.ts` add `--windows-hide-console` to the Windows target.

`--windows-icon` needs an `.ico`, and this repo has none. Producing one needs no new dependency:
`app/pdf/print.ts` already drives headless Chrome over CDP, `Page.captureScreenshot` is the same
`cdp.send` the PDF path uses, and the ICO container is a 6-byte header plus 16 bytes per entry plus
the PNG bytes themselves. `scripts/make-icon.ts` renders a STEWARD mark at 16/32/48/64/128/256 and
packs them. It is **run once and the `.ico` is committed** — CI has no Chrome, and a build input that
only exists on one laptop is not a build input. If the mark itself needs a designer's hand, that is
the human's call and the packer still takes whatever PNGs they hand it.

## How this is verified

**Without a network:**

- `bun test` green (122 today, plus the new mapping, push-sequence and BATCH cases) and `tsc --noEmit`
  clean.
- `sheets.test.ts` against a stub `Fetcher` asserts the request *sequence* — create → addParents →
  format → batchClear → batchUpdate — plus: a second push reuses the stored id and does not re-format,
  a 404 forgets the id and recreates, a 403 with Google's activation text is reported as itself, and a
  push while disconnected returns a reason rather than throwing.
- The row mapping is tested as a pure function, including the empty workspace (headers and banner, no
  rows) and a joint customer.

**Against the connected account** (0006 connected this machine on 2026-07-31; confirm the refresh token
still works before claiming any of this):

- Push. Open the spreadsheet. Read it back through `values.get` and compare cell-for-cell with what the
  mapping produced — the round trip through Google is the only thing that proves the ranges are right.
- Delete a ticket in STEWARD, push again, and confirm its row is **gone**, not blanked and not stranded
  below the new data.
- Trash the spreadsheet in Drive, push, and confirm a new one is created and the Settings link updates.

**From the binary** (`bun run build:here`, run from `/tmp` with nothing of the repo nearby):

- `/components.css` still byte-identical to the dev server's.
- Pages render, and **`<dataDir>/components/` does not exist** — the whole point of `batch-templates`.
- `steward.log` exists and holds the boot lines.
- The Settings card renders in light and dark at 1440px, in all four states (the disabled-API state
  driven by a stubbed response rather than by disabling the API for real).

**What cannot be proved here**, stated as plainly as 0009 stated it: there is still no Windows machine.
`--windows-hide-console` compiles and the icon is a valid ICO container (parseable, right directory
entries) — that a window is actually hidden and that Explorer shows the icon are unverified. The log
file is what makes that acceptable rather than reckless.

## Risks

**The mirror will be edited.** Name, banner and `warningOnly` protection are the three guards, and the
push is still destructive by design. This is the feature's main hazard and no amount of testing removes
it — it is removed by the sheet saying what it is.

**PII in a shareable file.** Names, emails and phone numbers land in a spreadsheet. Consent is the click.

**Publishing BATCH breaks installs if it is wrong.** The version ships and is installed from the registry
before anything in STEWARD depends on it; `components.ts` is deleted last.

**Hiding the console on an untested platform.** `boot-log` is a prerequisite, not a companion task. If it
slips, `windows-console` slips with it.

## Still blocked on the human, unchanged as of 2026-08-01

Not mine to close, and not to be re-debugged:

- **No file has been picked** through the Drive Picker from a browser signed in as the connected account (0006).
- **`GOOGLE_API_KEY` is unrestricted** in Cloud Console — browser-exposed by design, so an HTTP-referrer
  restriction is the only limit on who spends against it. More pressing once binaries are handed out.
- **The repo and its releases are still private.** The history audit ran clean in 0009; the click is the human's.
- **`dist/steward-windows-x64.exe` has never been run.**

New here, and also a console click, not a code task:

- ~~**The Sheets API must be enabled** in the same Cloud project.~~ It already was — the first live push
  succeeded without a console visit.

## Done 2026-08-01

All nine tasks. 160 tests green (up from 143 at the start of this plan, 122 at the end of 0009),
`tsc` clean, three binaries built, and the mirror verified against the real connected account.

### The mirror, proved by reading it back rather than by watching a 200

The first live push created the spreadsheet, dressed it, filed it into the existing `STEWARD`
Drive folder and wrote 2 clients, 6 customers, 6 tickets and 7 progress entries. Then every tab
was read back through `values:batchGet` and compared cell-for-cell against what `mirrorTabs`
produced: **identical, every cell**. The guards are on the file, not just in the code —
`frozenRowCount: 2` and a `warningOnly: true` protected range on all four tabs, and the file is
named `STEWARD mirror (read-only)` under the STEWARD folder.

Two failure paths were then exercised live, not reasoned about:

- **Deleted records leave no ghost rows.** Pushing a deliberately smaller data set (one client,
  no customers, no tickets — without touching the database) left the Clients tab at exactly 3
  rows and Tickets at 2: banner, header, and nothing below. This is the bug that clearing before
  writing exists to prevent, and writing-without-clearing would have passed a naive test.
- **A destroyed mirror is recreated, and says so.** Deleting the spreadsheet through the Drive API
  and pushing again produced `recreated: true`, a new id, and the file filed under `STEWARD` as
  before. Note the deletion was permanent, not a trash: Drive v3 `DELETE` does not trash.

### One deviation from the plan, and it is load-bearing

The plan said formatting happens once, at creation, and that re-running it every push would burn
quota. That is still true of the *dressing* — bold header, protected range, column widths. But the
**grid has to be sized on every push**: `values.update` refuses a range past the sheet's grid, and a
new sheet is 1000 rows. So each push reads the spreadsheet's metadata (which also tells it the tab
ids, whether the operator deleted a tab, and — by 404 — whether the file still exists) and sends one
`updateSheetProperties` per tab. A workspace with 2,000 clients would otherwise fail on the write
with an error about grid limits, which is covered by a test that pushes exactly that.

A tab the operator deletes is re-added **dressed**, not bare — the same protection and freeze as the
original, because a protection that silently disappears is worse than one that was never there.

### The Windows flags need a Windows host, which the plan did not know

`--windows-hide-console` and `--windows-icon` are refused when cross-compiling:

```
error: Using --windows-hide-console is only available when compiling on Windows
```

Bun 1.3.14, checked for both flags. So the release workflow now builds that one target on
`windows-latest` and hands the artifact to the Linux job, which hashes it into `SHA256SUMS` with the
other two. `scripts/build.ts` skips the flags on a non-Windows host **and prints that it did** — a
local `build:win` still produces a working exe, just with the default icon and a visible console, and
saying so is what stops someone assuming their local artifact is what CI ships.

`SHA256SUMS` now covers everything in `dist/` rather than only what the current run compiled. That is
what makes the two-job split safe: a checksums file that omitted the Windows binary would make the
updater refuse the one binary most people download.

### The icon, and why it is committed

`assets/steward.ico` — six sizes (256 down to 16), 14,624 bytes, RGBA. `scripts/make-icon.ts` renders
the mark through the headless Chrome this project already drives for PDFs (`Page.captureScreenshot`
via the same `cdp.send`) and packs the PNGs with `app/assets/ico.ts`. No new dependency.

`Emulation.setDefaultBackgroundColorOverride` with `a: 0` is not optional: without it the page
composites onto opaque white and the rounded corners ship as four white triangles that only show up
on somebody's dark taskbar. The first render had exactly that and the file command said so — RGB, not
RGBA.

It is committed because CI has no Chrome, and `app/assets/ico.test.ts` parses the committed file and
asserts the six sizes, so a truncated or hand-edited icon fails the gate rather than the operator.

### `batch-templates`: the workaround is gone

`@tjakoen/batch@0.2.0` is published (trusted publishing, no token, provenance signed) with an optional
`componentsDir` and a new `templates` map. `render.ts` now passes the ten embedded templates directly
when packaged and keeps the directory walk in a checkout, so `bun --hot` still picks up an edited
template. `app/assets/components.ts` is **deleted**.

The proof is an absence: a binary run from `/tmp` with its data directory elsewhere serves every route,
and `<dataDir>/components/` does not exist. `render.test.ts` covers the other half — a renderer built
from the embedded map alone expands `<b-button>` into a real `<button class="btn">`, and self-closing
tags still expand. The packaged half proves itself, since `render.ts` reads every embedded path while
its module body evaluates: a binary that boots has already done it.

### `boot-log`

Packaged runs mirror `console.log`/`warn`/`error` into `<dataDir>/steward.log`, timestamped, rolled over
at a megabyte, and Settings prints the path. `uncaughtException` and `unhandledRejection` write there
too — verified by rejecting a promise in a packaged-mode process and finding the stack in the file with
exit code 1. Those are the failures that never reach a `console.error`, and they are precisely the ones
a hidden console would otherwise swallow.

The install is an **import-time** side effect and `server.ts` imports it first, so lines emitted while
later modules evaluate are captured too. `app/paths.ts` runs before anything can install a mirror — it
has to, it loads `steward.env` — so it now records what it said in `bootNotes`, which the log flushes first.

### From the binary, run out of `/tmp` with nothing of the repo nearby

- Nine routes 200; `/plans` 404s by design.
- `/components.css` byte-for-byte identical to the dev server's, 138,028 bytes — the same number 0009
  recorded, so nothing in the template change moved the cascade.
- `steward.log` written, data directory clean, no `components/`.
- The Sheets card in its not-connected state: "A mirror needs a connected Google account", and no button.

### Smaller things worth recording

- **`location.reload()` after a successful push threw away the message the operator clicked to see.**
  Caught in the browser pass, not by a test. It now updates the timestamp in place and only reloads on
  the first push, which is the one that has to bring back the server-rendered link.
- **`spreadsheets.create` takes no parent** — the file lands in My Drive root and has to be moved with a
  Drive `files.update?addParents`. If that move fails the push still succeeds and says where the file
  actually is, because failing a push over tidiness would be worse.
- **`valueInputOption: 'RAW'`** means a cell beginning with `=` stays text. That is both what a mirror
  means and the answer to formula injection through a customer's notes field.
- **`ensureFolder` was extracted from `GoogleDriveStore`** so the mirror and the document store cannot
  create two different STEWARD folders.
- **`dispatchSteward` is overloaded rather than made async.** `sheet.push` is the only verb that talks to
  Google; naming any other action still returns a plain result, so no existing caller or test grew an
  `await` for a keyword's sake.
- **The disabled-Sheets-API state is unit-tested only.** Google's message and its activation link are
  parsed from a stubbed 403; disabling the API for real to see it would take a console visit and break
  the working connection.
