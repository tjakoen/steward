# CLAUDE.md: STEWARD

Front door for anyone, human or AI, opening this repo cold. Read it once, then go where it points.
Keep it accurate: if you change how this project works, its layout, its commands or one of its rules,
update this file in the same change. A stale front door misleads every session after you.

## What this is

An AI-first admin cockpit: a task-ticket CRM with branded document generation, built on the
[BREAD stack](https://tjakoen.github.io) (no build step, Bun, server-rendered hypermedia). Clients,
customers and tickets in one place, and every ticket renders to a branded PDF. It ships as a single
downloaded file that runs on the user's own machine. There is no server to rent, no account to make,
and the data stays in one folder they can copy.

The thing to understand before touching anything: **every surface is operable by a human and by an AI
through one shared door.** A `POST /intent` returns render operations over SSE. A feature only a
human can reach is not finished, and neither is one only an agent can reach.

The second thing: **this repository and its releases are public, and the data STEWARD handles is
not.** That shapes more decisions here than the stack does.

## Start here (reading order)

1. `README.md`: what STEWARD is, how it installs, what an operator has to do to run it. Read the
   Google section even if you are not touching Google. It explains why a released binary carries no
   credentials, which is the constraint behind several designs that otherwise look strange.
2. `plans/`: nineteen numbered plan files, the build order and the reasoning. These are not a
   backlog. They carry the argument for each decision and, in the later ones, what was measured
   afterwards. `plans/BACKLOG.md` is what was asked for and what it actually costs.
3. `app/domain/types.ts`: the whole domain in one file. Client, Customer, Ticket, DocumentRef,
   AuditEntry. Read this before any repository or view code; everything else is a projection of it.
4. `app/repo/ports.ts` then `app/repo/sqlite.ts`: the persistence contract, then the one
   implementation of it. SQLite is the source of truth and every mutation appends an audit row.
5. `app/actions/steward.ts`: the intent door. What an agent can ask for, and therefore what a human
   surface must also be able to do.
6. `frontend/`: the client half. `frontend/components/` are STEWARD's own; GRAIN's come first in the
   resolution order (`config.ts`, `componentRoots`).

The cross-repo standards this repo is held to are published at
<https://tjakoen.github.io/standards> and are referenced here, never forked into this tree. Two
copies of a standard drift, and then both are suspect. The ones that matter most here:
[AI-DEVELOPMENT](https://tjakoen.github.io/standards/ai-development) for how the human and the AI
work together, [LOOP](https://tjakoen.github.io/standards/loop) for the gates between sessions,
[SESSION-LOOP](https://tjakoen.github.io/standards/session-loop) for the inside of one, and
[VOICE](https://tjakoen.github.io/standards/voice) for any prose written in Tjakoen's name, which
includes the README and every string an operator reads.

## Commands

```
bun run dev        # bun --hot server.ts, opens http://127.0.0.1:3000
bun run start      # bun server.ts
bun run check      # tsc --noEmit          (gate)
bun test           # the test suite        (gate)
bun run seed:demo  # DEMO=1 bun run app/seed/demo.ts
bun run build      # bun scripts/build.ts, compiles the binaries into dist/
```

`bun run check` and `bun test` are the gate. Both, not one of them.

## The five non-negotiables

- **Definition of done is code, tests, docs synced, and a green gate.** "It compiles" is not done,
  and neither is "the test I wrote for it passes".
- **Evidence or it did not happen.** A run closes with a report in `artifacts/runs/`, gate output
  pasted verbatim rather than summarized, and a named list of what was not done and what needs human
  eyes. The README in that directory has the shape.
- **Both doors, every time.** A surface a human can operate owes the same operation through
  `POST /intent`, and the reverse. This is the product's whole claim; a change that quietly serves
  one door breaks it.
- **This repo is public, and the data it handles is not.** `_private/`, `data/`, every database file
  and every secret are gitignored, and `.gitignore` carries the reasoning for the non-obvious rules.
  Never commit a customer record, a real document, or a filled `.env`. No credential is ever compiled
  into a binary. Read the ignore file before adding a path that looks like data.
- **A change a person can see owes more than a description.** Anything that renders closes with a
  screenshot or a dev tour, one step per changed surface, each with a verify line the reviewer can
  actually execute.

## Sync table: change X, also update Y

| You change | Also update |
|---|---|
| A type in `app/domain/types.ts` | the matching interface in `app/repo/ports.ts`, its implementation in `app/repo/sqlite.ts`, the migration if the stored shape moved, the view that renders it, and the test for each |
| The database schema or a migration | `app/repo/migrate.test.ts`, archive and restore behaviour if the entity is archivable (`app/repo/archive.test.ts`), and the Sheets mirror's pullable columns if the column is one of them (plan 0011) |
| An intent action in `app/actions/steward.ts` | the human surface that performs the same operation, and the reverse. Both doors is a non-negotiable, not an aspiration |
| A GRAIN surface address | the `data-surface` attribute in the markup, the entry in `app/ai/surfaces.ts`, and what `/ai/manifest` advertises. Three places, one contract, and getting them out of step fails silently |
| A configuration key | `config.ts`, the `steward.env` block in `README.md`, and the Settings page if an operator sets it |
| Anything an operator sees or does | `README.md` in the same change. It is the only manual a downloaded binary has |
| A layer pin (`@tjakoen/*`) | run the gate. New design work belongs upstream in that package, never patched around here |
| A plan's state | its `status` in the plan file, in the same edit as the work. A finished plan stays in `plans/` |

## Hard-won lessons

Root causes, not incidents. Each one cost real time and each will recur if the reasoning is lost.

- **A surface address is a contract across three places**: the markup that renders `data-surface`,
  the manifest that advertises it, and the reasoner that emits operations at it. Out of step, nothing
  errors. The operation is dispatched at a selector that finds nothing and is dropped. Plan 0008 left
  exactly that behind, which is why the names live in one file with a test behind them rather than as
  string literals in three (`app/ai/surfaces.ts:1-9`).
- **Prefer a literal address to a name.** Windows resolves `localhost` to IPv6 before IPv4, and
  `Bun.serve` here binds IPv4 only, so nothing listens on the address the browser tries first.
  Usually that refuses instantly and falls back; when something drops the packets instead of refusing
  them, there is nothing to fall back from and the tab hangs forever. It was invisible on macOS and
  intermittent on Windows. Every URL STEWARD emits is now a literal loopback address, which also
  closed a same-origin split that had existed on every platform since plan 0006
  (`plans/0018-windows-first-contact.md:39-63`).
- **Every network call carries a deadline.** No fetch in `app/google/` had a timeout, and the
  settings page awaits a call that can trigger a token refresh, so an unreachable Google blocked that
  page forever with no error and no fallback. Adding a deadline then exposed a second problem: a
  function documented as returning null on failure actually threw, which turned the one page whose
  job is to explain what is wrong into a 500. A contract that is only true on the happy path is not a
  contract (`plans/0018-windows-first-contact.md:64-80`).
- **A public binary carries no credential.** Anything compiled into a download can be read straight
  back out of it. The operator pastes their own, they are stored on their machine only, never
  displayed back, and excluded from bug reports. A whole class of release bug disappeared with them
  (plan 0017).
- **A restriction that cannot match is worse than none.** An HTTP-referrer restriction on the Picker
  API key can never work, because the Picker's own request carries an empty referrer, and the symptom
  is a message about an invalid key with nothing on screen to suggest the real cause. Documented in
  the README rather than left for the next person to rediscover.
- **An ignored directory is never descended into**, so a `!` negation under it does nothing at all
  and the file it names is silently never committed. This bit twice, at `build/` and at
  `nimbalyst-local/`, and both are now written as `dir/*` with the reasoning inline in `.gitignore`.
- **Copying a running SQLite database loses its most recent writes.** They live in a `-wal` file
  beside it. Use `VACUUM INTO`, not `cp`, and say so anywhere a backup is described.

## Ask the graph before grepping

There is no `graphify-out/` in this repo yet. Build it with `graphify update .` and it is gitignored
per-machine, generated, and costs no API calls to refresh.

Once it exists, run `graphify query "<question>"` before a wide grep for any question about where
something is defined, what calls it, or how two things connect. Use `graphify path "<A>" "<B>"` for
relationships and `graphify explain "<concept>"` for a focused subgraph. Seed the query with a symbol
the code actually contains: a partial name returns a bare "No matching nodes found" and reads like a
broken tool. Grep freely for text and filenames, which is what it is good at.

## Layer pins

This app consumes the BREAD stack rather than forking it: `@tjakoen/batch`, `@tjakoen/crumb`,
`@tjakoen/grain`, `@tjakoen/mill` and `@tjakoen/proof`. New design work belongs upstream in those
packages, not here. Plan 0007 is the worked example: the shell, the data table and the drawer were
built here and then pushed up. When a pin falls behind, bump it rather than patching around it.

## Commit convention

No AI attribution trailers on commits. The receipt behind the "built with Claude" claim is the
README badge and footer, not commit metadata. Check with
`git log -E --grep="^Co-Authored-By:" --oneline` before trusting a branch is clean, and anchor the
pattern to the line start or this paragraph matches itself.

## Keeping this file honest

This is the front door. A cold read should take a couple of minutes and no longer. The sync table and
the lessons earn their place because they are the two things a session cannot reconstruct from the
code, and both are load-bearing rather than decorative: a row that no longer describes a real change
kind should be deleted, and a lesson whose cause has been designed away should go with it. Everything
else that grows past a paragraph belongs in `plans/` or in the README, with a pointer left behind.
When a rule here stops being true, the session that finds out fixes it, in the same commit as the
work that revealed it.
