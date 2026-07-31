---
id: 0003-tickets
title: STEWARD — Tickets (CRUD + kanban board)
status: done
owner: admin
created: 2026-07-31
milestone: M1 (usable admin tool)
tags: [tickets, kanban, grain, intent, sse]
tasks:
  - id: ticket-actions
    title: Ticket action vocabulary + dispatcher (create/update/status/progress)
    status: done
  - id: ticket-view
    title: Ticket card + form schema + kanban board renderer
    status: done
  - id: ticket-routes
    title: /tickets board + /tickets/:id detail routes; nav entry
    status: done
  - id: ticket-drag
    title: Drag card between columns → ticket.status over SSE
    status: done
  - id: tests
    title: Dispatcher tests (create/status/progress + validation)
    status: done
---

# STEWARD — Tickets (0003)

Third domain surface: **Tickets** — the task unit the whole tool exists to move.
A ticket belongs to a Customer, carries a status, a progress log, and renders
(next plan) to a branded PDF. This plan makes tickets operable end-to-end and
gives them a **PROOF-style kanban board** where status = column.

Everything below the action layer already exists from 0001/0002: the `Ticket`
domain type, `NewTicket` port, the `tickets` repo (per-customer `ticketId`
sequence via `makeTicketId`), and the service verbs `createTicket`,
`updateTicket`, `setTicketStatus`, `addProgress` (each already audited). This
plan wires those verbs to the `/intent` door and to a board UI.

## Vocabulary (extends the STEWARD registry)

Add to `STEWARD_ACTIONS`, dispatched behind the same `/intent` door + SSE hub:

- `ticket.create` — new ticket for a customer; appends a card to its status column.
- `ticket.update` — edit title/summary/nextAction/waitingOn; replaces the card.
- `ticket.status` — move a ticket to a new status (the drag verb).
- `ticket.progress` — append a dated entry to the progress log.

`ticket.status` is the board's core move. The server is authoritative: the
dispatcher emits **two** RenderOps — `remove` the card from its old column and
`append` it to the new column's list (`data-surface="ticket-col:<Status>"`).
The client does **not** optimistically move the card; it posts the intent and
lets SSE reconcile. One source of truth, no double-render.

## Board layout

`renderBoard(tickets)` builds one column per `TICKET_STATUSES` entry
(`Not Commenced | In Progress | Waiting | Completed`). Each column is a drop
zone `data-surface="ticket-col:<Status>"`; each card is
`data-surface="ticket:<id>"`, `draggable="true"`, carrying `data-ticket-id`
and `data-status`. Card shows ticketId code, title, customer label, and (when
Waiting) waiting-on. Column headers show live counts.

## Routes

- `GET /tickets` — the board (all tickets, grouped by status).
- `GET /tickets/:id` — detail: FormBuilder view of the ticket + progress log +
  an "add progress" mini-form (`ticket.progress`).
- `GET /tickets/new` (or a create form on the board) — `ticket.create` with a
  customer picker.
- Add **Tickets:/tickets** to the top-nav.

## Drag interaction (steward-live.js)

Native HTML5 drag/drop: `dragstart` stashes the card's ticket id;
`drop` on a column posts `ticket.status { id, status }`. Guard: dropping onto
the same column is a no-op. SSE remove+append performs the actual move; a
`flash` op on the moved card confirms.

## Definition of done

- `ticket.*` intents round-trip `/intent` → services → audit → SSE.
- Board renders four columns with seeded demo tickets in the right lanes.
- Drag a card to another column → status persists, card moves via SSE, audit row written.
- Create a ticket from the UI → card appends to its status column live.
- Add a progress entry from the detail view → log grows, `dateLastUpdated` bumps.
- Tests: dispatcher create/status/progress happy-path + a validation failure.
- `bun run check` clean; end-to-end verified (boot server, curl /intent + SSE).
