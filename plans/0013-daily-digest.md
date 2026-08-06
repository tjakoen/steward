---
id: 0013-daily-digest
title: STEWARD — a daily digest of pending tickets, and the branded document it carries
status: done
owner: admin
created: 2026-08-03
milestone: M3 (ship it)
tags: [email, smtp, scheduler, pdf, branding, mockup, reporting]
tasks:
  - id: mockup-ticket
    title: A mockup for the ticket document — the first one that has ever existed
    status: done
    note: APPROVED by the human 2026-08-04, unchanged; now tracked in git
  - id: mockup-report
    title: A mockup for the digest report, sharing the ticket document's furniture
    status: done
    note: APPROVED by the human 2026-08-04, unchanged; now tracked in git
  - id: client-logo
    title: Let a client actually HAVE a logo — the field is read but nothing can write it
    status: done
  - id: pdf-footer
    title: Kill the spurious page — a real print footer via displayHeaderFooter
    status: done
  - id: pdf-adopt
    title: Reshape renderTicketDocument to the mockup, branding still as data
    status: done
  - id: report-render
    title: renderDigestDocument — pending tickets per client, carrying Drive links
    status: done
  - id: smtp
    title: app/mail/smtp.ts — a minimal SMTP client, and a MIME message with an attachment
    status: done
  - id: digest-settings
    title: A Settings card that states what is true, holds the secret, and sends on a click
    status: done
  - id: scheduler
    title: A clock that survives a closed laptop — tick, due-check, same-day catch-up
    status: done
  - id: digest-send
    title: `digest.send` through the /intent door, so the AI can send one too
    status: done
  - id: verify
    title: The gate — what this Mac and a real mailbox can actually prove
    status: done
    note: a real email reached a real mailbox 2026-08-06, with the attachments intact.
      It took three fixes to get there and every one of them was invisible to tsc
---

# STEWARD — the daily digest (0013)

The human's fifth want, verbatim in substance: *automated daily emails for pending tickets, to
an address, with a PDF report in the same branding and layout as the mockup, carrying links to
the relevant generated Drive files; running while the desktop app is open, at a configurable
time of day, or manually.*

Four things do not exist today and all four are in this plan: a mockup for any document, a mail
transport, a scheduler, and a report renderer. See `plans/BACKLOG.md` for the survey that
establishes that, and for the four answers this plan is built on. It is first in the confirmed
order because it is worth the most per day and depends on nothing else.

## The mockup comes first, and it is a prerequisite, not a courtesy

The only mockup on disk is `nimbalyst-local/mockups/steward-shell.mockup.html` — the app shell.
There has never been one for a document. So "make the ticket look like the mockup" could not be
checked against anything, and the verify pass could only establish that the PDF carries *the
client's* branding, not that it carries *the right layout*.

The human answered this directly on 2026-08-03: design the mockups first. Two of them:

- **The ticket document.** What `renderTicketDocument` already emits is a reasonable
  business document — a wordmark or logo, a rule in the client's primary colour, company info
  top right, then title, meta line, and labelled sections. It is not a bad starting point and
  the mockup should be judged as a revision of it, not a blank page.
- **The digest report.** Same furniture — the same head, the same type, the same colours — with
  a different body: a table of pending work rather than one ticket's detail. Sharing the
  furniture is the point. Two documents that leave the same office should look like it.

Both are `.mockup.html` files next to the shell mockup. They are the specification the two
renderers are then written against, and they are the artefact the human approves before any
renderer changes. **Do not start `pdf-adopt` before the ticket mockup is approved** — that is
the whole reason the mockups are tasks 1 and 2.

Both were **drafted on 2026-08-03** and are awaiting that approval:
`nimbalyst-local/mockups/steward-ticket.mockup.html` and `…/steward-digest.mockup.html`.
Four changes the ticket draft proposes against what `renderTicketDocument` emits today, each of
which is a decision the human can reject:

- The meta run-on (`TXSMIT0001 · Doe, Jane · In Progress · initiated … · updated …`) becomes a
  labelled four-column grid, and the status becomes a pill.
