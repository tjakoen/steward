# STEWARD

An AI-first admin cockpit — a **task-ticket CRM with branded document
generation**, built on the [BREAD stack](https://tjakoen.github.io) (no-build,
Bun, server-rendered hypermedia).

Clients, customers and tickets in one place; every ticket renders to a branded
PDF. It runs as a single downloaded file on your own machine — there is no
server to rent, no account to make, and the data stays in one folder you can
copy.

Every surface is operable by a human *and* an AI through one shared door
(`POST /intent` → render ops over SSE).

## Install

Download the file for your machine from the
[latest release](https://github.com/tjakoen/steward/releases/latest):

| Machine | File |
| --- | --- |
| Windows | `steward-windows-x64.exe` |
| Mac (Apple Silicon) | `steward-darwin-arm64` |
| Linux (x64) | `steward-linux-x64` |

There is no Intel Mac build. Ask if you need one.

### These binaries are not code-signed

They are not signed by Apple or by a Windows certificate authority, so both
systems will stop you the first time. That is the expected behaviour for an
unsigned download and not a sign that anything is wrong — but it does mean you
are being asked to trust this on your own judgement, so verify the checksum
below if that matters to you.

**Mac.** A downloaded file is quarantined; macOS refuses to run it and offers
no override in the dialog. Clear the quarantine flag and make it executable:

```bash
xattr -dr com.apple.quarantine ./steward-darwin-arm64
chmod +x ./steward-darwin-arm64
./steward-darwin-arm64
```

**Windows.** Double-click it and SmartScreen shows *"Windows protected your
PC"*. The run button is hidden behind **More info** → **Run anyway**.

**Linux.** `chmod +x ./steward-linux-x64`, then run it.

### Verifying what you downloaded

Every release publishes `SHA256SUMS` covering all three binaries. A project
that ships unsigned binaries owes you a way to check them:

```bash
# mac / Linux — run from the folder holding both files
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
# Windows — compare the hash to the steward-windows-x64.exe line in SHA256SUMS
Get-FileHash .\steward-windows-x64.exe -Algorithm SHA256 | Format-List
```

### What else your machine needs

Both are optional, and STEWARD says so plainly rather than breaking when they
are absent:

- **Chrome or Edge** — used to render PDFs. Without one, ticket PDFs and the
  daily digest's attachments cannot be produced; everything else works. Edge
  ships with Windows, so this is normally already satisfied there. Set
  `CHROME_PATH` if yours is somewhere unusual.
- **[Ollama](https://ollama.com)** — used by the in-app chat panel. Without it
  the panel says the model is not running; everything else works. Set
  `OLLAMA_URL` if it is not on the default port.

## Running it

Start it and a browser tab opens by itself at `http://localhost:3000`. If that
port is taken, STEWARD takes another one and the log says which. Starting it a
second time does not start a second copy — it opens the browser at the one
already running.

### Where your data lives

One directory holds the database, the local document store, the log and your
settings file. Copying that directory is the whole backup:

| System | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\STEWARD` |
| Mac | `~/Library/Application Support/STEWARD` |
| Linux | `$XDG_DATA_HOME/steward` (usually `~/.local/share/steward`) |

Copy `steward.db` with `sqlite3 steward.db "VACUUM INTO 'backup.db'"` rather
than plain `cp` if STEWARD is running — the most recent writes live in a
`-wal` file beside it, and copying the `.db` alone silently loses them.

### Settings: `steward.env`

Create `steward.env` in that same directory to change anything without a
rebuild. It is the only configuration surface a downloaded binary has:

```ini
PORT=3000
OLLAMA_URL=http://localhost:11434
CHROME_PATH=/path/to/chrome
```

### When nothing appears

`steward.log`, in the data directory above. This matters most on Windows,
where the release exe hides its console window: a launch that fails before the
browser opens usually leaves nothing on screen at all, and that file is the
only record of what happened. It is written before the server binds, so even a
crash during startup lands in it.

## Updating

**Settings → Version → Check for updates** asks GitHub, and **Download and
restart** verifies the download against the release's `SHA256SUMS` before
replacing anything. Nothing downloads or installs without that click. If the
checksum does not match, the running copy is left exactly as it was.

## Develop

```bash
bun install
bun run dev            # http://localhost:3000 — hot reload, no build step
bun run check          # tsc --noEmit
bun test               # unit + integration
bun run build          # compile binaries into dist/
```

### Concepts

- **Client** — a branded organization the platform serves. Owns the logo,
  colors and company info stamped on generated documents.
- **Customer** — an individual or household belonging to a Client (may be joint).
- **Ticket** — a task about a Customer; renders to a branded document.

SQLite is the source of truth; every mutation appends an audit row.

### Demo mode

```bash
DEMO=1 bun run app/seed/demo.ts    # seed a separate demo database
```

Or open **Settings → Demo mode → Reset demo data** in the app. Demo data is
fictional; your real data lives in a separate database and is never touched.

### Layers

BATCH (substrate) · GRAIN (design system + AI vocabulary) · MILL (Markdown
content) · PROOF (plan board, at `/plans`) · CRUMB (guided tours).

## Status

First release. CRM, tickets, branded PDFs, Google Drive and Sheets sync, a
daily email digest, in-app AI chat, and a packaged binary that updates itself.
Plans and their full reasoning are in `plans/`, and readable in the app at
`/plans`.

## License

MIT — see [LICENSE](./LICENSE).
