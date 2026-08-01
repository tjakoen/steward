---
id: 0009-shell
title: STEWARD — one Windows binary, updating itself from GitHub Releases
status: done
owner: admin
created: 2026-08-01
milestone: M3 (ship it)
tags: [packaging, bun-compile, windows, auto-update, release, sse, manifest]
tasks:
  - id: assets-embed
    title: Embed every file the server reads at runtime; one code path in dev and in the binary
    status: done
  - id: paths
    title: A per-user data directory — the db, the documents and .env stop being cwd-relative
    status: done
  - id: stream-idle
    title: Fix /stream dying after 10s of quiet (idleTimeout + a heartbeat)
    status: done
  - id: manifest-truth
    title: Stop advertising a `reflection` surface no page renders
    status: done
  - id: chrome-windows
    title: Find Chrome or Edge on Windows, and say so honestly when neither is there
    status: done
  - id: compile
    title: scripts/build.ts — cross-compile the three targets, stamp version, --define the client id
    status: done
  - id: first-run
    title: Boot on a clean machine — port fallback, open the browser, second launch focuses the first
    status: done
  - id: update
    title: Check GitHub Releases, verify the checksum, rename-swap the running exe, restart
    status: done
  - id: history-audit
    title: Prove the git history carries no secret BEFORE the repo goes public (GATED ON HUMAN)
    status: done
  - id: release-ci
    title: A tag builds three binaries, a SHA256SUMS and a release
    status: done
  - id: verify
    title: The gate — what a Mac can prove, and what only a Windows box can
    status: done
---

# STEWARD — the shell (0009)

STEWARD is a server that reads its own source tree. `config.ts` resolves GRAIN through
`import.meta.resolve` and hands four directories to `makeStatic`, `createStyleBundle`
walks `node_modules` on every cold start, MILL reads `content/`, PROOF reads `plans/`,
and the database is the relative string `data/steward.db`.

Every one of those is a runtime `readdir` against a tree that will not exist inside a
`bun build --compile` binary. That — not the compile flag — is the whole of this plan.

## What was measured first, on this machine, today

Four things this plan rests on, checked rather than remembered:

| Claim | Result |
|---|---|
| `bun build --compile --target=bun-windows-x64` from macOS | works — `PE32+ executable (console) x86-64`, 94 MB, 2.9s |
| `import x from "./a.css" with { type: "file" }` | dev: real path. Binary: `/$bunfs/root/a-5zbvvaxz.css`. **`Bun.file(x).text()` reads both.** |
| A compiled binary reads `.env` | yes — **from the cwd**, not from beside the exe. Run it from another directory and the env is gone. |
| `Bun.embeddedFiles` | populated (1) in the binary, empty (0) in dev |

The second row is the load-bearing one: the *same source line* works in `bun server.ts`
and in the binary. So this is not a packaged build with a parallel code path to rot —
it is one path, exercised by the 84 tests that already run.

The third row kills the idea that `.env` beside the exe is enough. Cwd is the exe's
folder when Explorer launches it, and something else the moment anyone makes a shortcut
or opens a terminal. Config has to come from a place that does not move.

## 1. `assets-embed` — the manifest

Everything the server reads from disk after boot, and what happens to each:

| Read | Where | Verdict |
|---|---|---|
| `createStyleBundle` over `config.styleRoots` | `server.ts:604`, 52 css under GRAIN `components/`, STEWARD's `frontend/components/`, GRAIN `ai/` | embed |
| `makeStatic` over `config.assetDirs` | `server.ts:605` — `/styles` (8), `/scripts` (30), `/assets` (2), `/app` (5) | embed |
| `serveFonts` over `config.fontsDir` | `server.ts:608`, 4 woff2 | embed |
| `css()` / `js()` via `import.meta.resolve` | `server.ts:610-613` — proof and crumb's css+js, 4 files | embed |
| `dirSource(content/help)`, `dirSource(content/)` | `server.ts:583-584`, MILL | embed |
| `plansDir` (PROOF), `toursDir` (CRUMB) | `server.ts:592-601` | **not** embedded — see below |
| `pagesDir` (`makePageServer`) | `server.ts:122`, `frontend/pages/` is empty | nothing to embed; must not throw when absent |

