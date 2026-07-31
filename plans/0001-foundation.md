---
id: 0001-foundation
title: STEWARD — Foundation
status: done
owner: admin
created: 2026-07-31
milestone: M1 (usable admin tool)
tags: [foundation, batch, grain, sqlite, demo, hygiene]
tasks:
  - id: hygiene
    title: Repo hygiene — .gitignore + PII audit
    status: done
  - id: scaffold
    title: Composition root — server.ts wiring BATCH+GRAIN+MILL+PROOF+CRUMB
    status: done
  - id: intent
    title: /intent endpoint + /stream SSE hub (RenderOps)
    status: done
  - id: schema
    title: SQLite schema — Client, Customer, Ticket, Audit
    status: done
  - id: ticketid
    title: Ticket-ID generator (TX + code + seq)
    status: done
  - id: repo-port
    title: ClientRepository/CustomerRepository/TicketRepository ports + bun:sqlite impls
    status: done
  - id: audit
    title: Append-only audit/history on every write
    status: done
  - id: theme
    title: GRAIN theme tokens + header light/dark toggle
    status: done
  - id: demo
    title: Demo mode — fictional seed + reset, separate data/demo.db
    status: done
---

# STEWARD — Foundation (0001)

First plan of the STEWARD build. Stands up the composition root, the data
core, and the shared conventions every later plan builds on. No feature
surfaces beyond a minimal operable proof-of-life.

**Stack:** BREAD (no-build, Bun, `POST /intent` + RenderOps over SSE).
**Storage:** `bun:sqlite` = source of truth. Google Sheet mirror deferred (0008).
**Public repo. No PII. Generic docs. MIT license.**

## Domain vocabulary (generic — no client-specific terms)

- **Client** — a branded organization the platform serves. Owns branding
  (logo, primary/secondary color, company info, PDF footer) stamped on
  generated documents. *Data, never hardcoded.*
- **Customer** — an individual or household belonging to a Client. May be
  joint (2+ persons). This is the entity a Ticket is about.
- **Ticket** — a task ticket about a Customer. Renders to a branded PDF.
- **Audit** — append-only history of every mutation.

## Data model

```
Client   { id, name, code, branding{logo, primaryColor, secondaryColor,
           companyInfo, pdfFooter}, active, createdAt, updatedAt }
Customer { id, clientId→Client, code, persons[{given, family}],
           email, phone, externalId, notes, createdAt, updatedAt }
Ticket   { id, customerId→Customer, ticketId, title, dateInitiated,
           status, dateLastUpdated, waitingOn, waitingSince, summary,
           nextAction, progressLog[{date, update}],
           commRefs[{date, subject}], createdAt, updatedAt }
Audit    { id, entity, entityId, action, actor, at, diff }   // append-only
```

- **Ticket-ID:** `TX` + first-4 of primary family name (uppercased) +
  4-digit zero-padded sequence per Customer. e.g. `TXDOEX0001`.
- **Status set:** `Not Commenced` · `In Progress` · `Waiting` · `Completed`
  (these become Kanban columns in plan 0003).

## Architecture conventions

- **BATCH is a library.** `server.ts` is the composition root that owns
  `/intent`, `/stream`, and swaps repository impls in one line.
- **Ports, not hardwired storage.** Services depend on repository interfaces;
  `bun:sqlite` impls injected at the root. (Skip BATCH's Postgres-dialect
  SqlClient — direct sqlite repo is simpler.)
- **Services own verbs** (create/update/archive/generate); routes are thin.
- **Every mutation writes an Audit row** in the same service call.
- **Component-per-folder** (`frontend/components/<level>/<name>/`),
  pages mirror URLs.

## File layout (target)

```
steward/
├─ server.ts              composition root: layers, /intent, /stream
├─ config.ts              component + page roots
├─ tsconfig.json          allowImportingTsExtensions: true
├─ pantry.config.json     (bunx pantry init)
├─ .gitignore            _private/ *.docx data/*.db* secrets/ .env* *.local.*
├─ LICENSE               MIT
├─ app/
│  ├─ domain/            Client, Customer, Ticket, Audit types
│  ├─ actions.ts         ActionName union → service map (the /intent verbs)
│  ├─ services/          client-, customer-, ticket-, audit-service.ts
│  ├─ repo/              *-repository.ts (ports) + sqlite-*.ts (impls)
│  ├─ ids.ts             ticket-id generator
│  └─ seed/demo.ts       fictional demo dataset (committed, no PII)
├─ frontend/
│  ├─ components/{atoms,molecules,organisms}/…
│  ├─ pages/             home, settings (proof-of-life this plan)
│  └─ styles/            design tokens (light/dark)
├─ content/              MILL: help/*.md, changelog.md (later)
├─ tours/                CRUMB steps (later)
├─ plans/                PROOF plans (this dir)
└─ shell/                binary entry + updater (plan 0007)
```

## Install sequence

```bash
mkdir steward && cd steward && bun init -y
bun add -d @tjakoen/pantry@github:tjakoen/pantry#main
bun add @tjakoen/batch @tjakoen/grain @tjakoen/mill @tjakoen/proof @tjakoen/crumb
bun add pdf-lib google-spreadsheet google-auth-library @mlc-ai/web-llm
bunx pantry init && bunx proof check
```
`bun:sqlite` is built in — no dep. (npm coords confirmed: batch 0.1.0,
grain 0.1.12, mill 0.2.0, proof 0.1.2, crumb 0.1.4; pantry is git-only.)

## Public-repo hygiene (task: hygiene)

- `.gitignore` before first commit: `_private/`, `*.docx`, `data/*.db*`,
  `secrets/`, `.env*`, `*.local.*`.
- Real reference docs already quarantined in `_private/reference/` — never commit.
- Seed data fictional only (Client "Acme Advisory", Customer "Doe, Jane").
- README + MILL docs describe the **generic** use case: a task-ticket CRM
  with branded document generation. No real firm, no PII.
- PII audit (grep for real names / external IDs) as a pre-commit gate.

## Demo mode (task: demo)

- Toggle: `DEMO=1` env or Settings surface; default on first run of a fresh binary.
- Loads `app/seed/demo.ts` into a separate `data/demo.db` — real data untouched.
- **Reset** re-seeds. Powers the CRUMB tour (0005) and README screenshots.
- Seed: 1 branded Client + ~6 Customers (incl. one joint household) +
  Tickets across every status so the board looks alive.

## Definition of done (this plan)

- `bun run dev` serves; home + settings render.
- One operable proof-of-life intent round-trips: click → `/intent` →
  service → sqlite write + audit row → RenderOp over SSE → DOM patch.
- Schema created + migratable; ticket-id generator unit-tested.
- Demo seed loads and resets.
- Theme toggle flips light/dark and persists.
- `.gitignore` in place; PII audit clean.

## Next plans

`0002-crm` · `0003-tickets` · `0004-pdf` (→ M1 done) ·
`0005-ai-chat` · `0006-grain-upstream` · `0007-shell` · `0008-sheets-sync`
