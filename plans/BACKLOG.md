---
id: backlog
title: STEWARD — what the human asked for after 0010, and what it actually costs
status: intake
owner: admin
created: 2026-08-03
---

# Backlog after 0010

Everything in `plans/0001`–`0010` is closed, committed and pushed (`08842d9`). This file is
the raw intake from the human on 2026-08-03 plus a survey of what already exists. The four
open questions were **answered on 2026-08-03** and the verify pass has been **run** — see below.
Still unwritten: `0011`–`0014` themselves. No plan document exists yet.

Written down so the next session does not re-survey the codebase to learn the same seven facts.

## What the human asked for, verbatim in substance

1. **Make the sheet the source of truth and the app adjusts to it.**
2. Verify generated tickets are made, and that they look like the mockup template (logo).
3. Verify generated tickets and saved attachments are backed up in Drive.
4. When a customer or client is deleted, **archive / soft-delete** them, restorable, and flag
   them in Drive (move to an archived folder).
5. **Automated daily emails** for pending tickets, to an address, with a PDF report in the same
   branding and layout as the mockup, carrying links to the relevant generated Drive files.
   Runs while the desktop app is open, at a configurable time of day, or manually.
6. **Tabs** in the side panel / full page — e.g. for attachments and history.
7. **Better filtering**, not just a search bar.

## Survey — what already exists, done 2026-08-03

Already built. Items 2 and 3 are therefore **verification passes, not builds**:

- Ticket PDF: `GET /tickets/:id/pdf` (`server.ts:901`), rendered by `app/view/pdf.ts`
  (`renderTicketDocument`), branding read off the client at `server.ts:302`.
- Save-to-Drive: `POST /tickets/:id/pdf/save` files a rendered PDF as a document.
- Attachment store: `app/docs/store.ts` (0006), local + `GoogleDriveStore`.

Not built at all:

- **Soft delete.** `AuditAction` already includes `'archive'`, but no entity carries an archived
  flag: `Client` has `active: boolean`, `Customer` has nothing (`app/domain/types.ts:22-46`).
  Needs schema + migration + restore UI + a Drive folder move.
- **Email.** Zero — no SMTP, no mail library, no Gmail call anywhere in `app/` or `server.ts`.
- **Scheduler.** No `setInterval`, no cron, nothing time-driven. Required by item 5.
- **Drawer tabs.** The drawer is GRAIN's organism (adopted in `f5ef0b3`); it has no tab molecule.
- **Real filtering.** Today it is one client-side box that hides non-matching rows —
  `server.ts:200-225`, `filter?: { target, placeholder }`, applied by `steward-live.js`.

## Proposed split — four plans, not one

The sheet inversion rewrites the write path, so it does not share a plan with anything.

| Plan | Scope |
|---|---|
| `0011` | Sheet-driven writes (item 1) |
| `0012` | Archive + restore + Drive archived folder (item 4) |
| `0013` | Daily digest email + PDF report + scheduler (item 5) |
| `0014` | Drawer tabs + real filtering (items 6, 7) |
| `0015` | Bug reporting that opens a GitHub issue (asked for 2026-08-04) |
| `0016` | Release readiness — install instructions, the tag, the first published binaries |

Items 2 and 3 are a verification pass to run **before** any of them.

Order confirmed 2026-08-03: verify pass, then `0013` (highest daily value, fully independent),
then `0012`, `0014`, and `0011` last — it is the only one that can corrupt data.

Extended 2026-08-04: `0015` (bug reporting) and then `0016` (release) after those. **Nothing is
released until every plan is done** — the human's call, recorded below.

**`plans/0013-daily-digest.md` is WRITTEN** and 10 of its 11 tasks are done (2026-08-04); only
the live SMTP send is left, and it waits on a host and app password from the human, who
confirmed on 2026-08-04 that they have not entered them yet. **`plans/0012-archive-restore.md`
is WRITTEN (2026-08-04, status `todo`, eight tasks).** `0011` and `0014` are still unwritten.

Two things `0012` establishes that the others inherit:

- **`Client.active` is retired.** It was never readable, never settable, and never filtered
  anything; `archivedAt` replaces it, and the mirror's `active` column becomes `archived`.
- **The schema gains a migration ladder.** `migrate()` could only ever `CREATE TABLE IF NOT
  EXISTS`; `0012` adds `PRAGMA user_version` steps because it is the first plan that has to
  `ALTER` a table with real rows in it.

`0013` now also carries the ticket-PDF and daily-report mockups (answer 2), since the report
layout is its own deliverable and the ticket layout shares the branding with it.

## ANSWERED — asked and answered 2026-08-03

All four are closed. The answers below are decisions, not proposals.

