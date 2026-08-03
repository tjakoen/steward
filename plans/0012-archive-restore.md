---
id: 0012-archive-restore
title: STEWARD — archive instead of delete, restore afterwards, and a Drive folder that agrees
status: todo
owner: admin
created: 2026-08-04
milestone: M3 (ship it)
tags: [archive, soft-delete, migration, drive, audit, mirror]
tasks:
  - id: migration-ladder
    title: A migration that can ALTER — the schema has only ever been able to CREATE
    status: todo
  - id: archived-column
    title: archivedAt on clients and customers, and the death of the dead `active` flag
    status: todo
  - id: repo-filter
    title: Filtering by descent in SQL, so no caller has to remember to ask
    status: todo
  - id: archive-verbs
    title: client.archive / client.restore / customer.archive / customer.restore
    status: todo
  - id: archived-views
    title: Somewhere to see what was archived, and a way back
    status: todo
  - id: drive-archived-folder
    title: STEWARD/Archived — move the files, best-effort, and move them back
    status: todo
  - id: mirror-column
    title: The mirror keeps archived rows and says so, because deleting rows reads as loss
    status: todo
  - id: verify
    title: The gate — the digest is the one that bites, and only running it proves anything
    status: todo
---

# STEWARD — archive and restore (0012)

The human's fourth want, verbatim in substance: *when a customer or client is deleted,
archive / soft-delete them, restorable, and flag them in Drive by moving them to an archived
folder.*

Second in the confirmed order (`plans/BACKLOG.md`), after `0013`. It touches the read path of
every list in the app, which is why it comes before `0014`'s filtering and well before `0011`'s
writes.

## There is no delete to soften

The ask says "when a customer or client is deleted", which reads like there is a delete button
to change. There is not. `remove(id)` exists on every repository (`app/repo/ports.ts:24,33,43`)
and the only caller in the entire codebase is the demo reseed
(`app/seed/demo.ts:20-22`). No route, no action in `STEWARD_ACTIONS`
(`app/actions/steward.ts:13-18`), no button anywhere reaches it.

So this plan is not "replace delete with archive". It is **"give STEWARD the delete it never
had, and make that verb archive"** — which is the better order of events, because it means no
hard delete has ever run against real data and there is nothing to migrate back from.

`remove()` stays where it is, unexported from the UI, because the demo reseed genuinely wants
rows gone. That it is reachable only from a code path the operator cannot invoke is the point.

## `active` is a flag that has never meant anything

`Client.active` (`app/domain/types.ts:27`) is set to `true` at create
(`app/actions/steward.ts:203`), stored as an integer (`app/repo/sqlite.ts:87`), and mirrored to
the Clients tab as `yes`/`no` (`app/google/mirror.ts:79`). Nothing ever reads it to filter
anything, and nothing can set it to `false` — there is no form field and no route. It is
`logoDataUrl` all over again: a field that is written, carried and displayed, and unreachable.

**Do not build archive on top of it.** Two flags that both mean "not really here any more" is a
bug generator, and `active` cannot answer *when*, which is the first thing anyone asks of an
archived record. Instead:

- **`archivedAt TEXT` (nullable, ISO 8601) on `clients` and `customers`.** Null means live.
  A timestamp means archived, and carries the date on its face.
- **`active` is retired.** `Client.active` comes off the type and the column stops being read;
  it is derived from `archivedAt === null` wherever something genuinely wants a boolean.

Leave the `active` **column** in place rather than dropping it. SQLite can drop a column now,
but a `NOT NULL DEFAULT 1` column costs nothing to leave, and dropping it is a destructive
migration in exchange for tidiness. Stop writing it, stop reading it, and say in `db.ts` that it
is vestigial — 0011 will otherwise find it in the sheet and wonder.

Who archived it is not a new column: the audit row already carries the actor.

## The schema has never been able to change

`migrate()` (`app/repo/db.ts:36`) is one `CREATE TABLE IF NOT EXISTS` block. It is idempotent
and it has been enough for eleven plans, because every table was born complete. **It cannot add
a column to a database that already has rows**, and `data/steward.db` has rows — the operator's
real ones, plus the Drive evidence from the verify pass.

So this plan lays the first rung of a ladder. Keep it small:

- `PRAGMA user_version` as the version, an array of steps, each step a function that runs inside
  a transaction, and a loop that runs the ones above the current version. The `CREATE TABLE`
  block stays exactly where it is and runs first, so a fresh database is still born complete and
  then reports itself already at the latest version.
- Step 1 is `ALTER TABLE clients ADD COLUMN archivedAt TEXT` and the same for `customers`.

