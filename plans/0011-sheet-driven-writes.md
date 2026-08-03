---
id: 0011-sheet-driven-writes
title: STEWARD — the sheet writes back, and the six ways that destroys the database
status: todo
owner: admin
created: 2026-08-04
milestone: M3 (ship it)
tags: [sheets, google, pull, sync, data-integrity, audit, conflict, destructive]
tasks:
  - id: sheet-read
    title: The API layer can only write — give app/google/sheets.ts a read
    status: todo
  - id: mirror-columns
    title: A shape a pull can key on — split the persons join, mark the derived columns
    status: todo
  - id: coerce
    title: A cell is a string, a number, or a lie — and the lie must not be guessed at
    status: todo
  - id: pull-plan
    title: The diff, computed without touching the database
    status: todo
  - id: preview
    title: The dry run, and the blast radius that refuses to apply
    status: todo
  - id: repo-transaction
    title: A Repositories port that can wrap a whole pull, audit rows included
    status: todo
  - id: apply
    title: One transaction, through the services, actor `sheet:<account>`
    status: todo
  - id: interlock
    title: A push that refuses to overwrite an edit nobody pulled
    status: todo
  - id: guards
    title: The banner stops lying, and the columns say which of them count
    status: todo
  - id: pull-intent
    title: `sheet.pull` previews and never applies
    status: todo
  - id: settings-surface
    title: The two-step card — see it, then mean it
    status: todo
  - id: verify
    title: The gate — every destructive case, executed against a real spreadsheet
    status: todo
---

# STEWARD — sheet-driven writes (0011)

The human's first want, and the last thing built: *make the sheet the source of truth and the
app adjusts to it.* It is last on purpose. Every other plan in this milestone adds something;
this one is the only one that can take something away, silently, from records nobody was
looking at. `plans/BACKLOG.md` sequenced it behind `0013`, `0012` and `0014` for exactly that
reason, and nothing here is worth moving it forward.

What "source of truth" means was answered on 2026-08-03 and is not reopened: **it means
reading.** A pull runs; where the sheet and the database disagree, the sheet wins and the
database is rewritten to match. SQLite stays the store, the app keeps working offline between
pulls, and the audit trail survives. It does **not** mean the spreadsheet becomes the database,
and it does not mean continuous synchronisation.

## The thing 0010 said, and the answer it is owed

`plans/0010-sheets-sync.md` did not decline a write-back for want of time. It declined it with
an argument, repeated in the header of `app/google/sheets.ts:11-13`: *a spreadsheet that wrote
back would change records with no actor, no timestamp and no diff.* That is three claims, and
this plan has to answer all three or it is building the thing 0010 refused to build.

**Timestamp and diff are easy and are not negotiable.** A pull writes through
`app/services/index.ts` like every other mutation, so `audit()` (`app/services/index.ts:27-33`)
appends a row with `at` and a `diff` in the same call as the write. The diff carries **only the
fields that actually changed**, not the whole row — a pull that patches nine unchanged fields
alongside one changed one produces an audit row saying "9 details changed", which is a lie with
a timestamp on it.

**Actor is the hard one, and the honest answer is smaller than it looks.** The Sheets API does
not report who typed a given cell. `values.get` returns values; it does not return authorship.
The Drive Revisions API can name who saved a revision, but a revision is the whole file and
still attributes no individual cell, and polling it would be a second API and a second story.
So the actor is **`sheet:<connected account email>`** — `settings.get('google.account')`, which
`app/google/oauth.ts:113-123` fills from Drive's own `about.user.emailAddress` at connect time,
with `ensureAccount()` (`app/google/oauth.ts:162-166`) as the backfill for connections made
before we knew how to ask.

That string means: *this change arrived through the spreadsheet, on the account connected to
this STEWARD*. It does not mean that person typed it, and the plan does not pretend it does.
Two consequences follow and both are deliberate:

- `rememberAccount` swallows its own failures (`app/google/oauth.ts:122`), so the account can be
  null. Then the actor is **`sheet:unknown`**, not `human`. Falling back to `human` would put a
  false attribution into an append-only table, which is worse than an honest blank.
