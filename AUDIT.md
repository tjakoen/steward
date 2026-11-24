---
audited: never
result: runbook only
---

# AUDIT: the alignment runbook

The committed procedure that checks this repository still obeys the rules `CLAUDE.md` claims. It is the
**alignment** half of an audit: mechanical checks with a command and a pass bar, all run from the
repository root.

The **quality** half is
[`AUDIT-STANDARD.md`](https://portfolio.tjakoen.com/standards/audit-standard). A pass that runs only
this file is the most common way an audit lies. Nothing here restates `CLAUDE.md` or the canonical
standards; when a check and a canon disagree, the canon wins and the check gets fixed.

Run every check, then either fix what it finds or flag it as deferred with a reason. Set `audited:` to
the date of the pass and leave the report beside the work.

## 1. The green gate

```sh
bun run check
bun test
```

Pass: `bun run check` exits 0 with no type errors, and `bun test` reports `0 fail`. Both, not one.

## 2. The surface contract still holds

```sh
bun test app/ai/surfaces.test.ts
```

Pass: `0 fail`. This is the test behind the three-place contract in `CLAUDE.md`, so it catches a
manifest that advertises an address the markup no longer carries.

## 3. Every intent verb is dispatched

```sh
for a in $(sed -n '/STEWARD_ACTIONS = \[/,/\] as const/p' app/actions/steward.ts | grep -oE "'[a-z.]+'" | tr -d "'"); do
  grep -q "case '$a'" app/actions/steward.ts || echo "unhandled: $a"
done
```

Pass: no `unhandled:` line.

## 4. Styling reads tokens, never raw colour

```sh
grep -rnE '(^|[^-])#[0-9a-fA-F]{3,8}' frontend --include=*.css | grep -v 'var(--'
```

Pass: no output. A literal inside `var(--token, fallback)` is the sanctioned form; a literal on its own
is a design-system finding.

## 5. No BREAD layer is forked into this tree

```sh
git ls-files | grep -E '^(packages|vendor)/'
grep -oE '"@tjakoen/[a-z]+": "[^"]+"' package.json
```

Pass: no output from the first command, then five pin lines from the second.

## 6. No secret material or customer data is tracked

```sh
git ls-files | grep -E '^(_private|data)/|\.(db|db-wal|db-shm|sqlite|sqlite3)$'
git ls-files '.env'
git grep -nE "AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJhbGciOi" -- . ':!*.test.ts'
grep -nE '^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_API_KEY|GOOGLE_PROJECT_NUMBER)=.+' .env.example
```

Pass: no output from any of the four. A tracked record or a filled credential is a blocker.

## 7. The build exceptions are still committed

```sh
git ls-files build/assets.gen.ts build/assets.test.ts | wc -l
```

Pass: `2`. This proves the `build/*` negation still descends, which is the trap `CLAUDE.md` records.

## 8. Docs name code that exists

```sh
grep -ohE '`(app|frontend|plans|scripts|build|config\.ts|server\.ts)[A-Za-z0-9_./:-]*`' README.md CLAUDE.md \
  | tr -d '`' | sed -E 's/:[0-9]+(-[0-9]+)?$//' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "missing: $p"; done
```

Pass: no `missing:` line.

## 9. Every plan is numbered and carries its status

```sh
for f in plans/*.md; do
  [ "$(basename "$f")" = "BACKLOG.md" ] && continue
  basename "$f" | grep -qE '^[0-9]{4}-[a-z0-9-]+\.md$' || echo "bad name: $f"
  grep -q '^status:' "$f" || echo "$f no status"
done
```

Pass: no `bad name:` or `no status` line.

## 10. The history carries no AI attribution

```sh
git log -E --grep="^Co-Authored-By:" --oneline | wc -l
```

Pass: `0`. The pattern is anchored so this section does not match itself.

## 11. Every configuration key is documented in the README

```sh
grep -oE "Bun\.env\.[A-Z_]+" config.ts | sort -u | sed 's/Bun.env.//' \
  | while read -r k; do grep -q "$k" README.md || echo "undocumented: $k"; done
```

Pass: no `undocumented:` line. `README.md` is the only manual a downloaded binary has.

## 12. `.env` stays untracked

```sh
git check-ignore -q .env && echo ignored
```

Pass: `ignored`.

## Findings template

```
✅ 1. gate                typecheck 0, tests 0 fail
⚠️ 11. config docs        SOME_KEY is read by config.ts, absent from README.md; document it
🚫 2. surface test        deferred, accepted: reason and who accepted it
```

Done means every line is ✅, or every ⚠️ is fixed, or every 🚫 names why it is deferred and who
accepted it. Then replace `audited: never` with the date.