1. **"Sheet is source of truth" = reading (a).** A pull runs; where sheet and database
   disagree the sheet wins and the database is rewritten to match. SQLite stays the store,
   the app keeps working offline between pulls, the audit trail survives.

   The standing tension still has to be resolved inside `0011`: 0010's whole premise is that a
   spreadsheet write-back changes records with no actor, no timestamp and no diff. The pull
   must record an actor — `sheet:<connected account email>` is the only thing Sheets can tell
   us, since the API does not report who typed a given cell. And the mirror's banner must stop
   saying "edits made here are lost" (`app/google/mirror.ts:48`).

2. **Design a ticket/report mockup first.** No ticket or report layout exists — the only
   mockup on disk is `nimbalyst-local/mockups/steward-shell.mockup.html`, the app shell. A
   `.mockup.html` for the ticket PDF *and* the daily report is a prerequisite for touching
   `app/view/pdf.ts` and for `0013`'s report. The shell mockup is the branding source.

   This changes the verify pass: item 2 cannot be "does the PDF match the mockup" yet. It
   degrades to "does the PDF generate and carry the client's branding/logo at all", and the
   gap between that and the new mockup becomes work inside a later plan.

3. **Email transport: SMTP, app password held in the `settings` table.** No `gmail.send`
   scope, so no Google OAuth verification review — 0006's `drive.file` boundary holds. Works
   against Gmail app passwords or any other SMTP host.

4. **Order confirmed as suggested:** verify pass → `0013` → `0012` → `0014` → `0011`.

## Verify pass — RUN 2026-08-03, both items pass, one defect found

Run against `data/steward.db` (demo data) with `PORT=3211 bun server.ts`, Google connected as
the operator's own account. Evidence, not inference — every claim below was executed.

**Item 2 — ticket PDFs generate and carry branding: PASS.**
`GET /tickets/:id/pdf` returns `200 application/pdf` for every ticket tried. The rendered page
carries the client's `primaryColor` (header rule, section headings), `secondaryColor` (meta
line, log dates, footer), the `companyInfo` block top-right and `pdfFooter` at the foot.
The logo path was **untested until now** because both demo clients have `logoDataUrl: null`
and so fall back to the text wordmark. Rendered with a real data-URL PNG injected, the logo
paints correctly at the head. Nothing to fix in `header()` (`app/view/pdf.ts:20`).

**But no client can ever have a logo.** Found 2026-08-03 while drafting 0013's mockups.
`clientSchema` (`app/view/html.ts:147`) has six fields and none is the logo; `client.create`
writes `logoDataUrl: null` as a literal (`app/actions/steward.ts:196`). No route writes it.

~~`client.update` rebuilds branding from `clientValues` (`server.ts:299`), which omits it and
would therefore **erase** one.~~ **Wrong — corrected 2026-08-04.** `client.update` spreads
`...cur.branding` before applying the form's fields (`app/actions/steward.ts:229`), so a logo
survives an edit. Proved live: uploaded, edited through the door, still there. The field was
unreachable, never fragile. So the field is typed, mirrored around and rendered — and reachable only by
hand-written SQL, which is what this verify pass used. Every client is permanently on the
wordmark. It is `0013`'s `client-logo` task: a multipart `POST /clients/:id/logo`, following
0006's precedent, because the JSON `/intent` door does not take bytes.

**Item 3 — PDFs and attachments reach Drive: PASS.**
`stores.active()` (`server.ts:81`) returns the Drive store whenever Google is connected, for
generated PDFs *and* uploads alike. Verified live end to end:
- `POST /tickets/tkt_def42d05e31c45f7/pdf/save` → `documents` row `storage=drive`, 55 664 bytes,
  real `webViewLink`.
- `POST /files/upload` with a 42-byte text file → `storage=drive`, real `webViewLink`.
- `GET /files/:id/raw` on the uploaded file returned the exact bytes back **out of Drive**, so
  this is a real round trip, not just a row insert.

Both test files are still in the operator's Drive `STEWARD` folder, left as evidence.
Note the three pre-existing `storage=local` rows are from **before** Google was connected;
the backend is chosen per write and is not retroactive.

### DEFECT — the PDF footer is positioned wrongly on every document

`.doc-foot { position: fixed; bottom: -14mm }` (`app/view/pdf.ts:105`) puts the footer below
the page content box. Chrome's `Page.printToPDF` then treats it as overflow. Measured:

| Document | Today (`-14mm`) | With `bottom: 0` |
|---|---|---|
| Short ticket (the normal case) | **2 pages** — page 2 blank but for the footer | 1 page |
| Short ticket, footer blanked | 1 page | — |
| 90-entry ticket | 3 pages | 3 pages |

So **every short ticket PDF ships with a spurious near-blank second page** — including the one
already filed to Drive. On multi-page documents the footer is worse than misplaced: it is a
single fixed element painted at a viewport-derived offset, so on page 2 it lands *on top of*
the progress log — near the top with `-14mm`, near the bottom with `bottom: 0`. Confirmed
visually on both variants.

