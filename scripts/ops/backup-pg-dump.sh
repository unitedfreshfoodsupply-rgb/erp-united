#!/usr/bin/env bash
# UNITED ERP — scheduled, encrypted logical backup (WS6). See docs/erp/OPERATIONS_RUNBOOK.md §4.
#
# What it does, in order:
#   1. Refuses to run unless the password comes from a private ~/.pgpass (mode 0600) or
#      PGPASSFILE, and an encryption recipient is configured. It never writes an
#      unencrypted dump to disk and never prints a host, user, password or URL.
#   2. pg_dump (custom format) through the Supabase SESSION pooler, streamed straight
#      into public-key encryption (age, or gpg). The VPS holds only the PUBLIC key, so a
#      compromised VPS cannot read its own backups.
#   3. Writes <file>.sha256, then atomically renames into place.
#   4. Rewrites the marker file (BACKUP_MARKER_FILE) that GET /api/health/deep reports.
#   5. Retention: deletes encrypted dumps older than BACKUP_RETENTION_DAYS, but always
#      keeps the newest BACKUP_KEEP_MIN files whatever their age.
#   6. Optionally pings a heartbeat URL (dead-man's switch) on success only.
#
# Configuration — environment variables (non-secret), e.g. in /home/hermes/.config/united-backup.env:
#   PGHOST, PGPORT, PGUSER, PGDATABASE   libpq connection (session pooler: port 5432,
#                                        user "postgres.<project-ref>")
#   PGPASSFILE                           optional; defaults to ~/.pgpass (must be 0600)
#   BACKUP_DIR                           where encrypted dumps go (default ~/backups/united)
#   BACKUP_AGE_RECIPIENT                 age public key ("age1…")            } one of
#   BACKUP_GPG_RECIPIENT                 gpg key id / fingerprint (public)   } the two
#   BACKUP_RETENTION_DAYS                default 30
#   BACKUP_KEEP_MIN                      default 7
#   BACKUP_MARKER_FILE                   default $BACKUP_DIR/LAST_SUCCESS
#   BACKUP_HEARTBEAT_URL                 optional, e.g. a healthchecks.io ping URL (treated as secret)
#   BACKUP_PG_MAJOR                      expected server major version (default 17)
#
# Exit codes: 0 ok · 2 configuration refused · 3 dump/encryption failed.
set -Eeuo pipefail
umask 077

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "REFUSED: $*"; exit 2; }

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/united}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
BACKUP_MARKER_FILE="${BACKUP_MARKER_FILE:-$BACKUP_DIR/LAST_SUCCESS}"
BACKUP_PG_MAJOR="${BACKUP_PG_MAJOR:-17}"
PGPASSFILE="${PGPASSFILE:-$HOME/.pgpass}"
export PGPASSFILE

# --- 1. Configuration checks (names only, never values) ---------------------------
for v in PGHOST PGPORT PGUSER PGDATABASE; do
  [ -n "${!v:-}" ] || die "$v is not set (see the header of this script)"
done
[ -z "${PGPASSWORD:-}" ] || die "PGPASSWORD is set in the environment — use a 0600 pgpass file instead (it would be visible in /proc)"
case "$PGHOST$PGUSER$PGDATABASE" in *"://"*) die "PGHOST/PGUSER/PGDATABASE must be plain values, not a URL";; esac
[ -f "$PGPASSFILE" ] || die "password file not found (PGPASSFILE / ~/.pgpass)"
perm="$(stat -c '%a' "$PGPASSFILE" 2>/dev/null || stat -f '%Lp' "$PGPASSFILE")"
[ "$perm" = "600" ] || [ "$perm" = "400" ] || die "password file must be mode 0600 (is $perm)"
owner="$(stat -c '%U' "$PGPASSFILE" 2>/dev/null || stat -f '%Su' "$PGPASSFILE")"
[ "$owner" = "$(id -un)" ] || die "password file must belong to the user running the backup"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || die "age is not installed (apt install age) — or use BACKUP_GPG_RECIPIENT"
  ENC_EXT="age"
  encrypt() { age --encrypt --recipient "$BACKUP_AGE_RECIPIENT"; }