- `Waiting on X since Y` is lifted out of the section list into a callout, because it is the one
  line a reader scans for and today it is a paragraph like any other.
- **A `Documents` section appears, and it never existed.** The ticket document has never carried
  the Drive files filed against the ticket, which is odd for the artefact that gets sent on.
- The footer moves into the page margin and gains `Page N of M` — the fix described below.

The digest draft shows the email body beside the attachment, because the two are read together
and designing either alone gets the split wrong.

## The logo is read, rendered, and impossible to set

Found on 2026-08-03 when this plan's mockups asked what the logo actually looks like. The
verify pass had already shown that `header()` (`app/view/pdf.ts:20`) renders
`branding.logoDataUrl` correctly when one is present. It is never present, and it cannot be
made present:

- `clientSchema` (`app/view/html.ts:147`) declares six fields — name, code, two colours,
  company info, PDF footer. There is no logo field, and that one schema drives create, edit
  **and** view.
- `client.create` writes `logoDataUrl: null` as a literal (`app/actions/steward.ts:196`).
- No route, no action and no seed ever writes a non-null value.

**One claim in the paragraph above was wrong, and is corrected here.** This plan and
`plans/BACKLOG.md` both said `client.update` would *erase* a logo, because it rebuilds branding
out of `clientValues` (`server.ts:299`), which omits the field. It does not: the action spreads
`...cur.branding` first (`app/actions/steward.ts:229`), so anything the form does not carry is
preserved. Checked by reading it and then proved live on 2026-08-04 — a logo uploaded, the
client edited through the `/intent` door, the logo still there afterwards. So the defect was
only ever half as bad as recorded: the field is unreachable, not fragile.

So `logoDataUrl` is a field that is typed, mirrored around (deliberately excluded from the
Sheets mirror, `app/google/mirror.ts:60`), rendered properly — and unreachable. Every client is
permanently on the wordmark fallback. The only way a logo has ever appeared in a STEWARD PDF is
the hand-written SQL the verify pass used to prove the renderer works.

It was skipped for a reason rather than forgotten: **a logo is bytes, and the JSON `/intent`
door does not take bytes.** That is the same wall 0006 hit, which is why uploads have their own
multipart route and `steward-live.js` skips forms carrying a real `action`.

**Follow 0006's precedent: a multipart route, `POST /clients/:id/logo`,** which reads the file,
validates it, converts to a `data:` URL server-side and writes it through `updateClient` so the
change is audited like any other. The alternative — `FileReader` in the browser, data URL
through the JSON door — needs no new route but pushes an unbounded base64 string through the
intent door and puts the validation on the client. Not worth it.

Three constraints the route has to enforce, because this value is inlined into **every**
document the client ever generates and into their row in SQLite:

- **PNG and JPEG only.** SVG in an `<img>` is a script-bearing format; a print pipeline is a
  poor place to relax about that, and no operator needs it.
- **A hard size cap** — 512 KB of source, which is already generous. Base64 inflates by a third,
  and a 2 MB logo would put ~2.7 MB into every ticket PDF and every digest attachment.
- The document caps display at 220×56 CSS px (`.logo` in `app/view/pdf.ts:89`), so anything
  larger is bytes nobody sees. Say so in the field's help text rather than silently downscaling;
  a resize step can come later if real logos turn out to be huge.

Removing a logo has to be possible too — a checkbox or a clear button, not "upload a white
square".

One thing the plan did not anticipate: `services.updateClient` audits the patch verbatim, so
writing the logo through it would put half a megabyte of base64 into the `audit` table on every
change — an **append-only** table, so every copy is permanent. `updateClient` therefore takes an
optional `diff` that overrides what the row records, and the route passes
`{ logo: 'image/png', bytes: 1805 }`. The row says a logo was set; the record holds the bytes.

## The footer is broken today, and it is this plan's problem