`bottom: 0` therefore fixes the common case and does not fix the real one. The correct fix is
Chrome's own footer mechanism — `displayHeaderFooter: true` with a `footerTemplate`, margins
moved into the `Page.printToPDF` call (`app/pdf/print.ts:176`) instead of `@page`. That is an
API change to `printToPdf`, so it is **not** applied here: it belongs with `0013`, which
rewrites this layout against the new mockup anyway. Left unfixed deliberately.

**FIXED 2026-08-04 in `0013`'s `pdf-footer`.** A short ticket is one page; a 90-entry ticket is
five, with the footer in the margin of every one, a working `Page N of M`, and nothing
overlapping. Measured by rendering to PNG and looking, not by trusting the page count.

## Releasing, and reporting bugs — asked and answered 2026-08-04

Two new wants, and four decisions that close them. **The release is now the LAST thing that
happens**, not the next: the human's words were *"I'd like our plan to be complete before we
release"*. So `0016` waits on `0012`, `0014`, `0011` and `0015` all being done. An earlier
answer in the same exchange said "after 0012"; this supersedes it.

### What already exists, measured 2026-08-04, not inferred

The binaries are not a thing to build — they are built. `scripts/build.ts` compiles
`bun-windows-x64`, `bun-darwin-arm64` and `bun-linux-x64`; `.github/workflows/release.yml`
runs the full gate and publishes all three plus `SHA256SUMS` on a `v*` tag, with the Windows
target on its own `windows-latest` runner for the icon and hide-console flags. Version is
`0.2.0` and **no tag has ever been pushed**.

The mac binary was rebuilt from the current tree and run: it boots, serves `/components.css`
at exactly 138,028 bytes (the recorded invariant), and renders a real 75,740-byte branded
ticket PDF through packaged Chrome. `build/assets.gen.ts` did not move, so the checked-in
manifest describes the binary. The riskiest packaged path works.

### The four gaps, and what was decided

1. **Gatekeeper refuses the mac binary.** Bun emits `flags=0x20002(adhoc,linker-signed)` and
   `spctl -a -vv` answers `invalid signature`. **DECIDED: ship unsigned.** An Apple Developer
   ID is $99/yr and the audience is the operator and one friend; `0016` documents
   `xattr -dr com.apple.quarantine ./steward-darwin-arm64` instead. Revisit when a stranger
   downloads it.
2. **SmartScreen warns on the unsigned exe.** Same decision, same reason — `0016` documents
   More info → Run anyway. A Windows OV certificate is several hundred a year and reputation
   accrues only with downloads.
3. **The Windows exe has still never been executed.** Unchanged, and it is the one gap money
   cannot close.
4. **Auto-update cannot work while the repo is private.** `app/update.ts:30` reads
   `api.github.com/repos/tjakoen/steward/releases/latest` with no token *by design*, because
   0009 recorded that releases would be public. A private repo answers 404 forever, so the
   updater is inert until the visibility flip.

Also true and worth not rediscovering: the mac target is `arm64` only — no Intel build — and
the machine that runs a binary still needs Chrome or Edge for PDFs, and Ollama for chat.

### Bug reporting — `0015`

**DECIDED: a prefilled GitHub issue URL**, opened in the operator's own browser —
`https://github.com/tjakoen/steward/issues/new?title=…&body=…`. No credential, no new scope,
no server, and it fits 0006's doctrine exactly.

Both alternatives were rejected on the same ground. **A token baked into the binary is a write
credential anyone can pull out of a 61 MB file**, and it cannot be recalled once shipped. A
token in `settings` would make every operator hold a GitHub account and a secret to do the
thing they are least equipped to do. A proxy service needs a server STEWARD does not have.

The transport is the easy half. **The body is the deliverable**: version, platform and arch,
packaged or not, the data directory, whether Google is connected, the surface the reporter was
on, and the tail of `<dataDir>/steward.log` — which 0010 already writes. Cap that tail: URLs
stop working somewhere around 8 KB.

One constraint that decides who can use it at all: **a private repo's issues can only be
opened by collaborators.** The friend on Windows is either added as one, or the repo goes
public first.

## Design notes already banked for `0011`

From the design discussion before the human redirected — carry these in, they survive either
reading of question 1:

- Column A of every tab is the STEWARD id (0010 put it there for exactly this).
- The `Progress` tab is keyed by the HUMAN ticket id and its rows have no stable id of their
  own, so it is not pullable as it stands.
- Several columns are **derived projections**, not fields: `client code` on Customers,
  `customer` and `client code` on Tickets. Writing them back is meaningless.
- **`archived` joins that list** once `0012` lands — archiving is a verb with an audit row, so a
  date typed into that cell must not archive anything. Archived rows stay in the sheet on
  purpose: a row that vanished would be indistinguishable from one a view filtered out, and
  absence already means "neither create nor delete" below.
- `createdAt`/`updatedAt` are in the sheet and must never be pull targets.
- A row with a blank id, and a record missing from the sheet, both need a defined meaning.
  Safest is that neither creates nor deletes anything — a filtered or sorted view hides rows,
  and deletion-by-absence would then destroy records nobody touched.
