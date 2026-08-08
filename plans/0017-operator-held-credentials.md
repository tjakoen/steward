---
id: 0017-operator-held-credentials
title: STEWARD — the binary carries no credentials at all, and the operator pastes them
status: doing
owner: admin
created: 2026-08-08
milestone: M4 (open source)
tags: [security, credentials, settings, picker, google, release, open-source]
tasks:
  - id: quota-caps
    title: Budget alert and quota ceilings — the only guard that works before this plan ships
    status: blocked
  - id: credential-source
    title: All four Google values resolved settings > env, read per request instead of at boot
    status: done
  - id: settings-card
    title: The card the operator pastes into, following the SMTP password precedent exactly
    status: done
  - id: google-copy
    title: What an unconfigured STEWARD says about Google, to somebody who has no .env
    status: done
  - id: unbake
    title: Ship nothing — the four defines, the four Actions secrets and their CI plumbing all go
    status: done
  - id: rotate
    title: Replace every credential already inside two public releases, and delete the old ones
    status: blocked
  - id: restrict
    title: Google Picker API only — the guard that replaces the referrer list
    status: blocked
  - id: readme-byo
    title: How a stranger who forked this gets their own Cloud project working
    status: done
  - id: share-file
    title: Import Google's own client_secret JSON, and export the set for another machine
    status: done
  - id: verify
    title: The gate — what has to be true before this counts as done
    status: doing
---

# STEWARD — the binary carries no credentials at all (0017)

`0016` shipped `v0.3.1` with all four Google values compiled into every published binary.
Measured on the published mac binary on 2026-08-08 — this is extraction, not theory:

```
$ strings -a steward-darwin-arm64 | grep -oE 'AIza[A-Za-z0-9_-]{35}'          # 1 hit
$ strings -a steward-darwin-arm64 | grep -oE 'GOCSPX-[A-Za-z0-9_-]+'          # 1 hit
$ strings -a steward-darwin-arm64 | grep -oE '[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com'
$ strings -a steward-darwin-arm64 | grep -oE '\b308363978170\b'
```

All four patterns hit. **The values themselves are deliberately not written down here** — this
file is in the same public repository as the binaries, and reproducing them would be the
mistake the plan is about. Run the commands; they are two seconds each.

**Project `308363978170` has a billing account attached**, so this is a bill, not just a rate
limit.

**STEWARD is being open sourced.** That is what makes the old trade indefensible rather than
merely untidy. `0016` accepted baked credentials on the reasoning that the audience was the
operator and one friend; a public repository with public binaries means every stranger who
downloads one connects through the operator's Cloud project, spends the operator's quota,
under the operator's consent screen — and any abuse report lands on the operator's project.

**Decision, taken 2026-08-08: the binary ships with nothing.** Not "baked with a settings
override" — that is convenience with the leak still in place, and it was explicitly rejected.
A published binary contains no client id, no client secret, no API key and no project number.
Google is dead in a fresh install until somebody pastes credentials into Settings.

## What this costs, stated plainly

**A downloaded STEWARD cannot connect a Google account until it is configured.** Uploads,
Drive, the Picker, Sheets sync and the digest's Drive links are all inert. Everything else —
clients, customers, tickets, PDFs, the local document store, the digest over SMTP — works on
first launch exactly as it does today, because none of it touches Google. That is the whole
of the price, and `google-copy` exists to make sure the app says so in sentences rather than
failing at the moment of use.

**It gates casually, not cryptographically.** A credential handed to a user can be handed on
by that user, and there is no way to revoke one person's copy — revocation means rotating for
everyone. This is access control by trust, and it is worth being honest that it is not more
than that.

**A stranger who forks the repo needs their own Cloud project.** That is the good outcome,
not a gap: their quota, their billing, their abuse surface, and the operator stops being a
bottleneck. `readme-byo` is what turns that from "abandoned" into "self-serve".

