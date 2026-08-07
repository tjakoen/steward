---
id: 0016-release
title: STEWARD — the first release anyone can actually download and run
status: doing
owner: admin
created: 2026-08-04
milestone: M3 (ship it)
tags: [release, packaging, readme, gatekeeper, smartscreen, ci, auto-update, windows]
tasks:
  - id: readme-install
    title: A front page that tells a non-developer what this is and how to run it
    status: done
  - id: update-404
    title: The answer the updater has never given — "no releases yet" is not an error
    status: done
  - id: version-bump
    title: 0.3.0 — the number the tag, package.json and every binary have to agree on
    status: done
  - id: picker-port
    title: The fallback port no allowlist can name, said out loud instead of discovered
    status: done
  - id: ci-rehearsal
    title: Make workflow_dispatch a real rehearsal — full gate, three artifacts, nothing published
    status: done
  - id: windows-check
    title: The script for the person with a Windows machine, and what each answer means
    status: blocked
  - id: tag-first
    title: Push the first tag ever pushed, and verify the release from a clean download
    status: blocked
  - id: update-live
    title: The second release — the only way the updater can ever be tested for real
    status: blocked
  - id: verify
    title: The gate — what a release has to survive before it counts as shipped
    status: doing
---

# STEWARD — the release (0016)

**Nothing in here starts until `0011`, `0012`, `0014` and `0015` are done.** That is the
human's rule, stated on 2026-08-04 in as many words — *"I'd like our plan to be complete
before we release"* — and it supersedes an earlier answer in the same exchange that put the
release after `0012`. It is also the right rule: a first release is the moment the version
number starts meaning something to somebody else, and shipping one at the halfway mark means
either a second release a week later or a public artifact that is missing the archive, the
filtering and the bug-report door. `plans/BACKLOG.md` records it; this plan inherits it.

What follows assumes that gate is met and describes what happens next. It is deliberately
short on building, because **the binaries are not a thing to build — they are already built.**

## Built and verified 2026-08-07 — everything that does not need a push

The gate at the top is met: `0011` closed on 2026-08-07 and `0012`, `0013`, `0014`, `0015`
were already `done`. Four tasks are built and checked; the rest are waiting on a human
click, and the split is exactly the one this plan predicted.

**`version-bump`.** `package.json` is `0.3.0`. One line, as designed — the packaged binary
built from that tree answers `/healthz` with `{"name":"steward","version":"0.3.0","packaged":true}`
without any other file being touched.

**`update-404`.** `checkForUpdate` now maps **404 only** to
`{ state: 'unsupported', reason: 'No releases have been published yet.' }`; every other
non-`ok` status keeps saying what it was. Two tests (372 total, `tsc` clean). This was
verified against **real GitHub, not a stub** — a packaged `0.3.0` binary asked
`api.github.com/repos/tjakoen/steward/releases/latest`, got the live 404, and returned the
sentence.

