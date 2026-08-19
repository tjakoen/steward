---
title: The deep pass, on the one repo that had nothing to muddy the before-and-after
date: 2026-08-19
status: complete
lane: gated
branch: main
skills:
  - conformance
  - kickstart
  - claude-starter
  - ai-repo-standard
  - loop-standard
  - graph
  - voice
scope:
  - CLAUDE.md
  - AGENTS.md
  - pantry.config.json
  - artifacts/runs/
scopeGrowth: none. Every path this run wrote is in the list above, and git status agrees.
  No product source, no plan file, no README and nothing under .github/ was touched.
touched:
  - CLAUDE.md
  - AGENTS.md
  - pantry.config.json
  - artifacts/runs/README.md
  - artifacts/runs/2026-08-19-loop-rollout.md
plans: []
gates:
  - "bun run check | pass, exit 0, tsc --noEmit clean"
  - "bun test | pass, exit 0, 401 pass, 0 fail, 1295 expect() calls across 35 files"
  - "published-standards link check | pass, 6 URLs, all 200 following redirects"
diffstat: 4 files added, 1 symlink added. No product source touched.
unpushed: 0 | nothing this run produced has been committed, so there is nothing of it to push.
  The working tree carries the change, which is where the envelope said to leave it.
doctor: 21 checks, 2 FAILING and 2 due at the start; 21 checks, 0 failing, 2 due at the close.
  The two carried are the e2e row and the unmounted skills, both named below with a reason.
verifiedBy: nobody yet. This is the author's own account. Two claims in it were checked by an
  independent method rather than by reading: the six standards links were resolved with curl and
  their status codes are below, and the session-start hook was executed against this directory
  rather than reasoned about.
---

## Why this repo, and not the busiest one

The rollout brief said to go deepest in ph-live, on the argument that 165 sessions make it the
honest test. The owner changed it mid-run to this repo, and the reasoning is better: ph-live already
carried a pantry.config.json, so any claim about what the loop changed there is measured against a
partly-wired starting point. This repo had **nothing**. No front door, no config, no symlink, no
ledger, and two failing doctor checks, which no other repo in the estate had. It is the only clean
before-and-after available.

ph-live keeps the pass it already got. It was not unwound.

## What it had, precisely

```
[FAIL] CLAUDE.md present: missing — the cold-start front door (LOOP.md §3)
[FAIL] AGENTS.md symlink: missing — add AGENTS.md as a symlink to CLAUDE.md
[warn] pantry.config present: none — run pantry init (defaults still apply)
[info] run ledger: no run reports yet
21 checks, 2 failing, 2 due
FAIL
```

It was not unkitted for want of anything to point at. It consumes five layers of the stack, all pins
current, and carries nineteen numbered plan files whose later entries are among the best written
records in this estate. The wiring was the only missing part, and the absence was total: because the
machine-level session-start hook exits early when a repo has neither a CLAUDE.md nor a
pantry.config.json, a session opening this repo saw **nothing at all** at startup. Not a report,
not even the message saying a report could not be produced.

That is measurably different now, and still not fixed:

```
$ CLAUDE_PROJECT_DIR=<this repo> bash ~/.claude/tools/session-doctor.sh
doctor NOT RUN at session start: PANTRY is not resolvable from …/admin-interface.
```

The repo now gets past the hook's guard and is told the checker cannot run, which is worse-sounding
and strictly better: an honest not-run beats silence. Fixing the resolution itself is one line in a
file outside this envelope and is the open question this rollout ends on.

## What the deep pass added beyond the other seven repos

The other repos got a landing place, a config where missing, and an evidence rule. This one got the
full kit shape from AI-REPO-STANDARD, which is three things the others did not:

**A sync table.** Eight rows, each describing a change-kind this repo actually has today rather than
a copied-in template. The load-bearing row is the GRAIN surface address, because that one is a
contract across three separate places and going out of step fails silently rather than erroring.
A copied or empty sync table is worse than none: it reads as covered.

**A hard-won lessons section.** Seven root causes, not incidents, each carrying a file or plan
citation: the three-place surface contract (app/ai/surfaces.ts:1-9), preferring a literal loopback
address to a name (plans/0018-windows-first-contact.md:39-63), every network call carrying a
deadline and the untrue contract that adding one exposed
(plans/0018-windows-first-contact.md:64-80), a public binary carrying no credential (plan 0017),
a restriction that cannot match being worse than none, the ignored-directory negation trap that bit
twice in .gitignore, and copying a running SQLite database losing its write-ahead log. Every one of
these was already written down somewhere in the repo. None of them was anywhere a cold session would
find in its first minute.

**The query-first graph rule.** There is no graph here yet, so the section says how to build one and
what to ask it, rather than pretending one exists.

The front door still reads in a couple of minutes and the cold-start budget agrees: 13,445 characters
across four files against a budget of 20,000, where before this run it was 2,245 across three and the
repo had no front door at all.

## Gate output, verbatim

```
$ tsc --noEmit
CHECK_EXIT=0
```

```
 401 pass
 0 fail
 1295 expect() calls
Ran 401 tests across 35 files. [3.33s]
TEST_EXIT=0
```

```
200 https://tjakoen.github.io/notes/ten-times-zero
200 https://tjakoen.github.io/standards
200 https://tjakoen.github.io/standards/ai-development
200 https://tjakoen.github.io/standards/loop
200 https://tjakoen.github.io/standards/session-loop
200 https://tjakoen.github.io/standards/voice
```

Both gates green, on the first attempt, which was not true of every repo in this rollout. The link
check followed redirects, because GitHub Pages answers 301 before 200 and an eyeballed link reads as
healthy either way.

## The conformance pass, C1 to C8