The verify pass on 2026-08-03 found it. `.doc-foot { position: fixed; bottom: -14mm }`
(`app/view/pdf.ts:105`) places the footer below the page content box, and Chrome's
`Page.printToPDF` treats that as overflow:

| Document | Today (`-14mm`) | With `bottom: 0` |
|---|---|---|
| Short ticket — the normal case | **2 pages**, page 2 blank but for the footer | 1 page |
| Short ticket, footer blanked | 1 page | — |
| 90-entry ticket | 3 pages | 3 pages |

So every short ticket PDF ships a junk second page, including the one already sitting in the
operator's Drive. And on a document that genuinely runs long, the footer is worse than
misplaced: it is a single fixed element painted at a viewport-derived offset, so on page 2 it
lands *on top of* the progress log — near the top with `-14mm`, near the bottom with
`bottom: 0`. Both confirmed visually.

`bottom: 0` therefore fixes the common case and not the real one, which is why the verify pass
deliberately left it alone rather than banking a one-line half-fix.

**The fix is Chrome's own mechanism.** `Page.printToPDF` takes `displayHeaderFooter: true` with
a `footerTemplate` (and `headerTemplate`), renders them into the page margins on *every* page,
and supports `pageNumber`/`totalPages` classes — which is how "Page 2 of 3" becomes possible at
all. It requires the margins to move out of `@page` and into the `printToPDF` call, because
`preferCSSPageSize` and the header/footer templates do not co-operate: the templates are laid
out in the margin box that the CDP call defines.

That makes `printToPdf(html)` into `printToPdf(html, opts)` — a signature change to
`app/pdf/print.ts:164`, shared with `screenshotPng`'s browser singleton and with
`scripts/make-icon.ts`. Keep the default behaviour of the no-options call identical so the icon
script is untouched.

Two traps worth writing down before someone rediscovers them:

- Header and footer templates are rendered in a **separate document** with no access to the
  page's CSS. Styles must be inline, and the default font size is tiny — set it explicitly.
- The templates are clipped to the margin. A footer needs a bottom margin large enough to hold
  it or it simply does not appear, which reads exactly like the feature not working.

## What "pending" means

`TICKET_STATUSES` is `Not Commenced | In Progress | Waiting | Completed`
(`app/domain/types.ts:46`). **Pending = anything that is not `Completed`.** Three of the four,
and the digest groups them under those three headings.

The groups run **`Waiting` → `In Progress` → `Not Commenced`**, which is not the enum's order
and is not an accident. What is stuck on somebody else leads, because that is the list the
reader can act on this morning. `Waiting` also earns extra furniture — it is the status that
answers "waiting on what, and since when", and `waitingOn`/`waitingSince` are already on the
ticket, so it is the closest thing STEWARD has to an ageing report. Sort that group oldest
first and print the age in days.

**An empty digest still sends.** If nothing is pending anywhere, the email goes out saying so,
because a silent morning is indistinguishable from a scheduler that died in the night. A client
with nothing pending contributes no attachment; a workspace with nothing pending sends one
sentence and no attachments at all.

## One email, one attachment per client

The digest spans every client, but branding belongs to a client — `Client.branding` is what
makes a document theirs. A single combined PDF would have to pick somebody's colours, and the
answer to "whose?" is nobody's.

So: **one email, carrying one PDF per client that has pending work.** A client with nothing
pending contributes no attachment and no section. The email body is a short plain summary — the
counts and the client names — so it is readable on a phone without opening anything, and the
detail lives in the attachments.

The report also carries **links to the relevant Drive files**, which is the part that makes it
useful rather than decorative: for each pending ticket, the `webViewLink` of every document
filed against it. That needs a bulk read the repository does not have yet — today documents are
fetched one entity at a time (`idx_documents_entity` covers `(entity, entityId)`). Add a
`forEntities` read rather than issuing one query per ticket.

A pending ticket with no documents renders no link list. That absence is information too.

## SMTP, and why not Gmail