- `.audit__actor` styles `[data-actor="ai"]` specially (`frontend/client/steward.css:367-368`)
  and lowercases everything else, so a `sheet:` actor renders as an ordinary badge. Give it its
  own rule — `[data-actor^="sheet:"]` — because the whole point of the actor is that a reader
  scanning the timeline can see at a glance which changes did not come through the app's doors.

So: 0010 was right that a naive write-back has no actor. This plan does not produce a full
actor either. It produces a *provenance*, plus the timestamp and the diff 0010 also asked for,
and it says out loud which of the three is only partly answered.

## What the API layer can do today, which is nothing

Worth stating plainly because it is the first task: **`app/google/sheets.ts` has no read path
at all.** It reads spreadsheet *metadata* — `GET /spreadsheets/{id}?fields=sheets.properties`
(`app/google/sheets.ts:179-181`) — to learn tab ids, to notice a tab the operator deleted, and
to discover by 404 that the file is gone. It never reads a cell. `values:batchGet` does not
appear anywhere in the repository; 0010's "read it back and compare cell-for-cell" verification
was done by hand, not by code that survived.

`sheet-read` adds it, in the shape the rest of the file already uses: the same `call<T>` helper
(`app/google/sheets.ts:81`), the same injected `Fetcher`, the same "return a reason rather than
throw when not connected" contract (`app/google/sheets.ts:260-263`). One `values:batchGet`
covers all four tabs in a single request.

### Read it twice, and know why

`values:batchGet` takes one `valueRenderOption` for all its ranges, and neither option is
sufficient alone:

- **`FORMATTED_VALUE`** (the default) returns what the operator sees, rendered in the
  spreadsheet's locale. A date cell comes back as `4/8/2026`, and whether that is 4 August or
  8 April depends on a locale setting in someone else's Google account.
- **`UNFORMATTED_VALUE`** returns the underlying value. A date cell comes back as a **serial
  number** — days since 1899-12-30 — which is unambiguous. But a text field that happens to
  hold digits comes back as a JSON number, and `JSON.parse` has already destroyed the precision
  of a sixteen-digit external id before our code sees it.

So the pull issues **two `batchGet` calls** — one of each — and uses the pair. The unformatted
value tells us the cell's *type*; the formatted value tells us what the operator *meant*. Two
requests plus one Drive call per preview, against a 60-per-minute quota, is not a cost worth
optimising away.

Note that the push writes with `valueInputOption: 'RAW'` (`app/google/sheets.ts:238`), so every
cell STEWARD itself wrote is stored as a **string** and round-trips as one. It is only the
cells a human typed — which is precisely the set a pull cares about — that Sheets has parsed.

### The trap that eats the last column

`values.get` **truncates trailing empty cells and trailing empty rows.** A row whose last three
columns are blank comes back three elements short, and a tab whose last data rows were cleared
comes back with fewer rows than the grid holds. Read naively, index 9 of a short row is
`undefined`, and `undefined` reads as "unchanged" when it means "cleared".

Every row is therefore **padded to the header width before anything indexes into it**, and the
absence of a row is never the same thing as a row of blanks. This is one line of code and it is
the difference between "the operator cleared the notes" and "the notes are silently immortal".

## Row identity is column A, and column A does not save you

0010 put the STEWARD id in column A of every tab for exactly this
(`app/google/mirror.ts:78-95`, `plans/0010-sheets-sync.md:109-111`). The pull keys on it and
**ignores row order entirely** — the sheet is read into a map, not a list. That answers three of
the four things people do to spreadsheets:

- **Sorting** is free. A tab sorted by title pulls identically to one sorted by id, because
  position carries no meaning.
- **A row with a blank id is ignored.** Per the banked decision: a pull creates nothing. An
  inserted row is a person starting to type something, and a half-typed customer is not a
  customer.
- **A record absent from the sheet is ignored.** A pull deletes nothing. A filtered view, a
  hidden row, a tab someone was tidying — all of these look identical to a deletion, and
  deletion-by-absence would destroy records nobody touched.

The fourth thing is the one that matters. **Someone pastes a block and every id shifts down a
row.** Now every row has a valid id and the wrong values beside it. There is nothing in the
data that distinguishes this from a legitimate bulk edit — the ids are real, the values are
real, the types all check. No algorithm finds it. Only a human looking at a list of proposed
changes finds it.

