#!/usr/bin/env bash
# UNITED ERP — monthly restore test of an encrypted backup (WS6). See docs/erp/OPERATIONS_RUNBOOK.md §5.
# Same approach as ~/UNITED_FINAL_BACKUP_20261102/metadata/restore-test.sh, for the
# encrypted dumps written by scripts/ops/backup-pg-dump.sh.
#
# Runs on a machine that holds the PRIVATE key (the owner's Mac), never on the VPS and
# never against production: the target database must be on localhost (or a local
# socket), and it is a fresh throwaway database that is dropped at the end.
#
# Usage:
#   scripts/ops/verify-restore.sh [encrypted-dump]        # default: newest in $BACKUP_DIR
# Environment:
#   BACKUP_DIR            where the encrypted dumps were copied to (default ~/backups/united)
#   AGE_IDENTITY          age identity file (private key), for .age dumps
#                         (.gpg dumps use the local gpg keyring / agent)
#   RESTORE_PGHOST        default localhost — anything else is refused
#   RESTORE_PGPORT        default 5432
#   RESTORE_PGUSER        default $USER
#   RESTORE_DB            default united_restore_test
#   EXPECTED_MIGRATIONS   optional: fail unless exactly this many migrations are applied
#   KEEP=1                keep the restored database for inspection (default: drop it)
#
# Prints: checksum result, applied migration count, row counts per table, key business
# totals, and a single PASS/FAIL line. Exit 0 only on PASS.
set -Eeuo pipefail
umask 077

log() { printf '%s [restore-test] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/united}"
RESTORE_PGHOST="${RESTORE_PGHOST:-localhost}"
RESTORE_PGPORT="${RESTORE_PGPORT:-5432}"
RESTORE_PGUSER="${RESTORE_PGUSER:-$USER}"
RESTORE_DB="${RESTORE_DB:-united_restore_test}"

case "$RESTORE_PGHOST" in
  localhost|127.0.0.1|::1|/*) ;;
  *) fail "RESTORE_PGHOST must be local (localhost / 127.0.0.1 / a socket path) — a restore test never touches a remote database";;
esac
case "$RESTORE_DB" in
  *prod*|postgres|template0|template1) fail "refusing to use database name '$RESTORE_DB'";;
esac

DUMP="${1:-$(ls -1t "$BACKUP_DIR"/united-*.dump.age "$BACKUP_DIR"/united-*.dump.gpg 2>/dev/null | head -1 || true)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || fail "no encrypted dump found (pass a path or set BACKUP_DIR)"
log "dump: $(basename "$DUMP") ($(wc -c < "$DUMP" | tr -d ' ') bytes)"

# 1. Checksum of the encrypted file (detects truncation in transit).
if [ -f "$DUMP.sha256" ]; then
  ( cd "$(dirname "$DUMP")" && (sha256sum -c "$(basename "$DUMP").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$DUMP").sha256") ) >/dev/null \
    || fail "checksum mismatch"
  log "checksum: OK"
else
  log "checksum: no .sha256 next to the dump (not verified)"
fi

# 2. Decrypt into a private temp file (removed on exit, whatever happens).
work="$(mktemp -d "${TMPDIR:-/tmp}/united-restore.XXXXXX")"
cleanup() {
  rm -rf "$work"
  if [ "${KEEP:-0}" != "1" ]; then
    dropdb -h "$RESTORE_PGHOST" -p "$RESTORE_PGPORT" -U "$RESTORE_PGUSER" --if-exists "$RESTORE_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
plain="$work/restore.dump"
case "$DUMP" in
  *.age) [ -n "${AGE_IDENTITY:-}" ] || fail "AGE_IDENTITY (private key file) is required for .age dumps"
         age --decrypt --identity "$AGE_IDENTITY" -o "$plain" "$DUMP" || fail "decryption failed";;
  *.gpg) gpg --batch --quiet --decrypt -o "$plain" "$DUMP" || fail "decryption failed";;
  *) fail "unknown dump type (expected .age or .gpg)";;
esac
pg_restore --list "$plain" >/dev/null || fail "decrypted file is not a readable pg_dump archive"
log "decrypted and catalogue readable ($(pg_restore --list "$plain" | grep -c 'TABLE DATA') tables with data)"

# 3. Restore into a brand-new local database.
PSQL=(psql -h "$RESTORE_PGHOST" -p "$RESTORE_PGPORT" -U "$RESTORE_PGUSER" -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -qtA)
dropdb -h "$RESTORE_PGHOST" -p "$RESTORE_PGPORT" -U "$RESTORE_PGUSER" --if-exists "$RESTORE_DB"
createdb -h "$RESTORE_PGHOST" -p "$RESTORE_PGPORT" -U "$RESTORE_PGUSER" "$RESTORE_DB"
# A Supabase dump carries its own CREATE SCHEMA public (owned by postgres there); a fresh
# local database already has one. Drop the local one only when the dump brings its own.
if pg_restore --list "$plain" | grep -qE '[0-9]+ SCHEMA - public '; then
  "${PSQL[@]}" -c 'DROP SCHEMA IF EXISTS public CASCADE' >/dev/null
fi
# Supabase-only extensions/schemas may not exist locally; those errors are listed, not fatal,
# and the checks below decide whether the business data came back.
pg_restore -h "$RESTORE_PGHOST" -p "$RESTORE_PGPORT" -U "$RESTORE_PGUSER" -d "$RESTORE_DB" \
  --no-owner --no-privileges "$plain" 2> "$work/restore.err" || true
errs="$(grep -c 'error:' "$work/restore.err" || true)"
log "pg_restore finished ($errs error line(s); first ones below if any)"
grep 'error:' "$work/restore.err" | head -5 | sed 's/^/    /' || true

# 4. Checks.
migrations="$("${PSQL[@]}" -c "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" 2>/dev/null || echo 0)"
log "applied migrations: $migrations"
[ "$migrations" -gt 0 ] || fail "no applied migrations in the restored database"
if [ -n "${EXPECTED_MIGRATIONS:-}" ] && [ "$migrations" != "$EXPECTED_MIGRATIONS" ]; then
  fail "expected $EXPECTED_MIGRATIONS migrations, found $migrations"
fi
users="$("${PSQL[@]}" -c 'SELECT count(*) FROM public."User"')"
[ "$users" -gt 0 ] || fail "no users restored"
log "row counts (public):"
"${PSQL[@]}" -F'|' -c "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::bigint
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1" | sed 's/^/    /'
# Ledger integrity: every posted journal balances (a restore that lost lines would not).
unbalanced="$("${PSQL[@]}" -c 'SELECT count(*) FROM (SELECT "entryId" FROM public."JournalLine" GROUP BY "entryId" HAVING sum("debit") <> sum("credit")) x' 2>/dev/null || echo "n/a")"
log "unbalanced journal entries: $unbalanced"
[ "$unbalanced" = "0" ] || [ "$unbalanced" = "n/a" ] || fail "restored ledger has unbalanced entries"

log "PASS — $(basename "$DUMP") restores: $migrations migrations, $users users$( [ "${KEEP:-0}" = "1" ] && echo ", kept as $RESTORE_DB" || echo ", database dropped")"
