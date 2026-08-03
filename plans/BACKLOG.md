---
id: backlog
title: STEWARD — what the human asked for after 0010, and what it actually costs
status: intake
owner: admin
created: 2026-08-03
---

# Backlog after 0010

Everything in `plans/0001`–`0010` is closed, committed and pushed (`08842d9`). This file is
the raw intake from the human on 2026-08-03 plus a survey of what already exists. **Nothing
here is designed yet** — no plan number is committed to, and four questions are open.

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

Items 2 and 3 are a verification pass to run **before** any of them.

Suggested order, not agreed: verify pass, then `0013` (highest daily value, fully independent),
then `0012`, `0014`, and `0011` last — it is the only one that can corrupt data.

## OPEN QUESTIONS — asked 2026-08-03, unanswered

Do not start building past these; two of them change the shape of the work entirely.

1. **"Sheet is source of truth" — which reading?**
   (a) A pull runs, and where sheet and database disagree the sheet wins, database rewritten
   to match. (b) The app genuinely reads the sheet, SQLite demoted to a cache.
   (b) means every page load is a Google round trip, works only online, and ends the audit
   trail. **Recommended: (a).**

   Note the standing tension either way: 0010's whole premise is that a spreadsheet write-back
   changes records with no actor, no timestamp and no diff. Any pull must decide what actor to
   record — `sheet:<connected account email>` is the only thing Sheets can tell us, since the
   API does not report who typed a given cell. And the mirror's banner must stop saying
   "edits made here are lost" (`app/google/mirror.ts:48`).

2. **Which mockup should the ticket PDF match?** The only mockup on disk is
   `nimbalyst-local/mockups/steward-shell.mockup.html`, which is the app shell — there is no
   ticket or report layout. Either another file exists that this repo has not seen, or the ask
   means "brand the PDF to match the shell".

3. **Email transport.** Gmail API reuses the existing Google connection but needs the
   `gmail.send` scope, and unlike `drive.file` that scope drags the OAuth app into a Google
   verification review — the exact thing 0006 chose `drive.file` to avoid. SMTP with an app
   password held in the `settings` table avoids the review entirely. Which?

4. **Order.** Confirm or replace the suggested order above.

## Design notes already banked for `0011`

From the design discussion before the human redirected — carry these in, they survive either
reading of question 1:

- Column A of every tab is the STEWARD id (0010 put it there for exactly this).
- The `Progress` tab is keyed by the HUMAN ticket id and its rows have no stable id of their
  own, so it is not pullable as it stands.
- Several columns are **derived projections**, not fields: `client code` on Customers,
  `customer` and `client code` on Tickets. Writing them back is meaningless.
- `createdAt`/`updatedAt` are in the sheet and must never be pull targets.
- A row with a blank id, and a record missing from the sheet, both need a defined meaning.
  Safest is that neither creates nor deletes anything — a filtered or sorted view hides rows,
  and deletion-by-absence would then destroy records nobody touched.