That is why the preview is not a nicety, and it is why the preview is backed by a blunt
instrument:

- **Duplicate ids in a tab fail the whole pull.** A paste that duplicates a block produces them,
  and there is no defensible way to choose between two rows claiming the same record.
- **An id STEWARD does not recognise is skipped and *reported*,** with a count, never silently.
  A record can legitimately have gone (a demo reseed, a future purge), but a rising count of
  unknown ids is the sheet drifting away from the database.
- **If *every* id is unknown, the pull is refused outright.** That is the signature of pulling
  from the wrong spreadsheet, and it is the one case where a partial answer is worse than none.
- **A pull that would change more than a quarter of the records, or more than twenty-five of
  them, refuses to apply** without a second, explicit acknowledgement that names the paste
  scenario in words. Bulk edits in a spreadsheet are legitimate and common; so is the accident
  that looks exactly like one. The threshold is a speed bump, not a security control, and it is
  the only thing standing between a shifted paste and a mass overwrite.

## Which columns are actually pullable

Most of them are not, and the reasons differ. Getting this list wrong is how a pull corrupts
data while doing exactly what it was told.

**Structurally impossible already, which is worth knowing before designing around it.**
`NewClient`, `NewCustomer` and `NewTicket` (`app/repo/ports.ts:15-21`) omit `id`, `archivedAt`,
`createdAt` and `updatedAt`, and `NewTicket` also omits `ticketId`. Since every repository
`update` takes a `Partial<New*>` (`app/repo/ports.ts:28,39,51`), the compiler already forbids
pulling any of them. The banked note that `createdAt`/`updatedAt` must never be pull targets is
therefore not a rule this plan enforces — it is a rule the type system enforces, and the plan's
job is to not go around it.

**Derived projections.** These are computed at push time and mean nothing written back:

- `client code` on Customers — `clientCode.get(c.clientId)` (`app/google/mirror.ts:83`).
- `customer` and `client code` on Tickets — `personsLabel(customer)` and the same lookup
  (`app/google/mirror.ts:90-91`).
- `archived` on Clients and Customers, which is 0012's column
  (`plans/0012-archive-restore.md:226-239`, and `c.archivedAt ?? ''` at
  `app/google/mirror.ts:79`). Archiving is a verb with an audit row and a Drive consequence, not
  a cell. A date typed there must archive nothing.

Re-parenting is the reason these are not merely useless but dangerous. Changing a Ticket's
`client code` cell reads like a request to move a ticket to another client; honouring it would
re-parent a ticket through a column that is not even the parent's key. It is not a cell.

**Identifiers the sheet itself joins on.** `code` on Clients is the value the Customers and
Tickets tabs display as `client code`. Reading a rename out of the same document that is
internally inconsistent about it during the read is a bootstrapping problem with no good
answer, so **client `code` is not pullable.** Rename it in the app and push.

**`customer code` is not pullable, and this one is a real find rather than a policy.**
`Customer.code` feeds `makeTicketId(code, seq)` (`app/ids.ts:13-18`) at ticket creation, and the
resulting `ticketId` is stored on the ticket forever. Editing the code in the sheet would leave
every existing ticket carrying the old code inside its human id, with nothing anywhere saying
why. The Progress tab, which is keyed by that human id, would half-agree with the Tickets tab.
This is not in the banked notes and it should be.

**`last updated` on Tickets is not pullable.** It is a domain field and it *is* in `NewTicket`,
so it would work — which is the problem. It is the app's own record of when the work moved, and
a stale copy of the sheet could make a ticket look fresher than it is and change what tomorrow's
digest says. The pull **stamps it itself** on any ticket it changes, exactly as every other
mutation does.

There is a wrinkle underneath that, found while surveying and worth writing down: STEWARD
already writes `dateLastUpdated` in **two formats**. `app/actions/steward.ts:144` writes
`today()` — a bare `YYYY-MM-DD` (`app/actions/steward.ts:58`) — while
`app/services/index.ts:92` and `:101` write a full ISO timestamp. Both land in the same column,
the mirror exports both (`app/google/mirror.ts:92`), and a pull that round-tripped the column
would have to preserve the distinction to avoid rewriting rows it never meant to touch. Making
the column non-pullable dodges it; it does not fix it, and it is worth a separate bug.