`plans/` is the internal development board and `tours/` does not exist. Shipping this
plan file to an operator is noise, not a feature. Both stay filesystem-backed and both
must **404 rather than throw** when the directory is not there — `createProofRoutes`
against a missing `plansDir` is unguarded today and a packaged binary is exactly where
that first bites.

### How it is generated

`scripts/gen-assets.ts` walks those roots and writes `build/assets.gen.ts`:

```ts
import a0 from '../node_modules/@tjakoen/grain/styles/variables.css' with { type: 'file' };
// …
/** Serve key → embedded path. */
export const ASSETS: Record<string, string> = { '/styles/variables.css': a0, … };
/** The style bundle, in the exact order the dev-time bundle concatenates it. */
export const BUNDLE: string[] = [a4, a17, …];
```

The generated file is **checked in**, and `build/assets.test.ts` regenerates it in memory
and asserts equality. Same mechanism as `app/view/css.test.ts` (plan 0008): a rule with no
test is a rule that drifts, and this one drifts silently — a new GRAIN component appears
after a `bun install`, the dev server serves it, the binary does not, and the only symptom
is unstyled markup on someone else's machine.

### The ordering trap

`createStyleBundle` collects every root and then calls `files.sort()` **once, globally, over
absolute paths** (`@tjakoen/batch/assets/style-bundle.ts`). So the cascade order today is a
function of where `node_modules` happens to sit on disk. Absolute paths inside the binary are
`/$bunfs/root/…` and sort differently.

`BUNDLE` therefore records the **order** at generation time, as an array, and the runtime
concatenates in that order without re-sorting. Get this wrong and the CSS all loads, in the
wrong cascade, and nothing errors — the worst failure mode this codebase has (0008's whole
subject was exactly that: rules that win by load order rather than by design).

Proof it is right: `/components.css` from the binary must be **byte-identical** to
`/components.css` from `bun server.ts`. That is one `diff`, and it is the task's definition
of done.

### What changes in `server.ts`

`makeStatic`, `serveFonts`, `css()`, `js()` and `styles.css()` are replaced by lookups into
`ASSETS`. The traversal guard `makeStatic` provides is not lost — it becomes *stronger*: a
map lookup cannot escape its root, because there is no root to escape. Unknown key → 404.

`config.assetDirs` / `fontsDir` / `styleRoots` stay, because `gen-assets.ts` reads them. The
composition root keeps describing the app; only the serving stops touching disk.

## 2. `paths` — where a shipped app keeps things

`app/repo/db.ts:9-11` returns `'data/steward.db'`, relative to the cwd. `config.docsDir` is
`<repo>/data/documents`. Neither is defensible once the exe moves.

New `app/paths.ts`, with one switch:

```ts
declare const STEWARD_PACKAGED: boolean;   // --define'd true by scripts/build.ts, false in dev
```

- **Dev** (`STEWARD_PACKAGED === false`): everything stays exactly where it is. `data/steward.db`,
  `data/documents`, `.env` from the repo. Nothing about the current workflow moves, and the 84
  tests keep passing without touching a single fixture.
- **Packaged**: `%LOCALAPPDATA%\STEWARD` on Windows, `~/Library/Application Support/STEWARD` on
  macOS, `$XDG_DATA_HOME/steward` (else `~/.local/share/steward`) on Linux. `STEWARD_DATA`
  overrides all of it.

Detecting packaged mode by sniffing `import.meta.dir` for `/$bunfs` would also work and is
worse: it is an implementation detail of Bun's embedder and it is not settable from a test.
A `--define`d constant is both.

The db path, `docsDir`, and a `steward.env` read at boot from that directory all move behind
`app/paths.ts`. `STEWARD_DB` keeps working; it is what the tests use.

## 3. `stream-idle` — the bug that cost an hour in 0007

`Bun.serve` closes an idle connection after 10 seconds by default, and an SSE response that
has said nothing is idle. So an op fired at a tab that has been quiet lands nowhere until
`EventSource` reconnects. 0007's browser pass spent an hour chasing this as a phantom
drag-and-drop regression; the move was always reaching the server.