Answered 2026-08-03: **SMTP, with an app password held in the `settings` table.** The Gmail API
would reuse the existing Google connection, but it needs the `gmail.send` scope, and unlike
`drive.file` that scope is sensitive — it drags the OAuth app into a Google verification review,
which is precisely what 0006 chose `drive.file` to avoid. SMTP costs one secret and no review,
and works against any host rather than only Google.

The secret follows the doctrine the Google tokens already established (0006): it lives in the
`settings` k/v table, is **never audited, never rendered back to the page, and never in a URL**.
The Settings card shows whether a password is set, not what it is.

**No mail library.** This is the same call 0004 made when it drove Chrome over a raw WebSocket
rather than taking puppeteer, and 0009's `bun build --compile` gives it a second justification:
every dependency is bundled into the binary. What is actually needed is small — connect with
implicit TLS on 465 via `Bun.connect({ tls: true })`, read the greeting, `EHLO`, `AUTH PLAIN`
with the base64 of `\0user\0password`, `MAIL FROM`, `RCPT TO`, `DATA`, the message, `.`, `QUIT`
— plus a MIME `multipart/mixed` body with base64 attachments wrapped at 76 columns.

Three details that turn a working client into a broken one:

- **Dot-stuffing.** A line in the message body that begins with `.` must be sent as `..`, or it
  terminates the DATA phase early and truncates the mail.
- **CRLF, everywhere.** SMTP line endings are `\r\n`, including inside the MIME structure.
- **Every reply is multi-line until it is not.** A response line with `-` after the code
  (`250-STARTTLS`) means more lines follow; only `250 ` with a space ends it. Reading one line
  and moving on works against one server and hangs against the next.

Port 465 implicit TLS is the target. If a host needs 587 with `STARTTLS`, that is an upgrade
mid-conversation and a second socket state — out of scope here, and the Settings card should say
465 rather than pretend the port is free. Should a real mailbox force it, take `nodemailer`
rather than growing this file; the seam is `sendMail(config, message)` and nothing above it
cares.

## The scheduler, and the laptop that was shut

The ask is explicit that this runs **while the desktop app is open**. That is a real constraint,
not a limitation to design around: STEWARD is a desktop binary, there is no server to host a
cron, and pretending otherwise would mean a service the human has not asked for and cannot see.

So: a `setInterval` tick — one a minute, cheap — that asks whether today's digest is due and
unsent. Due means the configured `HH:MM` has passed. Unsent means `digest.last_sent_on` in
`settings` is not today's date. Two consequences fall straight out of that shape and both are
wanted:

- **The app cannot double-send.** The date stamp is written before the send is attempted and is
  the idempotency key; a tick that finds today's date already there does nothing.
- **A laptop that was shut at 08:00 and opened at 11:00 still sends** — the check is "has the
  time passed and is it unsent", not "is it exactly now". A missed day stays missed, though:
  there is no backfill of yesterday, and the digest is about what is pending *now*, so
  yesterday's would be a worse copy of today's anyway.

Store the time as `HH:MM` local. The tick reads the wall clock; no timezone handling, because
both the schedule and the operator are on the same machine.