Three traps, written down before someone rediscovers them:

- **A fresh database must not run the ladder.** `CREATE TABLE` gives it the column already, so
  `ALTER TABLE` would fail with `duplicate column name`. Set `user_version` to the latest
  immediately after the create block when the database was empty; a database that already exists
  reports 0 and takes the steps.
- **`ADD COLUMN` cannot be `NOT NULL` without a default.** Nullable `TEXT` is what we want
  anyway, so this costs nothing — but it is why `archivedAt` is a nullable timestamp rather than
  an `archived INTEGER NOT NULL DEFAULT 0`.
- `setDb()` (`app/repo/db.ts:30`) also calls `migrate`, so every test that spins up `:memory:`
  runs the ladder too. That is wanted — it is the cheapest possible test of the fresh-database
  path — but it means a slow step would be paid 28 times per test run. Keep them cheap.

## Archiving a client does not stamp its children

A client owns customers; a customer owns tickets. Archiving a client must obviously take its
customers and tickets out of the lists with it. There are two ways to do that and only one of
them survives a restore:

- **Stamp every descendant.** Archiving a client writes `archivedAt` onto all its customers.
  Restoring then has to un-stamp them — including the ones that were *already archived on their
  own* before the client was, which are now indistinguishable. That is a data-loss bug with a
  smiling face on it.
- **Filter by descent.** Only the record the operator acted on is stamped. A customer is
  *hidden* when it is archived **or its client is**. Restoring the client restores exactly the
  state that was there before, because nothing else was ever touched.

Take the second. Its cost is that "is this visible" is no longer one column on one row, so
**the filter belongs in the repository's SQL, not in each caller** — a `LEFT JOIN` on the
parent in `customers.list`, and on customer-then-client in `tickets.list`. Every caller that
forgets is a leak, and there are a dozen callers.

Tickets get no `archivedAt` of their own. The human asked for customers and clients; a ticket
that is finished has `Completed`, which is the status the app already has for it.

## Where archived records must vanish from, and where they must not

The list is longer than the three index pages, and the one that actually bites is the digest.

**Must hide.** `/clients`, `/customers`, `/tickets` and the drawer lists; the nav counts
(`server.ts:204-206`); `searchCustomers` (`app/repo/sqlite.ts:124`); the client page's customer
list (`server.ts:473`) and ticket list (`server.ts:493`); every client/customer **picker** on a
create form, because a new ticket must not be fileable against an archived customer; the AI
reasoner's `customers.list()[0]` (`app/ai/reasoner.ts:25`).

**And `app/mail/digest.ts:111-125`.** An archived customer's `In Progress` ticket landing in
tomorrow morning's email is the failure everyone would actually notice, and it is the one a
`tickets.list()` that forgot to filter produces silently. `buildWorkspace` reads all three
lists; if the repository filters, it is fixed for free — which is the whole argument for
putting the filter in SQL.

**Must NOT hide.**

- **The audit trail.** Append-only, and an archived record's history is exactly what someone
  asks for later. `auditFor` filters nothing.
- **The record's own page by direct URL.** Old digests, old PDFs and the operator's own
  bookmarks point at it. It renders, badged `Archived` with the date, with its actions
  disabled and a **Restore** button. A 404 here is the app losing data as far as the reader
  can tell.
- **`/files`.** The documents are still real files in Drive; a document list that silently
  shortens is worse than one that shows where a file came from.

## Somewhere to see what was archived

An archived record is invisible by construction, so restore needs a door. The minimum that is
not a dead end: **an `Archived` view on each list** — `/clients?archived=1` — showing only the
stamped rows, with the date and a Restore button, and a link to it from the live list that
appears only when the count is non-zero.

This is deliberately the cheap version. Real filtering is `0014`'s job and it will want
archived-vs-live as one facet among several; building a filter framework here would be
`0014` arriving early and badly. Write the query so `0014` can absorb it: one
`archived?: boolean` argument on the repository read, defaulting to live.

**Archiving asks first.** It is reversible, so it does not need a typed confirmation, but it
does need a sentence saying what will happen — "this hides the customer and its 3 tickets from
every list; you can restore it later" — with the counts computed rather than guessed.

## The verbs, and the door they go through

`client.archive`, `client.restore`, `customer.archive`, `customer.restore` in
`STEWARD_ACTIONS`, dispatched in `app/actions/steward.ts` like every other verb. Same reason as
`sheet.push` and `digest.send`: the `/intent` door is the only door, so the AI can archive on
request without a second mechanism, and the button is an intent like all the others.