**`persons` is not pullable as it stands, and that is a hole this plan has to fill.**
`personsLabel` (`app/google/mirror.ts:54-55`) renders `"Family, Given and Family, Given"`. That
join is not invertible: a family name containing `" and "`, a given name containing a comma, or
a single-word entry all parse wrong — and wrong here means a customer's *name* is corrupted by
a process that reported success. Parsing it back was considered and rejected on that ground
alone.

But a CRM whose spreadsheet is the source of truth and cannot fix a misspelled surname is not
the feature that was asked for. So `mirror-columns` **adds explicit `given`, `family`,
`given 2`, `family 2` columns to the Customers tab** and demotes `persons` to a derived display
column beside them. The push builds all five; the pull reads the four. `personsFrom`
(`app/actions/steward.ts:47-52`) already encodes the exact rule — a second person exists only
when both its given and family names are present — so the pull reuses that shape rather than
inventing a second one. This changes `HEADERS` (`app/google/mirror.ts:32-43`) and the row
builder, which is a change to a spreadsheet the operator may already have open, and the push
already handles a header change by rewriting the file wholesale.

**What is left, and it is a real list.** Clients: `name`. Customers: `given`, `family`,
`given 2`, `family 2`, `email`, `phone`, `external id`, `notes`. Tickets: `title`, `status`,
`initiated`, `waiting on`, `waiting since`, `next action`, `summary`. Branding is not pullable
because it is not mirrored at all (`app/google/mirror.ts:60-63`), and `commRefs` likewise.

## The Progress tab stays out, and it is not coming in this plan

The banked note says the `Progress` tab is keyed by the human ticket id and its rows have no
stable id of their own, so it is not pullable as it stands
(`app/google/mirror.ts:101-103`). Two ways to change that, and neither is worth it here:

- **Give `ProgressEntry` an id** (`app/domain/types.ts:72-75`). That is a domain change plus a
  rewrite of every ticket's `progressLog` JSON blob — a migration on the ladder 0012 has only
  just built (`app/repo/db.ts:52-56`) — in service of a tab that is an append-only narrative.
- **Key on `(ticket id, date, update)`.** Any edit to the text changes the key, so an edit is
  indistinguishable from a deletion plus an insertion, and a pull that creates and deletes
  nothing can express neither.

**Decision: the Progress tab is never read back, and the tab says so in its own banner.** The
app already has a first-class verb for the only thing anyone wants to do to it — `ticket.progress`
(`app/actions/steward.ts:166-174`), which audits properly and stamps the date — and pointing at
that verb is a better answer than a half-working parse.

## A cell is a string, a number, or a lie

This is the heart of the plan. The repository layer validates **nothing**: `toTicket` casts
`r.status as Ticket['status']` (`app/repo/sqlite.ts:78`) with no check, dates are plain `TEXT`
with no format, and `update` is a spread (`app/repo/sqlite.ts:108,168,242`) that will happily
store whatever it is handed. The only validation in the codebase lives in the action layer —
`TICKET_STATUSES.includes(status)` at `app/actions/steward.ts:136` and `:153`. So **a pull that
does not validate is a pull that corrupts, and there is no safety net below it.**

The rules, each with the failure it prevents:

- **Everything is trimmed. A cell of only whitespace is empty.**
- **Empty means cleared, in an optional field.** Blanking `notes` clears the notes, because the
  sheet wins and the operator deleting the text meant it.
- **Empty is rejected in a required field** — a client's `name`, a customer's `family`, a
  ticket's `title` or `status`. Clearing a required field is the shape of an accident, not an
  edit, and the domain has no representation for it.
- **A status must be one of the four in `TICKET_STATUSES` (`app/domain/types.ts:64-69`), exactly.**
  Trimmed but not case-folded, not fuzzy-matched. `in progress` is rejected, and the message
  names all four legal values. Accepting near-misses trains the sheet to be sloppy about the one
  field that drives the board columns and tomorrow's digest.
