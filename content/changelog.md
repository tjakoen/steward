# Changelog

## 0.1.0 — Foundation
- Composition root wiring BATCH, GRAIN, MILL, PROOF, CRUMB.
- Single `/intent` door + `/stream` SSE hub.
- SQLite schema: Client, Customer, Ticket, Audit (source of truth).
- Per-customer ticket-id generator (`TX` + code + sequence).
- Append-only audit on every mutation.
- Demo mode: fictional seed + reset.
- Light/dark theme toggle in the header.