Two changes, because either alone is a half-fix:

1. `idleTimeout` on `Bun.serve`. Bun caps this at 255 seconds, so it buys four minutes, not
   forever. **Confirm the cap and the behaviour of `0` before writing a number** — Bun throws on
   an out-of-range value, and a server that refuses to boot is a worse bug than the one being fixed.
2. A heartbeat. `setInterval(() => stream.broadcast('ping', { t: … }), 20_000)` with `.unref()`
   so it never holds the process open. `EventSource` only dispatches listeners for event names
   the client registered, so an unhandled `ping` is inert on the browser side.

The heartbeat belongs in STEWARD, not in `@tjakoen/batch`'s `createStream`. Batch's hub is
deliberately transport-only and holds no timers; adding one there is a publish cycle and an
opinion imposed on every consumer, to fix a problem STEWARD can fix in three lines at its own
composition root.

This matters more after packaging than before: a desktop app sits open and idle all day. It is
the normal case, not the edge one.

## 4. `manifest-truth` — a manifest that describes a screen that no longer exists

`server.ts:653` advertises one target on every screen:

```ts
{ id: surface('reflection'), kind: 'reflection', accepts: actionsForKind('reflection') }
```

No page has rendered a reflection surface since 0008. `app/ai/reasoner.ts:49-56` still emits a
`log` op at it for `demo.run`, and that op streams to nothing.

The manifest is GRAIN's contract with a reasoner — "here is what is addressable on this screen".
A manifest that lists an address nothing occupies is not harmless in the way a dead CSS rule is
harmless: it is an instruction manual that tells the AI to write somewhere the write is thrown
away, and the failure is silent at both ends.

The fix is to advertise what the screen actually renders. `/ai/manifest` already takes `?screen=`
and ignores it. STEWARD's real surfaces are the `data-surface` nodes in the markup
(`client-list`, `client-detail`, `customer-list`, `customer-detail`, `ticket-detail`,
`document-list`) plus whatever the chat panel renders. Two honest options, and the choice is
made by reading `steward-chat.js` rather than by preference:

- If the chat panel renders a `chat-log` surface, the manifest advertises it, and `demo.run`'s
  op retargets there — a visible round-trip instead of a silent one.
- If it does not, the manifest returns an **empty** target list for that screen, and `demo.run`
  stops emitting an op it cannot deliver. An empty list is a true statement. A populated one that
  is wrong is not.

Either way `reflection` leaves the file. Fold a small assertion into the existing tests so the
manifest cannot re-acquire a target with no corresponding surface.

## 5. `chrome-windows` — the PDF driver has never seen Windows

`app/pdf/print.ts:9-18` lists a macOS Chrome, a macOS Chromium and four Linux paths. On Windows
`resolveChrome()` returns `null` and PDF generation is simply unavailable.

Add, in order:

```
%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
%ProgramFiles%\Google\Chrome\Application\chrome.exe
%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
```

Edge earns its place by being present on every Windows install and speaking the same DevTools
protocol — it is the difference between "PDFs work" and "PDFs work if the operator installed
Chrome". `CHROME_PATH` still wins over all of it.

The existing design already degrades correctly (`resolveChrome()` is exported precisely so callers
can skip when there is no browser), so the work is the candidate list plus one check that the spawn
arguments carry no POSIX assumption.

## 6. `compile` — the build

`scripts/build.ts` drives, per target:

```
bun build --compile --minify --sourcemap \
  --target=bun-windows-x64 \
  --define STEWARD_PACKAGED=true \
  --define STEWARD_VERSION='"0.2.0"' \
  --define STEWARD_GOOGLE_CLIENT_ID='"…"' \
  --define STEWARD_GOOGLE_CLIENT_SECRET='"…"' \
  --define STEWARD_GOOGLE_PROJECT_NUMBER='"…"' \
  server.ts --outfile dist/steward-windows-x64.exe
```