- **A date is `YYYY-MM-DD`, or a Sheets serial, and nothing else.** An unformatted value that is
  a string matching `^\d{4}-\d{2}-\d{2}$` is taken as is. An unformatted value that is a
  *number* is a real date cell, converted from the 1899-12-30 epoch. Anything else — `4/8/2026`
  typed as text, `Aug 4`, `04-08-26` — is **rejected and named**, never guessed. Guessing between
  DD/MM and MM/DD is how a `waiting since` lands four months out with nobody the wiser.
- **A number arriving in a text field is taken from the formatted read, not the unformatted
  one**, because that is the only one that survived Sheets' own rendering with its digits
  intact.

## Invalid means the whole pull stops

Three options, and the plan picks one and lives with it. **All-or-nothing: validate the entire
sheet first, and if anything is wrong write nothing at all.**

Partial application is rejected because half of a document applied is a state neither the sheet
nor the database describes, and the operator cannot tell which half landed. Per-row skip with a
report is rejected for the same reason with an extra edge: the audit trail would record real
changes interleaved with phantoms, and the operator's mental model — "I edited the sheet, then
I pulled" — would be wrong in a way nothing on screen corrects.

The objection is obvious: one bad cell blocks two hundred good rows. It is answered by where
the fix goes. The report names the cell in A1 notation — `Tickets!F7` — the operator fixes it
in the sheet in five seconds, and re-pulling is free. Whereas "apply the good rows" hands them
the job of working out which of their edits landed.

Two things make this cheap rather than pious. Validation happens entirely in the **preview**,
before a single write, so a failing pull never even opens a transaction. And the workspace is
small — two clients, six customers, six tickets today; a thousand records is still one
transaction and one screenful of diff.

### The transaction, and the trap inside it

`Repositories` has no transaction (`app/repo/ports.ts`), and an all-or-nothing pull needs one
that covers **the writes and their audit rows together** — `repos.audit.append` is a separate
`INSERT` (`app/repo/sqlite.ts`), so a rollback that spared the audit rows would leave a history
of changes that did not happen.

`repo-transaction` adds `transaction<T>(fn: () => T): T` to the `Repositories` port, implemented
with `Database.transaction` in SQLite — which `app/repo/db.ts:168` already uses for the
migration ladder — and as a plain call in any in-memory fake.

**`bun:sqlite` transactions are synchronous. The callback must not await.** So the pull is
strictly ordered: fetch from Google, build the plan, validate, *then* apply synchronously. Any
temptation to check something against the network mid-apply breaks the transaction, and it will
break it quietly.

## Concurrency, and the push that eats an edit

The mirror is destructive by design: clear, then write (`app/google/sheets.ts:227-241`). Today
that is stated and accepted. Once a pull exists it becomes a data-loss bug, because the operator
now has a legitimate reason to type into the sheet and a real expectation that their typing
survives.

**The interlock: a push refuses when the mirror has been modified since STEWARD last wrote it.**
One Drive call, `GET /files/{id}?fields=modifiedTime` against the `DRIVE_FILES_API`
(`app/google/folder.ts:7`) the mirror already uses to file itself
(`app/google/sheets.ts:165`). If the file moved on, the push returns `ok: false` with a reason
naming the pull — *"the mirror has been edited since the last push; pull those edits first, or
push anyway and lose them"* — and `/sheets/push` grows a `force` flag for the deliberate
discard. It refuses rather than pulling automatically, because a push and a pull are opposite
acts and STEWARD guessing which one was meant is worse than asking.

**Compare Google's clock to Google's clock.** The obvious implementation compares `modifiedTime`
against `settings.get('sheets.pushed_at')` (`app/google/sheets.ts:25-29`), which is
`new Date().toISOString()` on the laptop (`app/google/sheets.ts:265`). That bets the operator's
data on the laptop's clock agreeing with Google's. Instead, store **`sheets.modified_at` — the
`modifiedTime` Drive reports *after* the push completes** — and compare that. Clock skew stops
mattering entirely.

**And the preview must apply from the revision it previewed.** The operator runs a preview,
reads it, thinks, and clicks apply; meanwhile somebody with the share link is still typing. So
the preview carries the `modifiedTime` it read, the apply re-reads and **refuses if it moved**.
Caching the plan server-side instead would be state with a lifetime and a leak; re-reading is
one call and always correct.