## One consequence worth noticing: a whole class of release bug disappears

`v0.3.0` shipped with Google entirely switched off because the repository had never had a
single Actions secret, `release.yml` handed `scripts/build.ts` four empty strings, and CI
stayed green throughout — `0016` § `build-secrets` has the whole story, and it cost a release.

**With nothing baked there are no build-time secrets at all.** The four `defines`, the four
repository secrets, and the `release.yml` plumbing that passes them all go away, and with them
the failure mode where an empty secret produces a green build and a dead feature. `0016`'s
standing pre-tag check — *`gh api …/actions/secrets --jq .total_count` must read 4* — is
deleted rather than adjusted, because after this plan the correct count is zero.

## What already exists, measured 2026-08-08 rather than assumed

| Piece | Where it already is |
|---|---|
| A settings-stored secret with a form door | `/digest/settings` (`server.ts:1273`) — the SMTP app password |
| "An empty password box means *leave it alone*, not *erase it*" | `server.ts:1308-1314`, with an explicit `forgetPassword` checkbox for the erase case |
| Paste hygiene for a value copied out of a Google console | `normalisePassword` — written for app passwords displayed with spaces, and every value in this plan is pasted out of Cloud Console |
| Keeping the values out of a public bug report | **Free.** `app/report/redact.ts` scrubs *every* `settings` value of `MIN_SECRET_LENGTH` (8) characters or more. All four are longer than that the moment they live in `settings` — and none is covered today, because a baked value is not in `settings` at all |

The read sites are few: `config.ts:82-92` builds them, `server.ts:1786` checks the key,
`app/google/oauth.ts` uses the client id and secret.

### The one real design point

`config` is a boot-time `as const` object (`config.ts:96`). Settings-held credentials change
while the process is running — the operator pastes them and expects **Connect Google Drive**
to work without a restart. So `config.google.*` cannot be the read site any more; the OAuth
start route, the callback, the readiness route and the Picker config door all have to ask the
repository at request time.

This is the substance of `credential-source`. Delete the fields from the frozen object rather
than leaving them alongside a new accessor: a compile error at every stale call site is the
point.

## The tasks

**`quota-caps`. HUMAN-GATED, and FIRST — it is the only thing that helps before the rest of
this plan ships.** The credentials are public *now*, in two downloadable releases, against a
billed project. Set a **budget alert** on `308363978170` (Billing → Budgets & alerts, email at
50/90/100%) and **quota ceilings** on Drive API and Picker API near real usage. The alert is
detection after money is spent; the ceiling is the actual stop. Do both, and do them before
`0017` is scheduled rather than as part of it.

**`credential-source`.** Resolve every Google value in the order **`settings` > `Bun.env`**,
evaluated per read. No third tier — the baked layer is gone. `Bun.env` stays so the
development loop against `.env` is untouched, which also means the maintainer's own workflow
never has to go through the Settings form.

**`settings-card`.** The Google section of `/settings` gains a card taking client id, client
secret, API key and project number, following `/digest/settings` line for line: never render a
stored secret back, an empty submit means unchanged, a `forget` control to clear, and
`normalisePassword` on the way in. Validate shapes, because this form invites exactly one
mistake — pasting the client id into the API key box. A browser key is `AIza` + 35 characters;
a client id ends `.apps.googleusercontent.com`; a Desktop client secret starts `GOCSPX-`; a
project number is digits. Each is distinctive enough to reject a swap at the door.

Unlike the SMTP card, this one renders **before** anything is connected — it is the
prerequisite for connecting, so it cannot be hidden behind a connection.