`AuditAction` already has `'archive'` (`app/domain/types.ts:113`) — it has been sitting there
unused since 0001. **`'restore'` is not there and has to be added**, along with its label in
the audit-line map (`app/view/html.ts:312`, `archive: 'archived'`).

The audited diff is `{ archivedAt }` on the way in and `{ archivedAt: null }` on the way out.
Small, exact, and no risk of the `updateClient` problem where a patch carried half a megabyte
of base64 into an append-only table.

## Drive, and the folder that has to agree

The ask is explicit that archiving flags the record in Drive. The precedent is already in the
codebase twice over:

- `ensureFolder(token, name, fetch)` (`app/google/folder.ts:17`) finds-or-creates by name.
- The Sheets mirror moves an existing file with
  `PATCH /files/{id}?addParents={folder}&removeParents=root` (`app/google/sheets.ts:165`).

So: **`STEWARD/Archived`**, a subfolder. `ensureFolder` searches by name with no parent
constraint, so it needs a `parentId` argument (and `parents: [parentId]` on create) or a
sibling `ensureSubfolder` — otherwise a folder named `Archived` that the operator already has
would be found instead. Under `drive.file` we only see our own files, which narrows but does
not eliminate that.

What moves: every document of the archived customer **and of its tickets** — that is the
`forEntities` bulk read `0013` added, used again. Restore moves them back to `STEWARD`.

Three things this must not do:

- **It must not fail the archive.** Drive is a network call and the archive is a local database
  write. Stamp first, move second, and report a Drive failure as a note the way the mirror does
  (`app/google/sheets.ts:169`) — "archived; the files could not be moved". A half-moved set is
  fine and re-runnable; a record that failed to archive because Google was down is not.
- **It must not touch local-storage documents.** `storage='local'` rows have no Drive file.
  Skip them, and do not treat that as an error — the three rows from before Google was
  connected are exactly this case.
- **It must not run at all when Google is not connected.** `stores.active()`
  (`server.ts:90`) already answers that question; archive is a local operation with an optional
  Drive consequence.

## The mirror keeps archived rows

The Clients and Customers tabs currently carry `active`. Replace that column with **`archived`**
— the date, or blank — and keep exporting archived rows.

Removing them from the sheet would be the honest-looking choice and it is the wrong one twice
over: to the operator a row vanishing from a spreadsheet reads as data loss, and `0011` is going
to pull from this sheet, where a missing row already has a defined meaning ("hides nothing,
deletes nothing" — `plans/BACKLOG.md`). An archived record that simply disappeared would be
indistinguishable from one filtered out of a view.

This is a header change to a sheet the operator may already have open, so `0011` inherits it:
note in that plan's intake that `archived` is a **derived, non-pullable** column, like
`client code` on Customers. Typing a date into it must not archive anything — archiving is a
verb with an audit row, not a cell.

## Verify — the gate

`tsc` sees none of this. What has to be executed:

- **Migration against a real database with rows.** Copy `data/steward.db`, run the server
  against the copy, confirm `archivedAt` exists, every existing row is null, and no row was
  lost. Then run it a second time and confirm the ladder is a no-op. Then a fresh `:memory:`
  database, to prove the create-block path does not try to `ALTER`.
- **Archive a customer and read every surface.** Gone from `/customers`, from the nav count,
  from search, from its client's page, from the new-ticket picker. Still at its own URL, badged,
  with its audit trail intact.
- **Archive a client and check descent.** Its customers and its tickets all vanish; none of
  them gained an `archivedAt`; restoring the client brings back exactly what was there — proved
  by archiving one of its customers *first*, then the client, then restoring the client, and
  confirming that customer is still archived.
- **The digest.** `POST` a manual send with an archived customer holding a pending ticket and
  confirm the ticket is not in the report. This is the surface where a missed filter is
  invisible until a real morning email is wrong.
- **Drive.** Archive a customer that has a saved PDF and an upload; look in Drive and see them
  in `STEWARD/Archived`; restore and see them back in `STEWARD`. Then archive with Google
  disconnected and confirm it still archives and says nothing about Drive.
- **The mirror.** Push, and see the archived row still present with a date in the `archived`
  column.

## Still open, and deliberately not decided here

- **Archiving a client with live customers.** The confirmation states the count and proceeds.
  Whether it should instead refuse until the customers are dealt with is a policy question, and
  the reversible verb makes the permissive answer safe.
- **Purge.** Nothing here ever deletes. If archived records should eventually be removable for
  real, that is a different verb with a different confirmation, and nobody has asked for it.
- **Archived tickets.** By descent only, per above. If a ticket ever needs archiving on its own
  the column goes on `tickets` and the descent rule already covers the rest.