Failure has to be visible or the feature is a rumour. A failed send writes the failure into
`app/log.ts` (0010's boot log, already mirrored to `steward.log` when packaged) and leaves
`last_sent_on` **unset**, so the next tick retries — but it does not retry every minute
forever; a per-day attempt counter caps it, and the Settings card shows the last result.

## `digest.send`, and the door it goes through

Manual send is a verb: `digest.send`, added to `STEWARD_ACTIONS` and dispatched in
`app/actions/steward.ts` exactly as `sheet.push` is (`app/actions/steward.ts:17`). Same reason as
0010's — the AI can then refresh or send on request without a second mechanism, and the Settings
button is just an intent like every other control.

Like `sheet.push`, it is one of the few verbs that talks to the outside world, so it is audited
as an action with the recipient recorded and the message body not.

## Verify — the gate

`tsc` cannot see markup and it cannot see a mailbox. What this Mac can actually prove:

- Both mockups render, and the human has approved them. Nothing downstream starts first.
- A short ticket PDF is **one page**, with the footer in the margin and a page number on it;
  the 90-entry ticket is still 3 pages with the footer on every one and nothing overlapping.
  Both by rendering to PNG and looking, not by trusting the page count alone.
- A digest report renders for a client with pending tickets, groups them by the three statuses,
  ages the `Waiting` group, and carries working `webViewLink`s for tickets that have documents.
- A real email arrives at a real address with the attachments intact and the PDFs openable.
  This needs an SMTP host and an app password the human supplies — **it is the one step that
  cannot be faked**, and it is the gate on the plan being called done.
- The scheduler fires: set the time to a minute ahead, watch it send once, watch the next tick
  do nothing, clear `last_sent_on` and watch it send again.
- A wrong password produces a legible failure in Settings and in `steward.log`, not a silent
  nothing.

## Built 2026-08-04 — and what the browser pass caught

Both mockups were approved unchanged by the human on 2026-08-04, and are now tracked in git
(`.gitignore` ignores `nimbalyst-local/*` with `!nimbalyst-local/mockups/` negated back in —
the same trap the `build/` entry documents, since an ignored *directory* is never descended
into and a negation under it would do nothing).

Ten of the eleven tasks are done. What the pass proved, by executing it:

- **The spurious page is gone.** Short ticket: 1 page, was 2. A 90-entry ticket: 5 pages
  (not the 3 the old layout made — the log is a table now, and rows are taller), footer in the
  margin of every page, `Page 2 of 5` correct, nothing painted on top of the log.
- **The logo is settable.** A real PNG through `POST /clients/:id/logo` lands in the head of
  both documents. An SVG is refused by its *bytes*, not its declared type; 600 KB is refused
  with a sentence saying why the cap exists. The audit row reads `logo set`, and holds 40 bytes.
- **The report renders** with the three groups in the intended order, the Waiting group aged
  and sorted oldest first, and real `webViewLink`s from Drive.
- **The Settings card** states what is missing by name, keeps the password when the box is
  submitted empty, and never renders it back.

**The one defect this pass found, and it is worth writing down.** The footer template is a
`style="…"` ATTRIBUTE, not a stylesheet — and the shared font stack contains `"Segoe UI"`.
Those double quotes closed the attribute, discarding every declaration after it. The result was
not a missing footer, which anyone would notice, but a nearly invisible one crushed into the
bottom-left corner in a serif face. `footerTemplate` now uses a quote-free stack
(`Helvetica, Arial, sans-serif`), and `doc.test.ts` asserts that no `style="…"` in the template
contains a quote. `tsc` cannot see this and neither can a page-count check; only looking found it.

**Not proven, and cannot be here:** a real email arriving at a real mailbox. The transport is
written and tested against a scripted server — the multi-line reply reader, dot-stuffing, CRLF,
`AUTH PLAIN`, the encoded-word subject and the RFC 2231 filename all have tests — but no socket
has been opened to a real host. That is the gate, and it waits on an SMTP host and app password
from the human. Until then the Settings card's **Send now** is disabled and the scheduler's
due-check returns `unconfigured`.

## Still open, and deliberately not decided here

- **Which address.** One recipient in `settings`, because that is what was asked for. Several
  recipients, or a different address per client, is a bigger idea and belongs to whoever asks
  for it.
- **The email body's own branding.** Plain text, deliberately: an HTML mail that has to survive
  a dozen clients is its own project, and the branded artefact is the attachment.
- STARTTLS on 587, per the transport section above.
- ~~**`dateLastUpdated` is no longer printed on the ticket document.**~~ **ANSWERED
  2026-08-04: put it back.** The approved mockup's grid had four cells (Ticket, Customer,
  Status, Initiated) and dropped it; the human asked for the fifth. Done — one `cell('Updated', …)`
  in `meta()` and `repeat(5, 1fr)` in `TICKET_CSS` (`app/view/pdf.ts`), with a test that asserts
  both. Rendered and looked at, because a fifth column in a grid sized for four is exactly the
  kind of thing `tsc` cannot see: five cells fit at A4, the Waiting callout is unmoved, a
  two-line customer name wraps inside its own cell without pushing the row, and a short ticket
  is still one page with `Page 1 of 1` in the margin.

