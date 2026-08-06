---
id: 0015-bug-reporting
title: STEWARD — reporting a bug, and the diagnostics that make a report worth reading
status: done
owner: admin
created: 2026-08-04
milestone: M3 (ship it)
tags: [github, diagnostics, logging, privacy, redaction, support]
tasks:
  - id: diagnostics
    title: app/report/facts.ts — the facts a report carries, and the ones it must never
    status: done
  - id: redact
    title: A redactor with a rule, not a list — plus SettingsRepository.keys()
    status: done
  - id: log-tail
    title: The tail of steward.log, read by byte offset, and what a checkout has instead
    status: done
  - id: body
    title: The markdown body, the 8 KB URL budget, and what falls off the end
    status: done
  - id: report-page
    title: GET /report — the textarea nobody gets to skip, plus copy and save
    status: done
  - id: entry-points
    title: A Settings card, a nav link, and how the report learns which screen broke
    status: done
  - id: verify
    title: The gate — a redaction test, a budget test, and one real issue actually filed
    status: done
---

# STEWARD — reporting a bug (0015)

The human asked, on 2026-08-04, for a way to report a bug from inside the app. The transport
was decided in the same exchange and is recorded in `plans/BACKLOG.md`: **a prefilled GitHub
issue URL**, `https://github.com/tjakoen/steward/issues/new?title=…&body=…`, opened in the
browser the operator is already looking at. No credential, no new OAuth scope, no server.

That decision is the easy half and it is already made. **This plan is about the body.** A bug
report that says "it didn't work" costs more than it returns; one that carries the version, the
platform, what was connected, and the last few kilobytes of `steward.log` can often be answered
without a second exchange. 0010 already writes that log. Nothing has ever read it back.

## Why not a token, and why this is written down

Two alternatives were rejected on 2026-08-04, and they are recorded here so that the next person
who thinks "we could just post to the API" finds the answer before they think it twice.

**A token baked into the binary is a write credential in a 61 MB file that anyone can `strings`.**
`scripts/build.ts` already bakes the Google client id and secret in, and that is defensible for
exactly one reason: Google says desktop client secrets are not secret, and PKCE is what actually
protects the exchange (`config.ts:73-80`). A GitHub token has no PKCE behind it. It is a bearer
credential, it grants writes to a real repository, and once it has shipped inside a downloaded
executable it cannot be recalled — every install would have to be updated to rotate it, and the
old binaries would keep working until the token was revoked and every one of them broke.