Every row, including the clean ones, because a check nobody reports on came back clean for the wrong
reason.

| check | status | evidence |
|---|---|---|
| C1 front door | **clean, as of this run** | CLAUDE.md, 161 lines. What-this-is, reading order, commands, five non-negotiables, sync table, lessons, self-maintenance line. Cold-start budget inside at 13,445 of 20,000. It did not exist before this run |
| C2 sync table | **clean, as of this run** | eight rows, each a change-kind the repo has today. Verified against app/domain/types.ts, app/repo/ports.ts, app/actions/steward.ts, app/ai/surfaces.ts, config.ts:37 |
| C3 hard-won lessons | **clean, as of this run** | seven root causes with citations. Sourced from the repo's own plans and .gitignore, not invented |
| C4 links resolve | **clean** | 6 URLs, all 200 following redirects. Output above |
| C5 audit runbook | **finding, minor** | no AUDIT.md. This repo is large enough to owe one: 19 plans, a public release surface, credential handling and a database. Writing it was outside the envelope's file list, so it is filed rather than drafted |
| C6 loop automated, not remembered | **finding, major** | see the breakdown below |
| C7 graphify in the default plan | **partial** | (a) query-first rule now stated in CLAUDE.md; (b) no freshness hook, and this repo has no .claude/settings.json at all; (c) no graphify-out/ exists yet, so nothing is committed by accident; (d) the session-start routine now tells a session to ask the graph. Two of four |
| C8 PANTRY as reporting surface | **clean, as of this run** | artifacts/runs/ exists with a README and this report. pantry.config.json sets previewTarget to the port read from config.ts, not guessed. The owner reads updates here, so it applies |

### C6 in detail, one line per rung

| rung | wired by | honest rung |
|---|---|---|
| doctor at session start | ~/.claude/tools/session-doctor.sh, machine-level | **installed but non-functional here.** It cannot resolve PANTRY from this directory. Rung 1 in practice |
| gate on turn end | ~/.claude/tools/review-gate.sh and session-guard.sh, machine-level | rung 3, and it fires |
| CI on push | **nothing.** .github/workflows/release.yml:80-81 runs bun run check and bun test, but the workflow triggers on a release tag, not on a push to main | rung 2. The gate exists and runs late |
| graph freshness on edit | remembered only. The portfolio wires this as a PostToolUse hook; this repo has no .claude/settings.json, and .gitignore ignores .claude/ entirely, so a per-repo hook here would not be shared anyway | rung 1 |
| lint and typecheck as scripts | package.json: check and test | rung 3 |
| human lane guarded | ~/.claude/tools/human-lane.sh, a PreToolUse deny, machine-level | rung 3 |

The pattern worth naming: this repo's local wiring is thin, but four of the six rungs are carried by
machine-level hooks that already apply to every repo on this machine. So the thing worth fixing is
not per-repo hook files at all. It is the one resolution line, plus the CI-on-push gap.

## What was not done

- Nothing was committed and nothing was pushed.
- No product source, no plan file, no README and nothing under .github/ was touched. git status
  shows four new paths and one symlink, and nothing modified.
- No AUDIT.md was written. Filed as C5.
- The README badge row and footer were not audited against the README standard. That is a separate
  pass with its own standard, and folding it in would have widened the diff past the envelope.
- No CI-on-push workflow was added. That is a .github/ change and outside the file list.
- graphify update . was not run, so there is still no graph here. The rule is stated, the graph is
  not built, and the report says which.
- The standards were not mounted as skills. This is the one repo where it would be safe today,
  because .gitignore already ignores .claude/ entirely. It was still not done, because the same
  call was declined in three other repos for a real reason and doing it here alone would leave the
  estate inconsistent in a way no later reader could reconstruct. Named as a decision, not an
  oversight.
- The e2e row is carried rather than fixed. There is no end-to-end suite in this repo; unlike ph-live,
  that is a true negative rather than a checker defect.

## What needs human eyes

Three, in order of what they cost if ignored.

**The PANTRY resolution line.** Everything above is a file nobody is prompted to read until the
session-start hook can find the checker from a repo outside bread-repos/. One elif.

**CI on push.** The gate exists and is good. It runs when a release is tagged, which is the last
moment it can usefully fail. Moving bun run check and bun test onto push to main is a small
workflow change and it belongs to whoever owns .github/ here, not to a kit rollout.

**Whether this repo owes an AUDIT.md.** It is public, it handles credentials and customer data, and
it ships binaries people download. The argument for one is strong; the argument against is that
nineteen plan files already carry most of what a runbook would say. The owner's call, and it is worth
making explicitly rather than letting the absence stand as an answer.

## Closed later the same day, after the owner widened the envelope

Two things this report filed as open were authorised and done before the run ended, so the text above
is left as written and corrected here rather than edited to look prescient.

**The session-start doctor now runs in this repo.** A fourth resolution rung was added to
~/.claude/tools/session-doctor.sh, last in the order so nothing that already worked changed, and
written as a plain file test so a moved clone degrades to the honest not-run message rather than
failing or hanging. Verified by executing the hook against this directory, not by reading it. It
prints a real report here where it printed a not-run message this morning. That single line is the
root cause of the whole adoption measurement this rollout was briefed on: the loop was not declined
outside bread-repos/, it was unreachable.

**The sixteen standards are mounted as skills here.** No ignore line was needed: this repo already ignores the whole .claude directory, which is what made it the one repo where this was safe from the start. git status is clean of them, checked with
git check-ignore against a real mounted path. One caveat carried forward: the sync reads a pinned
copy of the canon from PANTRY's node_modules rather than the live standards directory, and that copy
is already behind, so what is mounted here is slightly stale. Refreshing the pin is a lockfile change
in PANTRY and was not authorised.