Targets: `bun-windows-x64` (the point of the plan), `bun-darwin-arm64` (the only one testable
here — see `verify`), `bun-linux-x64`.

**The client id and secret are baked in, deliberately.** `config.ts:46-49` already argues it:
an installed-app client secret is not truly secret, Google says so in as many words, and PKCE is
what actually protects the exchange. The alternative — requiring a hand-placed `.env` — means a
freshly downloaded exe has no Drive until someone edits a file, which is not a shipped product.
Runtime env still overrides, so a different registration needs no rebuild. Empty defaults, so a
build with no secrets configured produces a working binary with Drive switched off rather than a
broken one.

`STEWARD_VERSION` is read from `package.json` at build time and is what `update` compares against.
A binary that cannot state its own version cannot update itself.

The `--define`d names need declaring (`types/build-constants.d.ts`) or `tsc --noEmit` breaks, and
`tsc` staying clean is a standing gate here.

`--windows-hide-console` and `--windows-icon` exist and are not used in this pass: the console is
the only feedback a first run has, and hiding it before the update path is proven is how a failed
launch becomes invisible. Note them for a later polish task rather than smuggling them in now.

## 7. `first-run` — a double-click on a machine that has nothing

- **Port.** Try `config.port`, and on `EADDRINUSE` bind `0` and take what the OS gives. The OAuth
  redirect already resolves lazily from `server.port` (`server.ts:60-65, 1157`) — that decision was
  made for exactly this and needs no change.
- **Second launch.** If the preferred port is busy, probe it for a STEWARD marker before falling back:
  a new `/healthz` returning name and version. If STEWARD answers, open the browser at the running
  instance and exit 0. Two icons in the taskbar and two servers on two ports is the wrong answer to
  a double-click.
- **Browser.** `start` via `cmd /c` on Windows, `open` on macOS, `xdg-open` on Linux. Suppressible
  with `--no-open` for a headless run.
- **Missing dependencies are stated, not hidden.** No Ollama daemon → the chat panel says the model
  is not running, and everything else works. No Chrome or Edge → PDF actions say so. Neither is an
  error at boot; both are already isolated behind their own modules.

## 8. `update` — replacing a running binary

The human chose **public releases**, so the check is an unauthenticated
`GET /repos/tjakoen/steward/releases/latest`. No token ships in the artifact, which is the whole
reason to prefer it.

`app/update.ts`:

1. Compare `tag_name` (`v0.3.0`) to `STEWARD_VERSION` by semver. Ignore anything not newer.
2. Download the asset matching this build's target name, plus `SHA256SUMS` from the same release.
3. **Verify** with `Bun.CryptoHasher('sha256')` against the sums file. A binary that overwrites
   itself with unverified bytes off the network is a self-updating remote-code-execution hole, and
   this one is not optional.
4. Swap. Windows will not let a running exe be deleted, but it will let it be **renamed**: move
   `steward.exe` → `steward.old.exe`, write the new bytes to `steward.exe`, spawn it, exit. Delete
   `steward.old.exe` on the next boot, ignoring failure.
5. On any failure at any step, leave the running binary untouched and report it. Never half-swap.

**The download and the swap are user-initiated, not automatic.** A Settings card shows the current
version, checks on demand (and once at boot, quietly), and applies only on a click. An application
that silently replaces its own executable is an outward-facing, hard-to-reverse action taken on the
operator's machine without asking — the consent belongs at the moment of the swap, not buried in an
install.

## 9. `history-audit` — before anything becomes public

The repo is private today. Making it public is effectively irreversible: history, branches and
every blob become fetchable and stay cached by third parties whatever is deleted afterwards.

So, before the human flips it, and this is a blocker not a nicety:

- `.env` — confirm it is ignored **and was never committed**, over the whole history, not just HEAD.
- `data/*.db` — the working databases sit in the tree. Confirm nothing real was ever committed.
- `_private/reference/` — confirm what is in it and whether it is meant to be public.
- Any `GOOGLE_CLIENT_SECRET`, `GOOGLE_API_KEY` or token literal in any commit.