## The 535 that was our fault (2026-08-06)

The first real send failed:

```
535 5.7.8 Username and Password not accepted
```

That reads as a wrong password and sends people back to Google to mint another one, which
fails identically. It was not a wrong password. **Google displays an app password as four
groups of four — `abcd efgh ijkl mnop` — and everybody pastes it that way.** The spaces are
presentation; Gmail's SMTP wants the sixteen characters. STEWARD stored what was pasted,
`.trim()` removed the outer whitespace and left the three in the middle, and `AUTH PLAIN`
carried them to Google.

`normalisePassword` (`app/mail/digest.ts`) strips whitespace — but only when what is left is
the app-password shape, sixteen letters. Any other secret is stored exactly as typed, because
a real SMTP password may legitimately contain a space and silently eating it would be the
worse bug: a login that fails for a reason nothing on screen explains.

The Settings card also had no way to say anything useful about a stored secret. It now reports
the **shape, never the value** — the length, and whether it looks like an app password — and
when the host is Gmail and it does not, it says so and links to where to make one. A `535`
against Gmail is almost always an account password, and that is worth naming rather than
leaving the operator to guess between four possibilities.

## The gate is passed — a real email, 2026-08-06

**A real message reached a real mailbox with its attachments intact.** That was the one step
this Mac could never fake, and it is now done, which closes the plan.

It took three fixes, and the interesting thing is that **the transport's unit tests passed
throughout**. Every one of these needed a real socket, a real account and a real payload:

1. **The password carried its display spaces.** Google shows an app password as four groups of
   four and it gets pasted that way; `.trim()` took the outer whitespace and left the three in
   the middle. Fixed by `normalisePassword`, which strips whitespace only when what remains is
   the app-password shape.
2. **The username had a comma where a dot belongs** — `tjakoen,s@gmail.com`. Google has no such
   account, and **the only word SMTP has for that is "password"**, so it answered `535` and the
   operator went back twice to mint app passwords that could never have worked. The address
   check was `something@something.something`, which a comma passes. It is now the character set
   addresses actually contain, and the Username is checked whenever it holds an `@`.
3. **The message was truncated on the wire.** `socket.write` returns how many bytes it
   *accepted*, and the transport discarded that. SMTP commands are a few dozen bytes and never
   hit the limit — a digest carries a PDF per client, and a 55 KB attachment is ~74 KB of base64,
   well past the TLS buffer. Gmail got a body with no terminating `\r\n.\r\n`, waited for the
   rest, and twenty seconds later our own timeout blamed the host: *"smtp.gmail.com stopped
   responding"*. It was still listening. We had stopped talking.

The queue behind the socket is now `makeByteQueue`, exported and tested on its own with a sink
that accepts as little as one byte at a time — including a UTF-8 case, because it counts BYTES
and slicing a string by a byte count cuts a character in half. And a stalled reply now names the
step it was waiting for: *"while waiting for the message"* and *"while waiting for EHLO"* are
different bugs, and nothing in the old message told them apart.

**One more thing the working feature exposed.** Only the scheduler wrote
`digest.last_result`, so the Settings card went on displaying a two-day-old `535` underneath a
**Send now** that had just succeeded. A card whose whole job is to state what is true cannot
report the last *scheduled* result as the last result. Manual sends record their outcome now —
but deliberately do **not** touch `digest.last_sent_on`, which is the scheduler's idempotency
key: a manual send claiming the day would silently cancel that morning's digest.

**Lesson worth keeping.** 0013's own verify section said the live send "cannot be faked" and was
"the gate on the plan being called done". That was correct, and it was correct for a reason
larger than email: three real defects sat behind a fully green test suite, and the only thing
that could find them was one real message to one real mailbox.