**The third conflict is the real one**, and it is the one the phrase "the sheet wins" exists to
settle: a record changed *in STEWARD* since the last push, and also in the sheet. The sheet
wins — that is the answer — but the operator must **see** it. A record whose `updatedAt` is
later than `sheets.pushed_at` is flagged in the preview: *"also changed in STEWARD since the
last push; the sheet's value will replace it."* Cheap to compute, and it is where this plan
earns the word "conflict" instead of merely using it.

## The mirror's own guards have to change, and change into something true

Today three guards say the file is untouchable, and after this plan all three are wrong:

1. The title is `STEWARD mirror (read-only)` (`app/google/mirror.ts:30`). It becomes
   **`STEWARD mirror`**. Renaming is a Drive `files.update` with a `name`, done once rather than
   on every push; the file id does not change, so existing share links and bookmarks are fine.
2. The banner (`app/google/mirror.ts:48-51`) says *"edits made here are lost"*. It becomes, on
   the three pullable tabs: **"STEWARD mirror. Column A is the record id — never change it.
   The white columns are read back when someone runs a pull; the grey ones are not. A push
   overwrites everything. Last pushed: <ts>. Last pulled: <ts>."** On Progress it stays honest
   about that tab specifically: **"This tab is never read back — log progress in STEWARD.
   Rewritten on every push."**
3. The protected range is one `warningOnly: true` range over the whole tab
   (`app/google/sheets.ts:107-118`). It becomes **several ranges with different descriptions** —
   Sheets shows the description in its own warning dialog, so the derived columns can say *"this
   column is computed by STEWARD and is not read back"* while the id column says *"changing this
   re-points the row at a different record"*. `warningOnly` stays for the reason 0010 gave: the
   operator owns the file and a hard protection would be a permissions fight rather than a
   guard.

Add one thing 0010 did not need: **shade the non-pullable columns grey**, one `repeatCell` with
a `userEnteredFormat.backgroundColor` in `dressRequests` (`app/google/sheets.ts:99-124`). A
colour is the only guard that reaches somebody before they type, rather than after.

The Settings card carries the same correction — it currently says *"STEWARD never reads it
back"* and *"Edits made in the spreadsheet are lost"* (`server.ts:1400-1401`), and both
sentences become false the day this ships.

## The doors: preview is a verb, apply is a decision

`sheet.pull` joins `STEWARD_ACTIONS` (`app/actions/steward.ts:13-18`) and is dispatched exactly
as `sheet.push` is (`app/actions/steward.ts:216-230`) — the async overload
(`app/actions/steward.ts:94-108`) already exists for outward-facing verbs, and a third one adds
nothing new to it. `StewardDeps` (`app/actions/steward.ts:74-77`) gains `pullSheet`, wired at
the composition root beside `pushSheet` (`server.ts:783`).

**But `sheet.pull` runs the preview and replies with the summary. It never applies.** The whole
argument of this plan is that a human looks at the diff before it lands; an AI that can apply
one removes the only defence against the shifted paste. Applying is a separate `POST
/sheets/pull/apply` from the Settings card, carrying the revision the preview saw — the same
reasoning `/sheets/push` uses for being POST-only (`server.ts:850-854`), turned up, because a
push risks disclosure and a pull risks the data.

One wiring detail that is easy to get wrong. The `/intent` door stamps `actor: 'human'`
(`server.ts:780`), and the digest deliberately passes it through
(`server.ts:786`, `sendDigest`). **The pull must not.** Its writes are attributed to
`sheet:<account>` regardless of who clicked, because the provenance being recorded is where the
values came from, not whose finger was on the button.