One correction to this plan's own wording, found by looking rather than reasoning: there is
**no failure colour**. GRAIN is monochrome on purpose — `--color-success` and
`--color-danger` both resolve to `--ink` (`styles/variables.css`: *"success/danger collapse
to ink in monochrome — signalled by weight/treatment, not hue"*). The signal is
`font-weight: 600` on `.form-status[data-ok="false"]` (`frontend/client/steward.css:231-233`),
measured at 600 against 400. So the card was not printing the 404 in red; it was printing it
in **bold**, which is the same claim in GRAIN's vocabulary. The fix is unchanged and now
also covers the other `unsupported` cases: the card renders `state: 'unsupported'` with
`ok = true`, so a checkout, a platform with no build, and a repo with no releases are all
sentences rather than faults.

**`readme-install`.** `README.md` went from 49 developer-facing lines to a front page that
opens with **Install**: the three asset names as published, the quarantine and SmartScreen
overrides with the reason attached, `shasum -a 256 -c SHA256SUMS --ignore-missing` and
`Get-FileHash` (the `--ignore-missing` flag confirmed working on macOS's `shasum`, which is
not GNU coreutils), Chrome/Edge and Ollama as consequences rather than a checklist, the
three data directories, `steward.env`, `steward.log`, and the `VACUUM INTO` warning that
0011 paid for. The developer section survives, one heading lower. The `Status` line no
longer claims plan `0001`.

**`ci-rehearsal`** — written, not yet run. `release.yml` now skips the tag/package.json
check when `github.event_name != 'push'`, guards **Publish** with
`if: github.event_name == 'push'`, and uploads the darwin and linux binaries plus
`SHA256SUMS` as a `steward-rehearsal` artifact on a dispatch. The safety moved from *the
tag check happens to fail* to *the publish step says when it runs*. It cannot be exercised
until the workflow file is on GitHub's default branch, which needs a push.

**`picker-port` — the open question at the bottom of this plan, now decided.** Of the two
honest options, *fail loudly when the preferred port is taken* is the wrong one: the
fallback exists because something else holds 3000, and refusing to start then would trade a
possibly-broken Picker for a certainly-unusable app. So `/files/picker-config` returns a
`portNote` whenever the bound port is not the configured one, and `steward-picker.js` shows
it and **opens the Picker anyway** — an unrestricted key works on any port, and refusing to
try would be guessing at a Cloud Console setting the app cannot read. The note names the
actual port and both ways out. It fires only on the OS fallback, because that is the case
no allowlist can express; a port the operator set in `steward.env` is one they can allowlist.

Also checked on the packaged `0.3.0` binary, from a scratch `STEWARD_DATA` so no real data
was touched: `/components.css` at exactly **138,028 bytes** (0009's invariant, still true at
0.3.0), and a demo ticket rendering a **61,134-byte** PDF through packaged Chrome. `dist/`
was `rm -rf`'d first — the stale-`SHA256SUMS` trap below is real, and those 2026-08-01
binaries are gone. `git diff build/assets.gen.ts` is empty after the build, so the checked-in
manifest describes it.

## The rehearsal, run for real on 2026-08-07 — run `31159428657`

The human authorised the push, so `953d6e6` and `1b0d278` went to `origin/main` and the
workflow ran by hand for the first time in this repo's life. **Both jobs green, and the two
steps that were supposed to be skipped were skipped:**

```
✓ windows in 36s          ✓ release in 31s
  ✓ bun install             - The tag matches package.json     ← skipped, no tag on a dispatch
  ✓ bun run build:win       ✓ bun run check
  ✓ upload-artifact         ✓ bun test          372 pass, 0 fail
                            ✓ download-artifact (the windows exe, into dist/)
                            ✓ Build the other two
                            ✓ The checked-in manifest matches this commit
                            ✓ Keep the binaries a rehearsal built
                            - Publish                          ← skipped, not a push event
```

`gh release list` is empty afterwards. The rehearsal published nothing, which is the whole
claim.

All three binaries came back as artifacts and `shasum -a 256 -c SHA256SUMS` says `OK` for
each — including `steward-windows-x64.exe`, which was built on a different runner and
downloaded into `dist/` before the checksums were written. That ordering is what makes one
sums file cover three machines' worth of output, and it now has evidence rather than a
comment. It also runs the README's own command verbatim, so that instruction is tested.

The CI-built **darwin** binary boots, reports `0.3.0`, serves `/components.css` at 138,028
bytes, and answers the live GitHub 404 with the sentence. CI's artifact and the local build
agree.

**Two things learned about the Windows exe without a Windows machine:**

- **The icon took.** All six images in `assets/steward.ico` are byte-for-byte present inside
  the CI exe, and the resource directory differs from a cross-compiled control build
  (16,628 bytes against 272,336 — the flag replaced Bun's default resources rather than
  adding to them). That is `windows-check`'s "confirm the icon in Explorer" item, answered
  here. The `windows-latest` job exists for exactly this and it is doing its job.
- **`--windows-hide-console` does not change the PE subsystem.** Both the CI exe and a
  cross-compiled control report subsystem **3 (console)**, not 2 (GUI); Bun hides the window
  at runtime instead. Practically this changes one sentence: a launch that dies *before* that
  runtime hide can still flash a console, so "invisible by construction" is slightly too
  strong. `steward.log` remains the answer either way, and it is written before the server
  binds.

What is left is `windows-check` on a real machine — which can now use run `31159428657`'s
artifact rather than waiting for a release — plus `tag-first` and `update-live`.

## What already exists, measured on 2026-08-04 and not to be re-derived

`scripts/build.ts:20-24` compiles three targets — `bun-windows-x64`, `bun-darwin-arm64`,
`bun-linux-x64` — stamps the version out of `package.json` (`scripts/build.ts:15`), bakes the
Google constants in through `--define` (`scripts/build.ts:36-43`), and writes a `sha256sum`
-format `SHA256SUMS` over **everything sitting in `dist/`** rather than only what this run
compiled (`scripts/build.ts:119-125`). `.github/workflows/release.yml` fires on `v*`, builds
the Windows target on its own `windows-latest` runner (`release.yml:21-40`) because
`--windows-hide-console` and `--windows-icon` are refused when the host is not Windows
(`scripts/build.ts:65-75`), downloads that artifact into `dist/` before compiling the other
two so the checksums name all three, runs `bun run check` and `bun test` on the exact commit
being released (`release.yml:69-70`), asserts the checked-in manifest still matches
(`release.yml:92-93`), and publishes four files with `gh release create`
(`release.yml:99-105`).

Version is `0.2.0`. **No tag has ever been pushed** — `git tag -l` is empty — so no release
exists, and every mechanism above has run exactly zero times.

The mac binary was rebuilt from the current tree and run: it boots, serves `/components.css`
at exactly 138,028 bytes (0009's recorded invariant, `plans/0009-shell.md`), and renders a
real 75,740-byte branded ticket PDF through packaged Chrome. `build/assets.gen.ts` did not
move, so the checked-in manifest describes the binary. The riskiest packaged path — embedded
assets, `bun:sqlite`, the CDP driver — works.

Two facts about the audience that shape everything below. The mac target is **arm64 only**;
there is no Intel build and this plan does not add one. And a machine running a binary still
needs **Chrome or Edge** for PDFs (`app/pdf/print.ts:22-30`, `CHROME_PATH` overrides) and
**Ollama** for chat (`app/ai/ollama.ts:15`, `OLLAMA_URL`). Both degrade honestly rather than
crashing, which is a 0009 decision, but neither is optional if the operator wants the feature.

## Unsigned, on purpose, and the README says so out loud

`codesign` reports `flags=0x20002(adhoc,linker-signed)` on the mac binary and `spctl -a -vv`
answers `invalid signature`. That is what Bun emits and there is no build flag that changes
it. A downloaded copy carries the quarantine attribute and Gatekeeper refuses it. On Windows
the unsigned exe draws a SmartScreen warning for the same underlying reason — no certificate,
no reputation.

**DECIDED: ship unsigned and document the override.** An Apple Developer ID is $99/yr and a
Windows OV certificate several hundred, and the audience today is the operator and one friend.
Worse, the Windows money buys almost nothing on its own: SmartScreen reputation accrues with
downloads, so a fresh certificate on a product nobody has downloaded still warns. Two people
paying six hundred dollars a year to skip two clicks is not a trade, and the decision is
cheap to reverse — a signed build changes the workflow, not the product. Revisit when a
stranger downloads it.

What that buys instead is a documentation obligation, and it is the real work:

- macOS: `xattr -dr com.apple.quarantine ./steward-darwin-arm64`, then `chmod +x`. Written as
  a command a non-developer can paste, with the sentence explaining *why* it is needed next to
  it, because a paste-this-into-Terminal instruction with no reason attached is exactly the
  shape of every malware install guide.
- Windows: the SmartScreen dialog hides the run button behind **More info → Run anyway**. Say
  that, name the two labels, and say it in the README rather than in a chat message that the
  friend on Windows will not have.

Neither instruction is a workaround for a bug. Both are the honest consequence of a decision
recorded here, and the README should frame them that way.

## The README exists — and it does not say how to run this

There is a `README.md`, so this plan does not have to invent one. It has 49 lines and it is
**entirely a developer's README**: concepts, `bun install`, `bun run dev`, the layer list, a
`Status` line that still reads *"Foundation (plan `0001`)"* with the packaged binary listed as
a future roadmap item. The repo went public on 2026-08-04. Its front page currently tells a
visitor that the thing is at plan one of sixteen and offers them a `git clone`.

That is the largest single deliverable in this plan, and it is bigger than any certificate.
A public repo whose front page cannot answer *what is this and how do I run it* has a
distribution problem that no amount of code signing fixes.

What `readme-install` adds, in the order a stranger needs it:

- **A download section, per platform**, naming the three assets exactly as they are published
  (`steward-windows-x64.exe`, `steward-darwin-arm64`, `steward-linux-x64` — the names come
  from `assetName()`, `app/update.ts:35-39`, and the updater matches on them literally, so
  they are a contract, not a label).
- **The unsigned overrides**, verbatim as above.
- **The prerequisites**, stated as consequences rather than a checklist: no Chrome or Edge
  means no PDFs and everything else works; no Ollama means the chat panel says the model is
  not running and everything else works.
- **Where the data lives** — `%LOCALAPPDATA%\STEWARD`, `~/Library/Application Support/STEWARD`,
  `$XDG_DATA_HOME/steward` (`app/paths.ts:43-58`) — because "where are my files" and "how do
  I back this up" are the same question and the answer is one directory.
- **`steward.env` in that directory**, which is how a port or an `OLLAMA_URL` is changed
  without a rebuild. It is the only configuration surface a shipped binary has.
- **Where the evidence is when nothing appears**: `<dataDir>/steward.log` (`app/log.ts:18`).
  This matters more on Windows than anywhere else, because the release exe is built with
  `--windows-hide-console` — a failed launch is, by construction, *invisible*, and the log is
  the only thing standing between that and a bug report saying "it didn't do anything".
- **How to verify a download**, using the published `SHA256SUMS`: `shasum -a 256 -c` on mac and
  Linux, `Get-FileHash` on Windows. A project that ships unsigned binaries and does not tell
  people how to check them is asking for trust it has not offered any way to verify.
- A **Status** line that stops claiming plan 0001.

Keep the developer section. It is still true and it is still the second thing a visitor wants;
it just is not the first.

## The version, and why it is not 0.2.0

`package.json` says `0.2.0`, and `release.yml:57-64` fails the build when the tag and that
field disagree — deliberately, because a binary reporting a version no release carries makes
`compareVersions` (`app/update.ts:48-67`) permanently wrong in a way nobody notices until
somebody actually needs an update.

**DECIDED: the first public release is `v0.3.0`, and `version-bump` moves `package.json`
first.** Three reasons, in order of weight:

1. `0.2.0` describes the pre-0010 tree. Since it was set, STEWARD has gained the Sheets mirror,
   the boot log, the archive, the digest, the drawer tabs and filtering, the sheet-driven writes
   and the bug-report door. Publishing all of that under the number the tree already carried is
   the one thing semver exists to prevent.
2. **Hand-built `0.2.0` binaries already exist on this machine** — `dist/` holds them right now.
   If the first release is also `0.2.0`, every one of those copies asks GitHub, is told `0.2.0`,
   and concludes it is up to date forever. The version is the only identity a binary has; do not
   spend it twice.
3. `0009` already wrote the example that way (`release.yml:3`, `git tag v0.3.0`), which is weak
   evidence but free.

The bump is one line in `package.json` and nothing else — `scripts/build.ts:15` reads it,
`--define` stamps it (`scripts/build.ts:38`), `app/paths.ts:29` reports it, and CI checks it.
That single source is the whole reason this is a one-line task rather than a sweep.

## A rehearsal that publishes nothing — and the reason it does not work yet

`workflow_dispatch` is already on the workflow (`release.yml:13`), and running it today does
something worth knowing about before it is relied on. `GITHUB_REF_NAME` for a dispatch on the
default branch is `main`, so the tag check computes `TAG=main`, compares it to `0.2.0`, and
exits 1 (`release.yml:57-64`). The `release` job therefore dies **before** `bun run check`,
before `bun test`, and long before `gh release create`.

That is half right and half useless. It is right in that a dispatch cannot publish — the job
fails several steps upstream of the publish, so there is no path to a bad release. It is
useless in that the dispatch proves almost nothing: the gate never runs, the darwin and linux
builds never run, and the manifest check never runs.

But the `windows` job **does** run, in full, and uploads `steward-windows-x64.exe` as a run
artifact (`release.yml:36-40`). That is the single most valuable thing in this plan and it is
already available: **a Windows exe built the way a release builds it — on a Windows host, with
the icon and the hidden console — downloadable from a workflow run, before any tag exists.**

So `ci-rehearsal` makes the dispatch honest:

- Skip the tag/package.json check when `github.event_name != 'push'`. On a dispatch there is no
  tag to agree with, and the check is meaningless rather than failing.
- Run everything else: the gate, both builds, the manifest check, `SHA256SUMS`.
- Guard the **publish step** with `if: github.event_name == 'push'`, so the only thing a
  dispatch cannot do is create a release. Move the safety from an accident of the tag check to
  a condition that says what it means.
- Upload the darwin and linux binaries plus `SHA256SUMS` as run artifacts on a dispatch, so the
  rehearsal produces something a person can download and run.

Two traps, both of which have already bitten this repo once each:

- **`SHA256SUMS` is generated over everything in `dist/`** (`scripts/build.ts:119-125`), which is
  correct in CI and dangerous locally. Right now `dist/` on this machine holds a darwin binary
  from 2026-08-04 beside a linux and a windows binary from 2026-08-01 — and a `SHA256SUMS` dated
  the 4th that confidently names all three. Any local rehearsal starts with `rm -rf dist`.
- The dispatch runs from a branch, so the manifest check (`release.yml:92-93`) is checking the
  branch's `build/assets.gen.ts`. That is what makes it a useful rehearsal — it catches a stale
  manifest *before* the tag rather than as a failed release.

## The 404 nobody has ever seen, and the sentence it prints

`app/update.ts:31` points at `api.github.com/repos/tjakoen/steward/releases/latest`, with no
token, by design — 0009 recorded that releases would be public and a token in a shipped binary
is a credential anyone can pull out of it. The repo went public on 2026-08-04, so that URL is
now reachable unauthenticated. It answers **404** until the first tag exists, which is the
normal no-release-yet state and not a fault.

Follow it through. `checkForUpdate` sees `!res.ok` and returns
`{ state: 'error', reason: 'GitHub answered 404' }` (`app/update.ts:111`). The Settings card
falls through to `say(r.reason)` (`server.ts:1565`, fetched at `server.ts:1562`) with no `ok` flag, so the operator
clicks **Check for updates** on a brand-new install and is told, in the failure colour, *GitHub
answered 404*. That is technically true and practically a lie: nothing is wrong, there simply
is not a release yet.

`update-404` maps that one status to a human sentence. Use the existing `unsupported` state
rather than inventing a fourth — it already means *nothing here for this machine, and that is
not your fault*, which is exactly the case (`app/update.ts:122` uses it for a release with no
asset for this platform). Reason text: `No releases have been published yet.` One test beside
the fourteen already in `app/update.test.ts`.

It is a five-line change and it is in this plan rather than a follow-up because **it is the
first thing a first user will click**, and the window in which it is wrong is exactly the
window between the repo going public and the tag going up.

## The Windows gap, which is the one gap money cannot close

The Windows exe has never been executed. There is no Windows machine, and that has been true
since 0009 wrote the same sentence. Everything known about it is that it compiles to a valid
PE32+ file. Unverified: `bun:sqlite` under a cross-compiled Windows build, `%LOCALAPPDATA%`
resolution (`app/paths.ts:47-51`), Chrome/Edge discovery (`app/pdf/print.ts:22-26`), the
`cmd /c start` browser launch, and — the one with teeth — renaming a running `.exe` out of the
way (`app/update.ts:186-192`).

`plans/0009-shell.md` carries a three-command version of the check. It is a good instinct and
it does not survive contact with a real Windows shell: `curl` in PowerShell is an alias for
`Invoke-WebRequest` and takes different arguments, `wc -c` does not exist, and the release exe
is built with `--windows-hide-console`, so `.\steward-windows-x64.exe` from a prompt gives no
output at all and looks like nothing happened.

The script to hand over, in PowerShell, run from the folder holding the downloaded exe:

```powershell
# 0. Prove the bytes are the published ones before running anything.
Get-FileHash .\steward-windows-x64.exe -Algorithm SHA256 | Format-List
#    Compare against the steward-windows-x64.exe line in SHA256SUMS.

# 1. Launch it. Hidden console: expect NO output here. A browser tab should open.
Start-Process .\steward-windows-x64.exe

# 2. Is it answering, and as what?
(Invoke-WebRequest http://localhost:3000/healthz).Content
#    Expect {"name":"steward","version":"0.3.0","packaged":true}

# 3. The embed invariant — the one number that proves the assets travelled.
(Invoke-WebRequest http://localhost:3000/components.css).Content.Length
#    Expect 138028

# 4. Where it put things, and what it said while starting.
Get-ChildItem $env:LOCALAPPDATA\STEWARD
Get-Content   $env:LOCALAPPDATA\STEWARD\steward.log -Tail 40
```

What each answer means, which is the half a bare script leaves out:

- **Step 1 opens no browser and step 2 fails.** Read `steward.log` first — it exists before the
  server binds, and a crash out of top-level await lands in it (0010). If there is no log file
  at all, the failure is earlier than STEWARD: SmartScreen blocked it (**More info → Run
  anyway**), or the process died before `app/log.ts` ran, and that is a `bun:sqlite`-on-Windows
  question.
- **Step 2 answers on a different port.** Not a failure. Port 3000 was taken and `app/launch.ts`
  took one from the OS; `steward.log` names the real URL. Re-run steps 2 and 3 against it.
- **Step 3 is not 138028.** The binary is missing embedded assets, and every page will look
  subtly wrong rather than broken. This is the failure mode 0009 built the manifest test for,
  and seeing it here would mean the Windows runner built from a stale `build/assets.gen.ts`.
- **Step 4 shows no `steward.db`.** `%LOCALAPPDATA%` did not resolve, or SQLite could not open a
  file there. This is the one that would invalidate the whole packaging approach on Windows.

Then, by hand and in this order, because each is a path no test can reach:

- Click through the nine routes. Anything 500s → `steward.log`.
- **Generate a ticket PDF.** This is the Chrome/Edge discovery path, never once executed on
  Windows, and the reason Edge is in the candidate list at all — it ships with the OS, so this
  should work on a machine where nobody installed anything.
- Confirm the exe has STEWARD's icon in Explorer. That proves the `windows-latest` runner's
  flags actually took, which is the entire reason that job exists.
- Close it and double-click it twice. The second launch should say STEWARD is already running,
  open the browser at the first instance, and exit — not start a second server on a second port
  with a second database.

`windows-check` is **gated on a human with a Windows machine**, and the plan does not close
without it. It can, however, run against the `ci-rehearsal` artifact — before any tag exists.
That ordering is the point: find out whether the exe works *before* publishing it, not after.

## The updater's first real test needs two releases, and can be staged

Every line of `app/update.ts` is tested (`app/update.test.ts`) against stubbed `fetch`
implementations, and none of it has ever touched GitHub. The gap is not the logic — it is that
`checkForUpdate` has never parsed a real release payload, `applyUpdate` has never verified a
real `SHA256SUMS` against real downloaded bytes, and no binary has ever renamed itself out of
the way and re-exec'd (`app/update.ts:179-193`, `server.ts:1633-1639`).

**One release cannot test this.** A `v0.3.0` binary asking about a `v0.3.0` release gets
`{ state: 'current' }` and stops — correctly. So `update-live` stages the second one:

1. Ship `v0.3.0`. Keep a copy of the `steward-darwin-arm64` from that release in a directory of
   its own, outside the repo, with the quarantine attribute cleared.
2. Land one visible, trivial change — the version line in Settings is enough — bump
   `package.json` to `0.3.1`, tag `v0.3.1`, let CI publish.
3. Run the parked `0.3.0` binary. **Check for updates** must say `Version 0.3.1 is available.`
   **Download and restart** must verify the checksum, park the old binary as
   `.steward-0.3.1.old`, write the new one at the same path, and re-exec. `/healthz` then reports
   `0.3.1`, and the parked file is gone — deleted by the next boot's `cleanupOldBinaries`
   (`server.ts:1633-1639`), which is the only moment at which throwing away the last known-good
   copy is safe.
4. Then break it on purpose: hand `applyUpdate` a `SHA256SUMS` that does not match and confirm
   the mismatch message, and confirm **the running binary is untouched** (`app/update.ts:175-177`).
   A checksum check nobody has watched fail is a checksum check nobody has tested.

One thing to find out rather than assume: an in-app update writes bytes with `Bun.write`, which
does **not** set the quarantine attribute the way a browser download does. If that holds, the
Gatekeeper problem is a first-download problem only and every subsequent update is clean —
which materially changes how much the missing certificate costs. Check it; do not claim it.

The same swap on Windows is the single riskiest untested path in the product, because its
failure mode is not a broken update but an **unbootable install**. It belongs in
`windows-check`'s hand pass, at the end, once everything else has passed.

## Verify — the gate

`tsc` cannot see a Gatekeeper dialog and it cannot see a Windows machine. What has to be true:

- `bun run check` and `bun test` green on the commit that gets the tag — enforced by CI
  (`release.yml:69-70`), but run locally first, because a failed release job leaves a tag
  pointing at a commit that never produced binaries.
- A `workflow_dispatch` run goes green end to end, produces three binaries and a `SHA256SUMS`
  as artifacts, and **creates no release**. Confirmed by looking at the releases page, not by
  reading the workflow.
- The release exists at `v0.3.0` with four assets, named exactly as `assetName()` produces them.
- **A fresh download on a machine that has never seen the repo**: `shasum -a 256 -c SHA256SUMS`
  passes, the quarantine command in the README works verbatim as written, and the binary boots,
  serves `/components.css` at 138,028 bytes, and renders a ticket PDF.
- **Check for updates** on that fresh `0.3.0` install says *Up to date* — not `GitHub answered
  404`, and not an error colour. Before the tag, on a hand-built binary, it says *No releases
  have been published yet.*
- **Someone has run the exe on Windows** and answered every step of `windows-check`, including
  the PDF and the second-launch behaviour. This is the one that cannot be faked, and it is the
  gate on this plan being called done — the same shape as `0013`'s live SMTP send.
- Two releases exist and the updater has moved a real binary from `0.3.0` to `0.3.1` on at least
  one platform, with the checksum-mismatch path watched failing safely.

`0009` closed saying *Windows is built and untested*. `0016` does not get to close saying that.

## Still open, and deliberately not decided here

- **Code signing, both platforms.** Decided against on cost and audience, not on principle. The
  trigger to revisit is a stranger downloading it, or a Windows user who cannot get past
  SmartScreen — not a date.
- **An Intel mac build.** `bun-darwin-x64` is one line in `TARGETS` (`scripts/build.ts:20-24`)
  and roughly 64 MB more per release. Nobody has asked; add it when someone does, and note that
  `assetName()` already computes the right name for it.
- **Release notes.** `--generate-notes` (`release.yml:101`) on the *first* tag has no previous
  tag to diff against and will emit every commit in the repo's history. Live with it once, or
  hand-write the first release's body; either is fine and neither is worth a task. Later
  releases diff against `v0.3.0` and behave.
- **An update channel or a pre-release track.** `compareVersions` already sorts `0.3.0-rc.1`
  before `0.3.0` (`app/update.ts:62-66`), so the machinery exists — but GitHub's
  `releases/latest` skips pre-releases, so an rc would be invisible to the updater. That is a
  feature until somebody wants a beta, at which point it is a design question.
- **Anything installer-shaped** — MSI, notarized DMG, Homebrew tap, winget. A single downloaded
  file with a documented override is the whole distribution story for two people, and every one
  of those alternatives brings its own signing requirement back in through the side door.

## Two things added 2026-08-06, after the first real setup session

**The API key's referrer restriction is a release blocker in waiting.** The operator restricted
`GOOGLE_API_KEY` to `http://localhost:3211/*`, which is right for this machine and wrong for a
shipped binary: `config.ts` defaults the port to **3000**, and `app/launch.ts` falls back to an
**OS-chosen** port when the preferred one is taken. So a released app's Picker referrer is
normally `http://localhost:3000/*` and occasionally an arbitrary high port that no allowlist can
name.

Leaving it as `:3211` for now costs nothing — it is a Cloud Console setting, changed in half a
minute, and no code depends on it. It is recorded here so it cannot be forgotten:

- **Before the tag:** add `http://localhost:3000/*` to the key's HTTP-referrer list.
- **The fallback port has no allowlist answer.** Google's referrer restrictions cannot express a
  port range. Everything else — Drive upload and download, the digest, PDFs, the updater — is
  unaffected, because only the Picker runs in a browser against that key. The honest options are
  to say so in the UI when the app is not on its default port, or to make the packaged app fail
  loudly rather than silently take a different one. Decide in this plan; do not let it be
  discovered by a user whose port 3000 was busy. **DECIDED 2026-08-07: say so, and open the
  Picker anyway** — see `picker-port` above.

**A GRAIN upstream candidate: the snackbar.** 0012 built one because GRAIN ships no toast —
`components/molecules/` has `callout` and `status-list`, neither of which is a transient
notification. It is a single live region with a polite announcement, a self-clearing success and
a sticky failure, and nothing in it is STEWARD-specific. The operator asked for it to go
upstream **after they have used it for a while**, which is the right order: 0007 established
that upstreaming to GRAIN means a published version and a release that cannot be withdrawn, so
the component earns its way there by being lived with first.
