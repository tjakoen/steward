# STEWARD

An AI-first admin cockpit — a **task-ticket CRM with branded document
generation**, built on the [BREAD stack](https://tjakoen.github.io) (no-build,
Bun, server-rendered hypermedia).

Every surface is operable by a human *and* an AI through one shared door
(`POST /intent` → render ops over SSE).

## Concepts

- **Client** — a branded organization the platform serves. Owns the logo,
  colors and company info stamped on generated documents.
- **Customer** — an individual or household belonging to a Client (may be joint).
- **Ticket** — a task about a Customer; renders to a branded document.

SQLite is the source of truth; every mutation appends an audit row.

## Develop

```bash
bun install
bun run dev            # http://localhost:3000 — hot reload, no build step
bun run check          # tsc --noEmit
bun test               # unit + integration
```

### Demo mode

```bash
DEMO=1 bun run app/seed/demo.ts    # seed a separate demo database
```

Or open **Settings → Demo mode → Reset demo data** in the app. Demo data is
fictional; your real data lives in a separate database and is never touched.

## Layers

BATCH (substrate) · GRAIN (design system + AI vocabulary) · MILL (Markdown
content) · PROOF (plan board, at `/plans`) · CRUMB (guided tours).

## Status

Foundation (plan `0001`). Roadmap: CRM · tickets/kanban · branded PDF ·
in-app AI chat · packaged desktop binary with auto-update. See `plans/`.

## License

MIT — see [LICENSE](./LICENSE).