`git log -p -S<needle>` over each, plus a full-history filename sweep. If anything is found, the
answer is a rewritten history *or* a fresh public repo for releases only — not "delete it in a new
commit", which achieves nothing.

**I do not flip the repo's visibility.** The audit produces a report; the click is the human's.

## 10. `release-ci`

`.github/workflows/release.yml`, on `v*` tags: set up Bun, build the three targets, emit
`SHA256SUMS`, create the release with all four files attached. The Google constants come from
repository secrets via `--define`, so the values live in one place and never enter the tree.

Version stays in `package.json` and the tag must match it; CI fails the build when they disagree,
because a binary reporting a version that no release carries makes the update check permanently
wrong in a way nobody notices until an update is actually needed.

## How this is verified

**What this Mac can actually prove**, and what the browser pass must cover:

- `bun test` (84 today, plus the new drift guard) and `tsc --noEmit` green.
- `dist/steward-darwin-arm64` boots from `/tmp` — outside the repo, so a stray disk read fails loudly
  rather than being satisfied by the source tree sitting next to it.
- All nine routes 200 from the binary: `/`, `/clients`, `/customers`, `/tickets`, `/files`,
  `/activity`, `/settings`, `/help`, `/plans` (`/plans` 404s from the binary, by design — that is
  the pass, not a failure).
- `curl /components.css` from the binary `diff`s clean against the dev server's. Fonts, `/scripts/*.js`
  and `/app/steward.css` all 200 with the right content type.
- The full 0007/0008 browser gate re-run **against the binary**, at 1440px and 700px, light and dark:
  drawer opens on "+ New" focusing the first field, Tab wraps, Escape closes, focus returns; a row click
  loads its panel; the filter hides rows with its honest count; the kanban drag posts and the card moves
  over SSE. `tsc` cannot see markup — this is still the real gate.
- **The idle bug, measured:** open a page, leave it 60 seconds, fire an op, and see it land. Before the
  fix this fails at 10s. A test that does not sit through the timeout is not testing the bug.
- The data directory: delete it, boot, confirm a fresh db and no crash; boot again, confirm the data is
  still there.

**What it cannot prove.** There is no Windows machine (confirmed with the human). The Windows binary
compiles to a valid PE32+ and nothing more is known. Unverified until someone runs it: `bun:sqlite`
under a cross-compiled Windows build, `%LOCALAPPDATA%` resolution, Chrome/Edge discovery, the
`cmd /c start` browser launch, and — the one with teeth — the rename-swap of a running exe. That last
is the difference between a broken update and an *unbootable* one, so the plan does not close claiming
Windows works. It closes claiming Windows is built and untested, with a short script the human can run
to check it.

## Risks

**The embed manifest is the whole plan, and it fails quietly.** A missed file is a 404 for an asset
nobody notices until a page looks wrong; a wrong bundle order is a cascade change with no error at all.
Hence the byte-identical `diff` and the regeneration test, both of which are cheap and neither of which
is optional.

**94 MB per target, three targets, every release.** That is Bun's runtime, not STEWARD. Worth stating so
nobody reads the number as a regression later.

**Self-update is the most dangerous code here.** It writes an executable and restarts the process.
Checksum verification, never touching the running binary until the new one is fully written and verified,
and no automatic application — those three are what keep it from being the worst bug in the product.

**Going public is a one-way door.** `history-audit` runs first, and the human clicks.

## Housekeeping found while scoping

`plans/0008-ui-audit.md` still carries `status: in-progress` and `narrow: todo` in its frontmatter,
though `narrow` moved to 0007 and was closed there (`f5ef0b3`). PROOF's board reads that frontmatter,
so the board is currently lying about the last plan. Fixed as part of this plan's opening commit.

## Still open from 0006, and still not mine to close

Unchanged as of 2026-08-01: **no file has been picked** through the Drive Picker from a browser signed
in as the connected account, and the **`GOOGLE_API_KEY` is unrestricted** in Cloud Console. The key is
browser-exposed by design, so restricting it to this origin is the only thing standing between it and
anyone reading the page source — and that becomes considerably more pressing the moment binaries are
handed out. Both need the human. Ask; do not re-debug.

