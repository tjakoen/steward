---
id: 0018-windows-first-contact
title: STEWARD — what a real Windows machine said the first time anyone ran it
status: doing
owner: admin
created: 2026-08-18
milestone: M4 (open source)
tags: [windows, launch, loopback, oauth, resilience, shell]
tasks:
  - id: loopback-origin
    title: One address everywhere — 127.0.0.1, because localhost is an IPv6 lookup on Windows
    status: done
  - id: google-deadlines
    title: A deadline on every call to Google, and a refresh that honours its own contract
    status: done
  - id: app-window
    title: Its own window rather than a browser tab, using the binary PDFs already need
    status: done
  - id: windows-recheck
    title: Run the fixed build on the same machine that raised all three
    status: blocked
---

# STEWARD — what a real Windows machine said (0018)

`0016`'s `windows-check` had been open since 2026-08-04 as the one gap money could not
close: nobody had ever executed `steward-windows-x64.exe`. Somebody finally did, on
2026-08-18, running `v0.4.0` on a machine the operator has physical access to.

**It found three things, and none of them was the thing the checklist was watching for.**
The binary booted, served its assets, kept its database and drew its pages — every item
`windows-check` scripted passed. What went wrong was everything around the edges, which is
the argument for running software on a real machine rather than reasoning about it.

The report, verbatim in substance: *"connect to drive loads forever and sometimes
navigating between tabs loads forever"*, and *"I thought we're turning it into an
executable? it still opens a browser tho"*.

## `loopback-origin` — the hang, and it was never Google

**Measured on the machine, not deduced.** With a tab hung on `localhost`, a second tab at
`http://127.0.0.1:3000/healthz` answered **instantly**. That single observation moves the
fault off the network, off Google, off the credentials work in `0017`, and onto name
resolution.

Windows resolves `localhost` to IPv6 `::1` before IPv4. `Bun.serve` is called here with no
`hostname`, so it binds IPv4 only, and nothing is listening on `::1` at all. The usual
outcome is an instant refusal and an instant fallback, which is why this never showed up on
macOS. When something drops those packets instead of refusing them — Defender, a VPN
adapter, a filtered profile — there is nothing to fall back *from*, and the tab hangs until
the operator gives up. That is also why it was intermittent: it depended on which name the
browser tried first and what happened to that attempt.

**The fix is to stop using a name.** Every URL STEWARD emits or opens is now
`http://127.0.0.1:<port>` — the startup line, the browser it opens, and the second-launch
path that focuses an already-running instance.

**It closes a second bug that had nothing to do with Windows.** Google requires a literal
loopback address in a Desktop client's redirect URI, so the OAuth callback has always
returned to `127.0.0.1` while the app itself was served from `localhost`. Connecting Drive
therefore moved the operator to a **different origin** than the one they started on, on
every platform, since `0006`. One address everywhere ends that too.

## `google-deadlines` — a hung upstream should never hang a page

Found while looking for the cause above; kept because it is real regardless. **No fetch in
`app/google/` had a timeout**, and `GET /settings` awaits `googleAuth.ensureAccount()`,
which can trigger a token refresh over the network. An unreachable Google therefore blocked
that page render forever — no error, no fallback, a spinning tab.

Every call now carries a 10-second `AbortSignal.timeout`: far longer than a healthy refresh,
far shorter than a person's patience.

**That exposed a contract that was already untrue.** `accessToken` documents *"Returns null
when not connected — callers fall back rather than throw"*, but the refresh path threw on
any bad response, and adding a deadline made that reachable on a slow network. A failure
there turned `/settings` — the page whose entire job is to explain what is wrong — into a
500. It now catches, warns to the log, and returns null, which is what every caller already
handles: documents fall back to the local store and the surface says "not connected".

## `app-window` — "it still opens a browser tho"

A fair complaint about a genuine design decision, and the decision is not wrong: STEWARD is
a local server driving the operator's browser, which is why the drawer, the tabs, the
filtering and the PDFs are all plain HTML with no client framework. It *is* a single
double-clickable file with nothing to install. What it was not is a **window**.

**Chrome and Edge both take `--app=<url>`**, which opens a chromeless window: no tabs, no
address bar, its own taskbar entry. It needs no new dependency, because `resolveChrome()`
already locates a binary for PDF rendering — and Edge ships with Windows, so the machine
that raised this satisfied it before the change was written. Where neither exists it falls
back to the default browser exactly as before, which matters because that is also a machine
that cannot render PDFs and STEWARD stays usable there deliberately.

`--user-data-dir` points at `<dataDir>/window`. Without it Chrome hands the URL to an
already-running instance and exits, and no app window ever appears — the most common way
`--app` silently does nothing, and the reason there is a test naming it.

**A native shell was considered and rejected.** Tauri or Electron means a new toolchain,
per-platform builds, a much larger binary and code-signing pressure this project has
deliberately deferred (`0016`: ship unsigned). For a two-user tool, `--app` buys the whole
of the perceived difference at none of that cost.

## Verified 2026-08-18

401 tests (4 new), `tsc` clean. A packaged `0.4.0` built from this tree announces
`STEWARD 0.4.0 → http://127.0.0.1:3218`, answers `/healthz` there, and renders `/settings`
in 4.5 ms with no credentials configured — the page that used to be able to hang.

Two tests are worth their space. `appWindowCommand` asserts `--user-data-dir` is present,
because losing it is a silent failure rather than a loud one. And a rejecting `fetch` proves
`accessToken` returns null and `ensureAccount` does not reject, which is the contract the
timeout made load-bearing.

## What is NOT verified, and it is the point of the plan

**`windows-recheck` is blocked on the same machine.** Everything above was measured on
macOS, and the fault it fixes cannot occur on macOS. The IPv6 explanation fits every
symptom and the `healthz` test confirms the mechanism, but *fixed* is a claim only that
Windows machine can make. `0016`'s `windows-check` stays open until it does — and this time
the script has three specific questions rather than a general look:

1. Does the app open in **its own window**, with no tabs and no address bar?
2. Does **Connect Google Drive** complete, rather than spinning?
3. Does navigating between records ever hang again?