**`google-copy`.** Today the Settings page tells the reader to set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` "before starting STEWARD" (`server.ts:1985-1986`) and to set
`GOOGLE_API_KEY` (`server.ts:2000-2003`). **A downloaded binary's user has no `.env` to set
anything in**, so as written the instructions are unfollowable — the same shape of defect as
`0016`'s verify pass, which only tested Google-free paths. Rewrite both to point at the card,
and say plainly that STEWARD works without Google, so nobody thinks the app is broken.

**`unbake`.** Remove all four `defines` (`scripts/build.ts:39-42`), the `BUILD_*` constants
(`config.ts:28` and neighbours), the four repository Actions secrets, and the `env:` block in
`release.yml` that passes them. Delete `0016`'s `total_count` pre-tag check.

**`rotate`. HUMAN-GATED, and the task without which this plan buys nothing.** Publishing a
new release does not un-publish `v0.3.0` and `v0.3.1`. Order matters:

1. Ship the release carrying the Settings card.
2. Mint a **new** API key, and a **new** OAuth client (or regenerate the secret) in project
   `308363978170`.
3. Paste them into Settings on each machine that runs STEWARD; hand them to real users
   directly, out of band.
4. **Delete the old key and the old client in Cloud Console.** Not disable, not restrict —
   delete. Until this step the exposure is exactly what it was before this plan.

**Establish before doing step 2, do not assume:** whether regenerating the client secret
forces every already-connected account to reconnect. If it does, that is a one-line note in
the release announcement rather than a surprise, and it decides whether the client rotation
rides along with this release or waits for a quieter one.

**`restrict`. HUMAN-GATED.** On the new API key: leave *application* restrictions **off** —
the Picker sends an empty referrer and cannot work with a referrer allowlist, which is
`0016`'s hard-won finding and must not be relearned — and set **API restrictions → Restrict
key → Google Picker API only**. An extracted key then opens a picker and does nothing else.

**`readme-byo`.** A section for the person who forked this and has no credentials from anyone:
create a Cloud project, enable Drive API and Picker API, create a **Desktop app** OAuth client
and a browser API key, publish the consent screen to Production, then paste the four values
into Settings. This is also the honest answer to "why can't I connect Drive" for every
downloader who is not one of the operator's users.

**Worth checking while writing it:** whether the consent screen is Published/Production and
whether `drive.file` keeps STEWARD outside Google's verification requirements. Unverified apps
have user caps, and a public project that strangers connect to will find them.

## Verify — the gate

- **`strings` over every built binary finds none of the four values.** Specifically: no `AIza`
  key, no `GOCSPX-` secret, no `.apps.googleusercontent.com` id, and no `308363978170`. This is
  the single check that says the plan worked, and it is the one that was never run before
  `v0.3.0` shipped.
- A packaged binary from this tree, run with **no `.env` in reach and no `GOOGLE_*` in the
  environment**, boots, serves the whole non-Google app, and says in a sentence what Google
  needs and where to put it. That is the only state that reproduces a downloader's.
- Pasting the four values into Settings on that same running binary makes **Connect Google
  Drive** work, and then makes **Link from Drive** open a working Picker — **both without a
  restart**. A restart during testing would hide a failure of `credential-source`.
- **A signed-in human browser is the only thing that can confirm the Picker.** A headless
  browser renders Google's sign-in wall in front of the key check and shows the same screen
  whether the key is good or garbage. `0016` wasted a pass on this; do not repeat it.
- A bug report generated from a configured machine contains `<redacted>` where each of the four
  would be. Read the body; do not infer it from `redact.ts`.
- Clearing the credentials through the card's `forget` control leaves the app working, with
  Google switched off and saying so — not throwing.
- The old key and old client are **deleted** in Cloud Console, and a `v0.3.1` binary — which
  still has them baked — therefore fails to connect. That failure is the proof the rotation was
  real, and it is the one time in this project a broken Picker is a pass.

## Built and VERIFIED 2026-08-08 — everything that does not need Cloud Console

Five of the nine tasks are done: `credential-source`, `settings-card`, `google-copy`,
`unbake`, `readme-byo`. 388 tests (16 new), `tsc` clean. The three human-gated tasks —
`quota-caps`, `rotate`, `restrict` — are untouched by definition, and `verify` cannot close
until `rotate` does.

**The gate passed, and it is the check nobody ran before `v0.3.0` shipped.** A mac binary
built from this tree — a tree whose `.env` holds all four real values — carries none of them:

```
AIza[A-Za-z0-9_-]{35}                                CLEAN
GOCSPX-[A-Za-z0-9_-]+                                CLEAN
[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com   CLEAN
308363978170                                         CLEAN
```

That is the whole point of the plan, measured rather than reasoned. The same four patterns
against the *published* `v0.3.1` return all four values.

### What was run, against a packaged binary with no `.env` in reach

That state — `STEWARD_DATA` pointed at an empty directory, no `GOOGLE_*` anywhere — is a
downloader's, and it is the state `0016`'s verify pass never entered, which is how an entire
release shipped with Google switched off.

- `/healthz` answers `{"name":"steward","version":"0.3.1","packaged":true}`.
- `/files/picker-config` answers
  `{"ready":false,"missing":["a connected Google account","a Google API key","the Cloud project number"]}` —
  named as things to paste, not as environment variables a binary's user cannot set.
- `/oauth/google/start` **redirects to `/settings?google=no_credentials`** instead of
  returning a 400 that names `GOOGLE_CLIENT_ID`.
- **The rest of the app is untouched**: `/components.css` is 138,028 bytes (the recorded
  invariant) and `client.create` through the `/intent` door answers *Created client Acme.*

### Live pickup, which is the claim `credential-source` exists to make

Posting the four values to `/google/credentials` on a **running** server made
`/oauth/google/start` redirect to Google with the pasted `client_id`, and dropped the two
Picker entries from `missing` — **with no restart**. The leading whitespace of a pasted value
was stripped on the way in.

### The door refuses the mistake this form invites

Each of these came back to `/settings?cred=…` with a sentence, and **wrote nothing**:

| Pasted | Into | Answer |
|---|---|---|
| the OAuth client id | API key | *That does not look like a browser API key: AIza followed by 35 characters.* |
| `AIzaSyC24` (truncated) | API key | same |
| `steward-app` (a project *id*) | project number | *…the Cloud project NUMBER — digits only, not the project id.* |

Validation is a batch: nothing is written unless every supplied field passes, so a paste that
half-lands — new client id, old secret — is not a state the app can reach.

### The two behaviours that are easy to get wrong, both checked

- **An empty submit does not erase.** Posting an empty `clientId` answered `cred=saved` and
  `/oauth/google/start` still redirected to Google (302). This is 0013's rule and the reason
  changing one field never wipes another.
- **`forget` clears all four**, `googleAuth.disconnect()` runs with it — a connection whose
  credentials are gone cannot be refreshed, and leaving it "connected" would be a lie that
  only surfaces at the next API call — and `/oauth/google/start` goes back to 303
  `?google=no_credentials`.

### Redaction, read rather than assumed

With all four set on a packaged instance, the bug report body contains **zero** occurrences
of the API key, the client secret, or the client id's distinctive segment, and does contain
`redacted`. This is the property that made `settings` the right home for them: 0015 sweeps
that table, and a compiled constant was never in it.

### Two things changed that the plan did not ask for, both because they were now wrong

- **`makeSheetsMirror` took `clientId` as a captured string** and reported `configured` from
  it, so a client id pasted into a running app would have left the Sheets card saying "not
  configured" until the next restart. It now accepts `string | (() => string)`; the 26 test
  call sites pass a plain string, which is why the union exists rather than a bare thunk.
- **`/files/picker-config`'s `portNote` gave advice `0016` disproved.** It told the reader to
  add `http://localhost:<port>/*` to the key's referrer list — which can never work, because
  the Picker's own call presents an empty referrer. It now says the port is irrelevant to the
  key check and points at API restrictions.

**One thing to know before running the suite:** the repository's own `.env` is loaded into
`Bun.env` while tests execute, so `makeCredentials` takes its environment as an injected
parameter. A test that read the real `Bun.env` would pass or fail depending on whether the
developer happens to have credentials configured — four of them did exactly that before the
injection was added.

## `share-file` — added 2026-08-08, because four copy-pastes is the wrong handover

Asked for after the rest was built: a file to send someone, rather than four values read out
of one window into another. It turned out to be smaller than expected for two reasons that
were found by looking rather than designing.

**Google already produces the file.** Creating a Desktop OAuth client offers a
`client_secret_….json` download, so the import accepts *that*, unchanged, as its primary
input. Inventing a format the operator has to assemble by hand, next to a canonical one they
are already holding, would have been work for no reason — and retyping out of a file you have
open is exactly how a transcription error gets in. Desktop clients nest under `installed`,
web clients under `web`; both are read.

**It is three values, not four.** A Google OAuth client id is
`<project number>-<hash>.apps.googleusercontent.com`, so `projectNumberFrom` reads the
Picker's `appId` off a value the operator has to supply anyway. Checked against this
project's real client id and project number, which matched — not written down here, for the
reason at the top of this file. It returns empty rather than guessing when the shape does not
match, so the typed field stays authoritative and an unusual project still configures by
hand, and an explicit `project_number` in the file always wins over the derived one.

Google's file carries no API key — no Console download does — so the import says so rather
than leaving the operator thinking they are finished, which would surface much later as a
Picker that will not open.

**Export is a download, not text on the page.** It prints every credential this machine holds
in one blob, which is also the easiest possible way to leak them, so it takes a deliberate
click and lands in a file rather than sitting in the settings markup for anyone glancing at
the screen. The card says what the file contains and that it should not go anywhere public.

### Verified live, 2026-08-08

- **Google's own `client_secret_….json`, uploaded**: *Imported 3 values*, plus the sentence
  about the missing API key. `/oauth/google/start` then redirected to Google (302), and
  `/files/picker-config` no longer listed the project number — it had been derived.
- **Round trip**: with an API key added, **Export credentials** downloaded
  `steward-google-credentials.json` with all four; uploading that file into a *fresh* install
  answered *Imported 4 values* and left `missing: ["a connected Google account"]` — the only
  thing a file cannot carry.
- **The file path is not a way around the typed checks.** A valid JSON carrying
  `"apiKey":"AIzaTooShort"` was refused with the same sentence the typed field gives, and
  wrote nothing. Junk answered *That is not valid JSON*; an unrelated object answered *No
  credentials found*.

### Three defects found by running it, none visible to `tsc`

- **An empty import was a 500.** `backTo` puts its argument in a `Location` header, and the
  em dash in *"Nothing to import — paste JSON or choose a file."* is a `TypeError` there, not
  a mangled sentence. Every other message on the route went through `encodeURIComponent` and
  these two literals did not. Both now do.
- **The textarea rendered unstyled**, a white box overlapping its own label, because the form
  used `attach` — which styles a bare file input and nothing else — instead of `fb`, the form
  grid the rest of Settings uses. This is the class of defect that only a browser shows, and
  the reason the browser pass is the gate rather than the test suite.
- **The first attempt at this commit was rejected by GitHub's push protection**, because the
  test fixture and this document both carried the project's *real* client id and secret. The
  irony is the useful part: a plan about not putting credentials in a public artefact put
  credentials in a public artefact, four files away from the code that stops it. The fixture
  is now fabricated to the same shapes, and no real value is written down in `plans/` — they
  are reproduced by running a command, not by quoting.

  Worth keeping: **push protection is the only control in this repository that caught it.**
  `tsc` was clean, 397 tests passed, and the browser pass showed nothing, because none of
  them are looking for this. Consider enabling Secret Scanning on the repository — the push
  rejection noted it is eligible and not enabled — so the check does not depend on the
  secret being newly added in a push.