**A token in the `settings` table moves the problem onto the operator.** It would make holding a
GitHub account and generating a fine-grained PAT a prerequisite for saying "this crashed", which
is asking the least technical person in the loop to do the most technical thing in the app. The
`settings` table is already the right home for the Google refresh token and the SMTP app password
(0006's doctrine, restated at `app/mail/digest.ts:20-21`), and both of those are secrets the
operator *needs* for a feature they asked for. A support form is not that.

**A proxy service needs a server, and STEWARD does not have one.** The whole shape of this
product — a compiled binary, a SQLite file, a scheduler that only runs while the app is open
(`server.ts:1645`) — exists because there is no host to pay for and no service to operate.
Inventing one for a bug button would be the single largest architectural change in the project,
made for its smallest feature.

The URL costs nothing, ships nothing, and fails safely: the worst case is a browser that does not
open, and the page has a Copy button for that.

One fact that was not true a week ago and is load-bearing: **the repo is public.** `tjakoen/steward`
was flipped to public on 2026-08-04 after a second history audit came back clean, and issues are
enabled. A private repo accepts issues only from collaborators, which would have meant inviting
every operator by hand. That constraint is gone; anyone with a GitHub account can file one, and
the friend on Windows needs no invitation.

It cuts the other way too, and this is the constraint the rest of the plan bends around: **a
public repo means every byte of the body is published to the internet, permanently, under the
operator's own GitHub identity.**

## What goes in the body

The list below is the deliverable. Everything is cheap to compute and every line has a reader in
mind — the question it answers is written beside it.

| Fact | Where it comes from | What it answers |
|---|---|---|
| Version, and packaged or not | `config.version`, `config.packaged` (`config.ts:33-36`) | Is this a release or a checkout? Which release? |
| Platform, arch, OS release | `process.platform`, `process.arch`, `os.release()` | Is this the Windows-only one? |
| Bun version | `Bun.version` | Runtime skew on a rebuilt binary |
| Uptime | `process.uptime()` | Three seconds after launch, or six hours in? |
| Google | `googleAuth.status()` (`app/google/oauth.ts:128`) | `not configured` / `configured, not connected` / `connected` |
| Sheets mirror | `sheetsMirror.state()` (used at `server.ts:1387`) | Whether a mirror exists at all |
| Digest | `readSettings` (`app/mail/digest.ts`) | Scheduled or not; whether a password is stored |
| A PDF engine | `resolveChrome()` (`app/pdf/print.ts:41`) | Half the reported bugs will be "the PDF button does nothing" |
| Record counts | `repos.*.list().length`, as the nav already does (`server.ts:204-209`) | Empty database, or forty thousand rows? |
| The screen | the referring path, normalised | Which surface broke |
| The tail of `steward.log` | `app/log.ts` | Everything else |

`VERSION` is `dev` from a checkout and the tag from a release (`app/paths.ts:28`), so the report
distinguishes the two without being told. The version string is the one field that makes an issue
triageable at a glance, and it is free.

Above all of that sit three empty prompts — *what happened*, *what I expected*, *how to reproduce
it* — and they go **first**, at the top of the body, with the diagnostics in a fenced block
underneath. The operator's sentence is the part a human reads; the machine's paragraph is the part
they scroll to afterwards.

### And what does not

**Never the connected account's email address.** `googleAuth.status()` returns
`{ configured, connected, account }` and `account` is the signed-in Gmail address
(`app/google/oauth.ts:29,131`). Settings renders it, correctly — that page is for the one person
sitting in front of it. A public issue is the opposite audience. The report carries the two
booleans and drops the third, and there is a test for it.

**Never the Sheets mirror URL.** `sheets.spreadsheet_url` points at a live spreadsheet of every
client, customer and ticket in the business (`app/google/sheets.ts:25`). Even behind Drive
permissions, publishing the link tells the world both that the document exists and where to ask
for access. The report says whether a mirror exists. That is the whole diagnostic value of it.

**Never the SMTP host, username, recipient or password.** The password is obvious. The other
three are addresses that identify a business and a person, and a mail bug is diagnosable from
"host set, user set, password stored, port 465" without any of their values.

**Never the absolute data directory.** This is the subtle one. `dataDir()` resolves to
`~/Library/Application Support/STEWARD`, `%LOCALAPPDATA%\STEWARD` or `~/.local/share/steward`
(`app/paths.ts:41-57`) — and expanded, every one of those contains the operator's account name.
The path also tells the reader nothing an issue can act on, because it is entirely determined by
the platform. So the report prints the *shape*: `%LOCALAPPDATA%\STEWARD`, unexpanded. When
`STEWARD_DATA` is set it prints `STEWARD_DATA is set` and not its value, because an override is a
diagnostic and the path is somebody's directory layout.

**Never a Chrome path.** `resolveChrome()` searches `LOCALAPPDATA` and `PROGRAMFILES`
(`app/pdf/print.ts:22-26`), so the Windows answer is routinely `C:\Users\<name>\AppData\Local\…`.
Report the basename — `chrome.exe`, `msedge.exe`, `Google Chrome` — or `none found`.

**Never a record id, and never a name.** The referring path is normalised before it is printed:
opaque ids are `prefix_` plus sixteen hex characters (`app/ids.ts:22`), so `/tickets/tkt_def42d05e31c45f7`
becomes `/tickets/:id`. Which ticket it was is the operator's business and no reader of the issue
can look it up anyway.

## Redaction is a rule, not a list

Everything above is about what the report *builds*. The log tail is different: it is arbitrary
text produced by code nobody is reviewing at report time, and it will grow new lines in every
plan after this one. An allowlist of things to scrub is out of date the day it is written.

So the redactor gets a rule with teeth, applied to the whole body — diagnostics and log alike —
as the last step before anything is shown:

1. **The home directory becomes `~`.** `os.homedir()`, replaced literally, on both slash
   conventions. This is first because it is the highest-yield single substitution in the file: it
   catches the data directory, the documents directory, the Chrome path, every `[fatal]` stack
   frame from a checkout, and the operator's account name in all of them.
2. **Email addresses become `<email>`.** One regex. This catches the digest recipient, an SMTP
   username that happens to be an address, and the Google account name if it ever reaches a log
   line by a route nobody predicted.
3. **Every value currently in the `settings` table becomes `<redacted>`.** Not a list of keys — a
   sweep of the table. If a value of eight characters or more appears anywhere in the text, it is
   replaced. The eight-character floor exists because `settings` also holds `1`, `0`, `465` and
   `08:00`, and scrubbing those would turn the log into `<redacted>` soup and the timestamps into
   nonsense.
4. **Token-shaped strings become `<redacted>`** even when they are not in `settings`: `ya29.…`,
   `1//…`, anything after `Bearer `, and `[?&](code|state|access_token|refresh_token|client_secret)=…`
   in a URL. This is the belt to rule 3's braces — it catches a credential that was in flight and
   never stored, which is exactly the case an error message is most likely to contain.

Rule 3 is the one that keeps holding. A list of secret keys would have to be edited by whoever
adds the next secret, and they will not, because their plan is about something else. "Nothing in
`settings` leaves this machine" is a sentence that stays true without maintenance.

**It needs a repository change, and that is the one obstacle in this plan.** `SettingsRepository`
is `get`/`set`/`remove` and nothing else (`app/repo/sqlite.ts:299-316`), so there is today no way
to enumerate the table. Add `keys(): string[]`, or a `values()` that returns them — a five-line
`SELECT key FROM settings`. The alternative is exporting the private `KEY` maps from
`app/google/oauth.ts:25` and `app/google/sheets.ts:25` and hand-assembling a list, which is
precisely the maintenance burden rule 3 exists to avoid.

Two things the redactor deliberately does **not** do. It does not touch client or customer names,
because it cannot: a client called "Northern" would turn every occurrence of that word into
`<redacted>`, including in an error message where it is the actual clue. `app/mail/digest.ts:190`
logs `could not render <client name>` and that line is genuinely useful. The answer is the
textarea, not a regex — the operator reads the name and decides. And it does not attempt to be
clever about free text the operator typed themselves; they typed it, they can see it, it is theirs.

## The log tail, and how much of it

`steward.log` is capped at 1,000,000 bytes with one `.old` generation kept (`app/log.ts:16,37`),
and it is written **synchronously** so ordering survives a crash. Reading it is therefore just a
question of taking the end.

Take it by byte offset, not by reading the file: `Bun.file(logFile()).slice(size - TAIL_BYTES)`.
`TAIL_BYTES = 16_384` — comfortably more than can ever survive the URL budget below, and the
excess costs one cheap read from a local file.

**Slicing at a byte offset can cut a UTF-8 character in half**, which yields a replacement
character at the front of the text. The fix is the thing we want anyway: discard everything up to
and including the first `\n` after the cut, because a half-line is noise regardless of its
encoding. One rule, two problems.

If `steward.log.old` exists, say so in one line. The reader then knows there is more, and where.

**From a checkout there is no log file at all**, and that is correct. `installFileLog` returns
`null` unless `PACKAGED` (`app/log.ts:31-32`) because a terminal is right there and a second copy
of it is one more thing to go stale. So the report says, in a sentence, that this build logs to
the console and the tail is not available — which is true, and which the developer reading their
own terminal does not need. Do not turn the log on in dev to make this feature tidier; that
inverts 0010's reasoning to serve a form.

## The 8 KB budget, and what falls off the end

A URL has a practical ceiling around **8 KB** — not in the browser's address bar, which is far
more generous, but at the other end, where GitHub's front end caps the request line and answers
`414` past it. Design to 8 KB and the feature works everywhere; design to a browser's limit and it
works until it silently does not.

So: **`URL_BUDGET = 8_000` bytes for the entire URL**, measured after encoding, not estimated
before it. The fixed part —
`https://github.com/tjakoen/steward/issues/new?title=&body=&labels=bug` — is 69 bytes. The title
is capped at 120 characters. Everything remaining belongs to the encoded body, so roughly 7.6 KB
of `encodeURIComponent` output, which for ordinary log text lands somewhere between 4 and 5 KB of
actual characters. **Do not guess that ratio.** Build the body, encode it, measure the string, and
if it is over budget drop the **oldest** log line and measure again. The newest lines are the ones
next to the crash.

When lines are dropped the block is headed `… earlier lines dropped to fit the URL; the full log
is at <path>` — with the path shown on the page, not in the body. Truncation the reader cannot
see is worse than truncation, because it makes a partial log look like a complete one. If even
the diagnostics alone exceed the budget, which they cannot in practice, the log block is omitted
entirely with one sentence saying so, and there is a test that this degrades rather than produces
a URL GitHub refuses.

`encodeURIComponent`, and nothing hand-rolled. Four characters break a naive build and all four
occur in real log lines: a newline is not legal in a URL at all; `#` truncates the body at the
fragment, silently, so a log line mentioning `#3` would eat everything after it; `&` starts a new
query parameter, so `a&b=c` in a stack trace injects a parameter into GitHub's own form; and `+`
is decoded as a space by most query parsers, which quietly corrupts any diff in the log.
`encodeURI` escapes none of `#&+` — it is for whole URLs, not for components — so it is the wrong
function and would look right in testing.

Build the title with the same function and the same care. `labels=bug` is safe because `bug` is
one of the labels GitHub creates in every new repository; **passing a label that does not exist
makes GitHub reject the whole prefilled form**, so do not invent taxonomy here.

**One trap that is not obvious and would only appear in production.** If the repo ever grows
`.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: false`, `/issues/new` redirects to
the template chooser and **the entire prefilled body is discarded**. Nothing errors; the operator
just gets an empty form and files a useless issue. So: either the repo keeps blank issues enabled,
or this plan's URL gains a `template=` parameter and the body is split into the template's fields.
The decision here is the first one — keep blank issues enabled — and `0016` must not add a
template without coming back to this paragraph.

## The operator reads it first, and the thing they read is the thing that is sent

This is the constraint the whole page is arranged around. **The body is going to a public
repository under the operator's own name.** An app that assembles a description of its internal
state and publishes it on a click, without showing the text, is publishing on someone else's
behalf without asking — and would be, whatever we redacted, because the point is not that we got
the redaction right, it is that it was never our call to make.

So `GET /report` renders the fully-built body into a **textarea**, editable, with the empty
prompts at the top and the cursor in the first one. The operator writes their sentence, reads
what is underneath it, deletes anything they do not want published, and only then opens GitHub.

Two consequences follow, and both matter:

- **What is reviewed is exactly what is sent.** The URL is rebuilt from the textarea's current
  value at the moment of the click — never from the server's original. A design where the box
  shows a full log and the URL carries a trimmed one is a design where the operator reviewed a
  document that was not published.
- **The budget is a live number on the page.** "6.1 KB of 8 KB" under the box, recomputed on every
  keystroke, so someone pasting a long stack trace finds out immediately rather than at a `414`.
  Over budget, the button refuses with a sentence naming the overage and pointing at Copy.

**Open it with an anchor, not a spawn.** The browser is already the thing looking at this page; a
new tab is its job. So the control is `<a target="_blank" rel="noopener">` whose `href` is
recomputed on every `input` event, which also means a plain click is never caught by a popup
blocker — `window.open` after an `await` is, routinely.

That is not only simpler than `openBrowser` (`app/launch.ts:40`), it dodges a live bug.
`browserCommand` shells out through `cmd /c start "" <url>` on Windows (`app/launch.ts:34`), and
**`&` is a command separator to `cmd`**. A URL with `?title=…&body=…` handed to that function
would run `body=…` as a second command and open GitHub's new-issue form with no body at all. No
query string has ever been through that path — the only caller passes `http://localhost:<port>`
(`server.ts:1632`), and the OAuth flow is an `<a href>` the browser follows itself — so the bug
has never fired. It is written down here so that nobody "simplifies" this feature into it later.

## A route, not a verb — and this one is worth arguing

`sheet.push` and `digest.send` are in `STEWARD_ACTIONS` (`app/actions/steward.ts:17`), dispatched
through the same `/intent` door as everything else, and the stated reason in both cases was that
the AI should be able to do on request what a button does on a click. Both are async, both talk to
the outside world, both are audited, and both fit.

**Bug reporting is not a third one of those, and adding it would break the only property that
makes it safe.** A verb in `STEWARD_ACTIONS` is, by construction, a thing the reasoner can invoke
because a sentence in a chat box asked for it. This feature's entire design rests on a human
reading the exact published text first. A door the AI can push is a mechanism for filing an issue
that no human read — and to a public tracker, under the operator's account. The value of a verb
here is "the AI could report a bug for you", which is the one outcome to prevent.

There is a second, duller reason, and it is the one that settles it: **there is nothing to
dispatch.** Sending happens in the browser, by navigation. The server's only job is to answer
`GET /report` with a page. No POST, no async, no result to return. A verb would be a door onto an
empty room.

So: one route, `GET /report`, sitting beside `/settings` in the same `Bun.serve` routes table
(`server.ts:1340`), rendered through `layout()` like every other page. Copy uses the clipboard API
and Save is a client-side `Blob` download of the textarea's current value — both operate on the
edited text, both need no route, and neither has a size limit, which is precisely what makes them
the answer to the offline case.

No audit row. `audit` is keyed by `(entity, entityId)` and a bug report is about no record; the
row would say nothing, and the durable record of the act is the issue itself, on GitHub, with a
number.

## Getting there from where the bug was

The Settings page is where this lives — it is where Google, Sheets, the digest, the version and
the log file path are already stated (`server.ts:1340-1595`), and a support card belongs in that
company. It carries the explanation: what is collected, that it is published publicly, that no
account or password is included, and where `steward.log` is on this machine so it can be attached
by hand if asked for.

But **the surface the reporter was on is a diagnostic, and a card reachable only from Settings
always answers `/settings`** — which is worthless. So there is a second entry point: a
`Report a bug` item in `NAV_FOOT` beside Help and Settings (`server.ts:212-215`), present on every
page. `/report` reads the `Referer` header to learn which screen the operator left, honours an
explicit `?from=` when one is passed, normalises the ids out of it, and prints `unknown` when
neither is available. `Referer` is sent by default on a same-origin link click; it is not
guaranteed, which is why `?from=` exists as the deterministic path for the links we control.

`NAV_FOOT` items need an `IconName` from GRAIN's sprite and a name that is not in the list renders
nothing at all (`app/view/html.ts:21-24`) — the available glyphs are fixed, so pick from them
rather than inventing one.

## Verify — the gate

`tsc` cannot see a redaction failure and it cannot see a `414`. What has to be executed:

- **The redaction test.** A fixture log containing the operator's real home directory, an email
  address, a stored refresh token read back out of a temporary `settings` table, an
  `Authorization: Bearer ya29.…` line, and an OAuth callback URL with `?code=`. Assert that not
  one of those five survives, and — equally important — that the ordinary lines around them do,
  including a timestamp and a client name. A redactor that passes by deleting everything is not a
  redactor.
- **The budget test.** Feed it a 1 MB log of pathological content — `#`, `&`, `+`, newlines,
  non-ASCII — and assert the final URL is under 8,000 bytes, that the newest line is still in it,
  that the dropped-lines marker is present, and that a body which cannot fit at all degrades to
  "log omitted" rather than to an oversized URL.
- **The omission test.** Build a report on a machine with Google connected and a digest password
  stored, and assert the body contains neither the account address nor the password nor the
  mirror URL nor an expanded home path — by asserting the absence of the actual values, not by
  asserting the presence of the word `<redacted>`.
- **The round trip, by hand.** Open `/report` from a ticket page, confirm the referring surface
  reads `/tickets/:id` and not the real id, edit the body, watch the byte counter move, and click
  through to GitHub. **The issue must actually be filed against `tjakoen/steward`** — the title,
  the body and the `bug` label all arriving intact is the only proof that the encoding, the label
  and the blank-issue path all work together. Leave it open long enough to read it, then close it
  as the verification it was. Do not delete it; the evidence is the point.
- **The offline case.** With no network, Copy and Save both still produce the full text, and the
  page says what to do with it.
- **The checkout case.** From `bun server.ts`, the report builds, says plainly that there is no
  log file and why, and is otherwise complete.

Windows cannot be part of this gate — there is still no Windows machine, which is the standing
blocker recorded in `plans/BACKLOG.md`. That is survivable here precisely because the design has
no platform-specific path in it: an anchor is an anchor. It would not have been survivable through
`openBrowser`, which is the strongest argument for the anchor there is.

## Still open, and deliberately not decided here

- **A "Report this" link on the 500 page.** `error()` returns plain text — the stack in dev, one
  sentence in production (`server.ts:1617-1620`) — and it is the single highest-value moment to
  offer a report, because the operator is looking at the failure right now. It is not in this plan
  because that response is not a shell page and turning it into one is a change to the error path,
  which is the last place to be clever. Worth doing next; worth doing on its own.
- **Feature requests.** The same URL takes `labels=enhancement` and a different set of prompts.
  Nobody asked for it, and a form with a radio button at the top is a worse bug-reporting form.
- **Attaching the whole log.** GitHub takes file attachments only through a real upload, which
  needs the credential this plan spent its first section refusing. Save-to-file plus "drag it into
  the issue" is the honest answer and costs the operator one gesture.
- **Screenshots.** Same shape, same answer, and the operator's own screenshot tool is better than
  anything shipped here.
- **Whether `0016` gains an issue template.** It must not, without revisiting the blank-issues
  paragraph above — a template with `blank_issues_enabled: false` would break every prefilled body
  this plan produces, silently, and only in production.

## Verified 2026-08-06

Built in an isolated worktree while 0014 was being built in the main tree, and merged with no
conflicts. 317 tests, `tsc` clean.

**The redaction holds, measured rather than argued.** Every value of eight characters or more in
the live `settings` table — all fourteen of them, including both Google tokens, the connected
account, the spreadsheet id and url, and the SMTP host, user, recipient and password — was
checked against the rendered body. **None survives.** The digest is described as *"host set, user
set, password stored, recipient set, port 465"*: the shape, never the value. The home directory,
the operator's address and the Cloud project number are all absent too.

**The page says what it is before it says anything else.** A panel above the form states that the
repository is public and that everything left in the box is published permanently, then lists
what the report does and does not carry, and ends on the line that matters: *"Read it anyway. You
are the one publishing it."* The title and body are both editable before the browser opens.

The nav entry carries `?from=` so the report names the surface the operator left — a `Referer`
would usually do it, but it is not guaranteed, and the links we control can simply say so.

**Not done, deliberately:** no issue was actually filed against the real repository. The check is
that the URL is well-formed and decodes back to the body that was rendered; filing a test issue
on a public tracker to prove a feature works is litter.