elif [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  command -v gpg >/dev/null || die "gpg is not installed"
  ENC_EXT="gpg"
  encrypt() { gpg --batch --yes --quiet --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT"; }
else
  die "no encryption recipient: set BACKUP_AGE_RECIPIENT (preferred) or BACKUP_GPG_RECIPIENT — an unencrypted dump is never written"
fi

command -v pg_dump >/dev/null || die "pg_dump not found"
dump_major="$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
[ "$dump_major" -ge "$BACKUP_PG_MAJOR" ] || die "pg_dump $dump_major is older than the server ($BACKUP_PG_MAJOR) — install postgresql-client-$BACKUP_PG_MAJOR"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# One run at a time (a slow dump must not overlap the next schedule).
if command -v flock >/dev/null; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "another backup is still running"
fi

# --- 2. Dump → encrypt (streamed; nothing unencrypted touches disk) -----------------
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="united-$stamp.dump.$ENC_EXT"
tmp="$BACKUP_DIR/.$name.partial"
trap 'rm -f "$tmp" "$tmp.sha256"; log "FAILED (partial file removed)"' ERR
log "starting dump → $name"
# --no-owner/--no-acl: restorable into a fresh database without Supabase's roles.
if ! pg_dump --format=custom --no-owner --no-acl --compress=6 | encrypt > "$tmp"; then
  rm -f "$tmp"; log "FAILED: pg_dump or encryption returned an error"; exit 3
fi
size="$(wc -c < "$tmp" | tr -d ' ')"
[ "$size" -gt 1024 ] || { rm -f "$tmp"; log "FAILED: output suspiciously small ($size bytes)"; exit 3; }

# --- 3. Checksum, then publish atomically ------------------------------------------
( cd "$BACKUP_DIR" && sha256sum "$(basename "$tmp")" 2>/dev/null || shasum -a 256 "$(basename "$tmp")" ) \
  | sed "s#\.$name\.partial#$name#" > "$tmp.sha256"
mv "$tmp.sha256" "$BACKUP_DIR/$name.sha256"
mv "$tmp" "$BACKUP_DIR/$name"
trap - ERR
log "ok: $name ($size bytes)"

# --- 4. Marker for /api/health/deep (timestamp + file name only) --------------------
printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" "$size" > "$BACKUP_MARKER_FILE.tmp"
mv "$BACKUP_MARKER_FILE.tmp" "$BACKUP_MARKER_FILE"
chmod 644 "$BACKUP_MARKER_FILE"

# --- 5. Retention ------------------------------------------------------------------
# Newest first; the first BACKUP_KEEP_MIN are always kept. (Plain while-read: works in
# bash 3.2 too, so the same script can be tried on a Mac.)
i=0; removed=0; total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  total=$((total + 1))
  if [ "$i" -ge "$BACKUP_KEEP_MIN" ] && [ -n "$(find "$f" -mtime +"$BACKUP_RETENTION_DAYS" -print 2>/dev/null)" ]; then
    rm -f -- "$f" "$f.sha256"
    removed=$((removed + 1))
  fi
  i=$((i + 1))
done <<EOF_LIST
$(ls -1t "$BACKUP_DIR"/united-*.dump."$ENC_EXT" 2>/dev/null || true)
EOF_LIST
log "retention: kept $((total - removed)), removed $removed (older than ${BACKUP_RETENTION_DAYS}d, newest ${BACKUP_KEEP_MIN} always kept)"

# --- 6. Heartbeat (success only; the URL is never printed) ---------------------------
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ] && command -v curl >/dev/null; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_HEARTBEAT_URL" && log "heartbeat sent" || log "heartbeat FAILED (backup itself is fine)"
fi