## Done 2026-08-01

All eleven tasks. 122 tests green (up from 84), `tsc` clean, three binaries built, and the
darwin one verified serving from `/tmp` with no repo in sight.

### The plan was wrong about one thing, and the binary is what said so

The first build compiled cleanly and died before it bound a port:

```
ENOENT: no such file or directory, scandir 'components'
    at r (node_modules/@tjakoen/batch/render/render.ts:45:21)
```

`render.ts` constructs BATCH's `createRenderer`, which discovers `<b-*>` component
templates with its **own** `readdirSync`. The audit table above lists every directory read
in `server.ts` and missed this one entirely, because it does not happen in `server.ts` — it
happens at import time, one module over, before anything the plan was looking at runs.

The fix is the only one available without changing BATCH: `app/assets/components.ts` writes
the ten embedded templates into the data directory at boot and hands the renderer a
directory that genuinely exists. That is a workaround for a missing injection point, and it
says so in the file rather than pretending otherwise — the honest fix is a `templates`
option on `createRenderer`, which is a publish cycle and belongs to whichever plan next
touches BATCH.

Leaving them out was the tempting alternative and is the trap. An empty registry does not
error; `<b-button>` would pass through to the browser as an unknown element. STEWARD writes
plain markup and uses none of them today, so the binary would have looked perfect — and the
first `<b-*>` tag anyone added would have worked in dev and silently rendered nothing in the
shipped app. That is the exact divergence this plan exists to prevent, so they travel.

### What the binary proved

Run as `/tmp/steward-run/steward`, `STEWARD_DATA` elsewhere, nothing of the repo nearby:

- Nine routes 200. `/plans` 404s — by design; a binary carries no development board.
- **`/components.css` is byte-for-byte identical to the dev server's**, 138,028 bytes. The
  cascade-order trap was real and the recorded order is what closes it. The test now asserts
  this against `createStyleBundle` itself, so it cannot rot.
- Fonts, scripts, sprite, PROOF's and CRUMB's four named assets: all 200, right content
  types. Computed `font-family` is Redaction, so `/fonts` genuinely resolved.
- The five-region grid computes GRAIN's areas with the rail in `rail` and aside at 0 —
  identical to the checkout, which is the whole claim.
- Drawer: opens on "+ New", focus lands on the form's first field, nine siblings `inert`,
  Escape closes, focus returns to the opener. The row filter hides rows and restores them.
- Kanban: a real drag posts `ticket.status` and the card moves into the new column over SSE.

### The idle bug, measured rather than reasoned about

An `EventSource` left open and silent for **62 seconds**, then an op fired at it: three
`ping` frames arrived on schedule and the op landed on the same connection. Before this it
was dead at ten.

`idleTimeout: 255` is Bun's ceiling — 256 throws, checked — so it alone would only move the
cliff to four minutes. The heartbeat is what actually fixes it, and it lives in STEWARD
rather than in BATCH's `createStream`, which is deliberately transport-only and holds no
timers.

### Launch, both paths, from the real binary

- Same port, another STEWARD already there → `STEWARD 0.2.0 is already running`, browser
  opened at the running instance, exit 0. Two icons and two databases is the wrong answer to
  a second double-click.
- Same port, something else there → `[launch] port 3299 is taken; taking one from the OS`,
  bound 59923. The OAuth redirect already derives from the port actually bound (0006's
  decision), so nothing needed registering.

### `history-audit`: clean, and the click is still the human's

Every path that has ever existed in the history, filtered for `.env`/`.db`/`_private`/key
material: **`.env.example` and nothing else**. `-S` searches for `AIza`, `GOCSPX`, `ya29.`,
`ghp_` and `BEGIN PRIVATE KEY` return zero commits. The `GOOGLE_CLIENT_SECRET` hits are the
variable NAME in `config.ts` and an empty `GOOGLE_CLIENT_SECRET=` in the template. The only
high-entropy literals ever added are `sha512-` lockfile integrity hashes.

So there is no reason found here not to make the repo public — and making it public is still
not mine to do. `.github/workflows/release.yml` is written and will work the moment a `v*`
tag is pushed; unauthenticated update checks need the releases public, which is one setting
on GitHub.

