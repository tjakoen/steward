---
id: 0006-documents
title: STEWARD — Documents, attachments and the file manager (Drive-backed)
status: in-progress
owner: admin
created: 2026-07-31
milestone: M2 (AI-native cockpit)
tags: [documents, drive, oauth, files, preview]
tasks:
  - id: doc-model
    title: DocumentRef domain type + sqlite table + repository port
    status: done
  - id: store-port
    title: DocumentStore port (put/get/remove) with a local-disk implementation
    status: done
  - id: record-docs
    title: Documents section in every record panel — attach, list, open
    status: done
  - id: generated-pdfs
    title: Ticket PDFs stored as documents, each carrying its ticket lineage
    status: done
  - id: file-manager
    title: /files browser — table, filter, lineage chips, source badges
    status: done
  - id: preview
    title: Preview panel in the drawer for images and PDFs, download otherwise
    status: done
  - id: oauth
    title: Google OAuth (user consent, PKCE, loopback) + Settings connection surface
    status: done
  - id: drive-store
    title: GoogleDriveStore implementing the port (upload/download/delete)
    status: done
  - id: link-existing
    title: Link existing Drive files (needs the Google Picker; not built)
    status: todo
---

# STEWARD — Documents (0006)

Files become first-class records: generated ticket PDFs stop being throwaway renders,
arbitrary files can be attached to any record, and existing Drive files can be linked
without copying. Everything is browsable in an in-app file manager and previewable in the
side panel, carrying the same lineage/chips treatment the CRM records got in the UI pass.

## Why a port, and why local-disk first

Storage sits behind a `DocumentStore` port with two implementations:

- **local disk** — the default, works offline and with no Google account at all.
- **Google Drive** — used once the operator connects their account in Settings.

This is not hedging. A desktop app must work before (and without) an OAuth round-trip, and
a port means the documents feature is fully built and verifiable *today* rather than
blocked behind credentials that don't exist yet. The Drive implementation then drops in
without touching the UI, exactly as the repository ports let SQLite swap for in-memory.

## Auth: user consent, not a service account

OAuth 2.0 **user consent** with **PKCE over a loopback redirect** (the installed-app flow),
not a service account. Two reasons:

1. Files land in the operator's *own* Drive, owned by them — which is what a person doing
   admin work for their own clients actually wants.
2. A service-account key would have to ship inside the distributed binary (0007). That is a
   secret-distribution problem with no good answer for a desktop app.

Scope is `drive.file` — per-file access to what STEWARD creates or the user explicitly
opens. Linking *arbitrary* pre-existing Drive files needs the user to pick them (Picker) or
a broader read scope; the narrow scope is the default and the broader one is opt-in.

The refresh token is stored locally in SQLite. It is a credential: it never appears in an
audit diff, never renders in the UI, and never leaves the machine.

## Model

```ts
type DocumentSource = 'generated' | 'upload' | 'link';

interface DocumentRef {
  id: string;
  entity: 'client' | 'customer' | 'ticket';  // what it belongs to
  entityId: string;
  name: string;
  mimeType: string;
  size: number;
  source: DocumentSource;
  storage: 'local' | 'drive';
  storageId: string;      // path on disk, or Drive file id
  webViewLink: string;    // '' for local
  createdAt: string;
  createdBy: string;      // actor, same vocabulary as audit rows
}
```

`entity` + `entityId` is what gives a document its lineage: a generated PDF is not a loose
file, it is *the document of ticket TXDOEX0001*, and renders with that breadcrumb
everywhere it appears. Every document mutation writes an audit row like any other.

## Surfaces

- **Record panels** — a Documents section listing that record's files as chips, plus attach.
- **`/files`** — the file manager: name, type, size, owning record (lineage chips), source
  badge (generated / upload / link), date. Filterable like every other list.
- **Preview** — clicking a file opens the drawer: images inline, PDFs embedded, anything
  else falls back to download. Same panel machinery as record view/edit.

## Sequencing

`doc-model` → `store-port` → `record-docs` → `generated-pdfs` → `file-manager` → `preview`
are all buildable and verifiable with the local store. `oauth` and `drive-store` follow and
need a Google Cloud client id from the operator to verify end-to-end.

## What is not done

`linkDocument` exists in the service layer and the model carries a `link` source, but
there is **no UI to link an existing Drive file**. Doing it properly needs the Google
Picker, because `drive.file` deliberately cannot see files STEWARD did not create — the
user has to hand each one over. Until that is built, "link" is reachable only in code.

Live consent has not been exercised end to end: it needs a real Google Cloud client id.
Everything up to the redirect is verified (consent URL, scope, PKCE challenge, state
rejection, token refresh and disconnect against a fake token endpoint).

## Roadmap note

This plan takes the 0006 slot; the previously-sketched roadmap shifts to
0007-grain-upstream → 0008-shell → 0009-sheets-sync.