Unlike `sheet.push`, this verb *does* have something to say on screen, so the reply is the
summary in words and the card renders the table. It still emits no render op at a surface it
cannot see (0009's manifest-truth, restated at `app/actions/steward.ts:218-220`).

## What a pull must never do

Written as a list because it is a list of prohibitions, and each one is a thing a future version
might reasonably think it should do:

It creates nothing. It deletes nothing. It archives and restores nothing. It never touches
documents, branding, settings or the audit table. It never runs on a timer, at boot, or as a
side effect of a push — the consent argument that made the push manual (`server.ts:850-854`)
applies with more force here, because the push risks showing data to the wrong person and the
pull risks there being no data to show.

## Verify — the gate

`tsc` cannot see a spreadsheet and unit tests against a stubbed `Fetcher` cannot see a paste.
Everything below is executed against the real mirror in the operator's Drive, on a **copy** of
`data/steward.db`, and the destructive cases are performed rather than reasoned about.

**The identity test first, because it is the one nobody writes.** Push, change nothing at all,
preview. **Zero changes.** If a clean round trip proposes even one edit, every other result in
this list is noise — that is the format-coercion bug, the truncated-row bug and the derived-column
bug all announcing themselves at once.

Then, one at a time:

- Edit one ticket's `next action`. Preview shows exactly one row. Apply. The record changes, and
  the audit trail carries **one** row, actor `sheet:<address>`, diff of exactly one field.
  Preview again: zero changes.
- Type `In Progres` into a status. The **whole** pull refuses, names `Tickets!F7`, and **nothing
  is written** — confirmed by checking a different, valid edit in the same pull did not land.
  Fix the cell, pull, both apply.
- Type a date as `4/8/2026` text: rejected with the reason. As `2026-08-04`: applied. As a real
  date cell, so it arrives as a serial: applied, **and the same day** — off-by-one on the
  1899-12-30 epoch is the classic error and only a calendar catches it.
- Blank a `notes` cell: cleared. Blank a `title`: refused. Blank the last three columns of the
  **last** row: cleared, not silently ignored — this is the trailing-truncation trap and it only
  appears at the end of a tab.
- **Sort the whole Tickets tab by title.** Preview: zero changes.
- **Insert a blank row in the middle.** Zero changes, one reported row with no id.
- **Delete a row.** Zero changes, nothing deleted, the record still on `/tickets`.
- **The shifted paste.** Select a block, paste it one row down, so every id sits beside somebody
  else's values. Confirm the preview shows the mass of changes and the blast-radius refusal
  fires. Undo in Sheets, preview again, zero. This is the case the plan exists for.
- **Duplicate an id.** Refused, whole pull.
- **Point the pull at a fresh empty spreadsheet.** Every id unknown, refused outright.
- Edit a grey column — `client code` on Tickets, and the `archived` column — and confirm Sheets'
  own warning fires when typing, and that the pull proposes nothing.
- **The interlock.** Edit the sheet, push: refused, with the sentence naming the pull. Push with
  `force`: the edit is gone, deliberately, which is the proof the force works. Pull first, then
  push: clean.
- **The stale preview.** Preview, edit the sheet in another browser tab, apply: refused because
  the revision moved.
- **The STEWARD-side conflict.** Change a ticket in the app *and* in the sheet since the last
  push. The preview flags it; the sheet wins; the audit trail shows both changes in order.
- Pull with Google disconnected: a reason, not a throw.
- And afterwards, 0010's own proof still holds — push, read every tab back, cell-for-cell
  identical to what `mirrorTabs` produced.

## Still open, and deliberately not decided here

- **Creating records from the sheet.** A blank id is ignored, by decision. Creating would need
  a client/customer to attach to, a code to generate, and an answer for a half-typed row, and
  the app's own create form has all three.
- **Deleting or archiving from the sheet.** Absence means nothing, by decision, and `archived`
  is a derived column. Archiving stays a verb with an audit row (`plans/0012-archive-restore.md`).
- **The Progress tab**, and per-entry ids. Argued above; revisit only if somebody actually tries
  to edit progress in the spreadsheet and complains.
- **Per-cell authorship.** Would need the Drive Revisions API, would still not attribute a cell,
  and would be a second polling story. `sheet:<account>` is what is true.
- **Renaming a client or customer `code` from the sheet.** Not pullable here; the ticket-id
  coupling (`app/ids.ts:13-18`) would need its own plan.
- **A scheduled or automatic pull.** Never, in this plan. If it is ever wanted it needs an
  answer to "who looked at the diff", and today the answer is nobody.
- **A per-field conflict resolution UI** — "keep mine" against "keep the sheet's". The sheet
  wins, by the human's answer of 2026-08-03. If that ever needs to be per-field, it is a
  different feature with a different name.
- **`dateLastUpdated` holding two formats**, per the survey above. A real inconsistency, found
  here, belonging to a bug fix rather than to this plan.