### What is built and NOT verified

There is no Windows machine. `dist/steward-windows-x64.exe` is 94.7 MB of valid PE32+ and
that is the entire extent of what is known about it. Unverified until someone runs it:
`bun:sqlite` under a cross-compiled Windows build, `%LOCALAPPDATA%` resolution, Chrome/Edge
discovery, `cmd /c start` (the empty title argument has a test naming it, but a test is not
a Windows box), and — the one with teeth — renaming a running `.exe` out of the way. This
plan does not close claiming Windows works. It closes claiming Windows is built and untested.

To check it, on a Windows machine:

```
steward-windows-x64.exe --no-open
curl http://localhost:3000/healthz
curl -s http://localhost:3000/components.css | wc -c     # expect 138028
```

Then open it, click through the nine routes, and confirm `%LOCALAPPDATA%\STEWARD` holds a
`steward.db`.

### The 700px pass, and why it is not claimed

The browser extension times out on `evaluate` for any headless session narrower than its
default, on three separate attempts. Constraining `document.body` to 700px drives GRAIN's
CSS container query correctly (areas collapse to the mobile single column, main takes the
full 700), but **not** `shell.js`, which keys its rail state off
`window.matchMedia("(max-width: 768px)")` — so the rail measured as an on-canvas overlay,
which is an artifact of the measurement, not a defect.

0007 verified 700px at a real window and this plan changed no shell CSS, no markup and no
script. What 0009 had to prove is that the embedded assets compute identically to the source
tree, and the byte-identical bundle plus the identical wide-layout computed values do that.
Light and dark were both confirmed through GRAIN's own island (`grain.theme.setScheme`),
which is also how the first attempt was caught setting the wrong attribute by hand.

### Smaller things worth recording

- **`import.meta.resolve` throws in a binary**, it does not return a wrong answer:
  `Cannot find module '@tjakoen/grain/PLAN.md' from '/$bunfs/root/…'`. `config.ts` runs that
  at import time, so unguarded it takes the app down before `main`. Packaged, `GRAIN` is the
  empty string — an obviously wrong path that fails loudly if used, rather than a plausible
  one that reads the wrong file.
- **`--define` targets `process.env.X` rather than a bare global.** Verified: substituted in
  the build, an ordinary undefined property in dev, no `ReferenceError`, no shim, no `.d.ts`.
  A real environment variable cannot override a baked one, which is right for `PACKAGED`.
- **`build/assets.gen.ts` carries `@ts-nocheck`.** `with { type: 'file' }` makes an import
  evaluate to a path; TypeScript has no representation for that and resolves `./x.js` as a
  real module, then objects that a browser script has no types and no default export. Both
  complaints are about imports the file never dereferences. The three exports are explicitly
  annotated, so every consumer stays fully typechecked.
- **`readFileSync` works on `/$bunfs` paths.** Checked, and it is what lets the component
  materialisation be synchronous — `createRenderer` is constructed at import time.
- **`--compile` writes `server.js.map` into the output directory whatever `--sourcemap` is
  set to**, `inline` included. `dist/` is what CI uploads, so the build deletes it.
- **`.gitignore` ignored `build/`**, which would have silently excluded the checked-in
  manifest. Negated for the two files that are source.
- **`app/pdf/print.ts` now passes `--user-data-dir`.** Not only hygiene: on Windows,
  launching `chrome.exe` while Chrome is already running hands the command line to the
  existing instance and exits, so there is no "DevTools listening" line and the launch times
  out for no visible reason.
- **0008's frontmatter said `in-progress` with `narrow: todo`** long after `narrow` moved to
  0007 and closed there. PROOF's board reads that frontmatter, so the board was misreporting
  the previous plan. Fixed.

## Next after this

0010-sheets-sync. Two things this plan deliberately left: a `templates` option on BATCH's
`createRenderer` (which retires `app/assets/components.ts`), and `--windows-hide-console`
plus `--windows-icon`, which should not be turned on until a failed launch has some other
way of being visible.
