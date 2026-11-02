# UNITED ERP — Operations runbook (WS6, November 2026)

> **Status: prepared, not executed.** Written without VPS access. Every step that touches
> the VPS, Supabase or GitHub is for the operator/owner, in a window the owner approves.
> Carry-over rules from `PRODUCTION_DEPLOYMENT_RUNBOOK.md` still apply: never print a
> credential or connection string, never delete the `united-erp` PM2 app (stop it), do not
> change the reverse-proxy configuration as part of these steps.

**Runtime, as documented elsewhere:** Next.js (`next start`) under PM2 as user `hermes`, behind
Nginx Proxy Manager (openresty) on the VPS; database on Supabase Postgres 17 reached through the
**session pooler** (port 5432); environment in the release folder's `.env.local`.

| § | Topic | Owner action needed |
|---|---|---|
| 1 | Deploying WS6 (MFA key, MFA rollout, what changes for users) | **Yes — before the deploy** |
| 2 | PM2 survives a reboot | Yes |
| 3 | Uptime and error monitoring | Yes (accounts) |
| 4 | Scheduled encrypted backups | Yes |
| 5 | Monthly restore test | Yes (monthly) |
| 6 | Database password rotation | When needed |
| 7 | GitHub hardening | Yes |
| 8 | Break-glass: MFA lockout | Only in an emergency |

---

## 1. Deploying WS6

### 1.1 New environment variable — required, or the app will not start

Production now refuses to boot without `MFA_ENCRYPTION_KEY` (≥ 32 characters; `lib/env.ts`).
On the VPS, as `hermes`, in the new release folder — the value is generated on the server and
never displayed:

```bash
umask 077
printf 'MFA_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 48)" >> .env.local
grep -c '^MFA_ENCRYPTION_KEY=' .env.local      # 1 — prints a count, not the value
```

Store a copy of the key in the owner's password manager **separately from database backups**.
A restored database without this key leaves every enrolled user unable to pass the second step
(an administrator then resets their MFA, §8). Do not change it later unless you intend to make
everyone re-enrol: there is no automatic re-encryption.

### 1.2 What changes for users at the deploy

| Change | Who notices |
|---|---|
| `auth.mfa_required_roles` defaults to **SUPER_ADMIN, ACCOUNTANT**. At their next request after the deploy these users are sent to `/mfa/setup` and can do nothing else (APIs answer 403 `auth.mfa-enroll-required`) until they scan the QR code with an authenticator app and confirm a code. They get 10 single-use recovery codes, shown once. | The owner / administrators, the accountant(s) |
| Enrolled users sign in in two steps: password, then a 6-digit code (or a recovery code). Five wrong codes lock the username for 5 minutes, like wrong passwords. | Same |
| Sessions use `SameSite=Strict`: opening an app link **from another website** (webmail, a web chat client) shows the sign-in page; opening it directly (address bar, bookmark, QR scan, refresh) is unaffected. | Everyone, rarely |
| A session lasts at most **24 hours** whatever `auth.session_ttl_hours` says (default stays 12h). | Anyone who had set a TTL above 24h |
| New/changed passwords: at least 10 characters, not the username, not a well-known password. Existing passwords keep working; their hashes are upgraded (bcrypt 10 → 12) at the next sign-in. Sign-in takes ~0.25 s longer. | Administrators setting passwords |
| Content-Security-Policy on every page. | Nobody, unless a browser extension injects scripts |

**Before the deploy:** make sure the owner and the accountant have a phone with an authenticator
app (Google Authenticator, Microsoft Authenticator, 1Password, …) and a safe place for recovery
codes. Strongly recommended: **two** active SUPER_ADMIN accounts, so one can reset the other's
MFA (a super admin cannot reset their own while another exists — four-eyes rule).

**Optional gentler rollout:** set *Settings → auth.mfa_required_roles* to an empty list right
after the deploy (with a reason), let each person enrol from *Profile → Two-step sign-in*, then
put the roles back. Note the setting itself can only be changed by a super admin who is not held.

### 1.3 Migration

`20261102150000_user_mfa` — additive: five nullable columns on `User`, one new table
`UserMfaRecoveryCode` (RLS on, no Data-API grants). The old build keeps working against it.

### 1.4 Health checks after the switch

```bash
curl -fsS http://127.0.0.1:3000/api/health                     # {"status":"ok"}  (now really tests the DB, 2 s timeout → 503)
curl -sI http://127.0.0.1:3000/login | grep -i content-security-policy   # present, with a nonce
```
Signed in as a super admin, open `/api/health/deep`: `status: ok`, `migrations.pending: []`,
`mfa.activeUsersWithoutMfa` (should fall to 0 as people enrol), `backup` (after §4).

---

## 2. PM2: survive a reboot

Today a VPS reboot leaves the app down until someone runs `pm2 resurrect`. As `hermes`:

```bash
pm2 ls                                   # the live app must be "online" before saving
pm2 startup systemd -u hermes --hp /home/hermes
#   ↑ prints ONE `sudo env PATH=… pm2 startup systemd -u hermes --hp /home/hermes` line:
#     run exactly that line (needs sudo). It installs pm2-hermes.service. It does not
#     restart or update the running PM2 daemon.
pm2 save                                 # snapshot of the current process list → ~/.pm2/dump.pm2
systemctl is-enabled pm2-hermes          # enabled
```
Run `pm2 save` again **after every app switch** (the deployment runbook already says so for its
step 6), otherwise a reboot brings back the previous release.

Log rotation (PM2 logs otherwise grow without bound):
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M && pm2 set pm2-logrotate:retain 14 && pm2 set pm2-logrotate:compress true
```

**Reboot test** (maintenance window, owner approval, someone watching the uptime monitor):
1. `pm2 save`; note `pm2 ls`.
2. `sudo reboot`.
3. After ~2 minutes: `pm2 ls` shows the same apps online; `curl -fsS http://127.0.0.1:3000/api/health`
   returns `{"status":"ok"}`; the external monitor (§3) recorded the outage and the recovery.
4. Record the downtime observed in the change log.

---

## 3. Monitoring

### 3.1 Uptime (external — must not run on the VPS it watches)

Any external HTTP monitor (Better Stack / UptimeRobot / Healthchecks.io / Uptime Kuma on a
different machine):

| Setting | Value |
|---|---|
| URL | `https://<production domain>/api/health` |
| Expect | HTTP 200 and body contains `"status":"ok"` |
| Interval | 1–5 minutes |
| Timeout | 10 s (the endpoint itself gives up on the DB after 2 s and answers 503) |
| Alert | after 2 consecutive failures, to the owner's phone (SMS/push) and e-mail |

`/api/health` is public by design and reveals only `{status}`. `/api/health/deep` needs a super
admin session — do not point a monitor at it with stored credentials.

Add a second, **dead-man's-switch** check for backups: a Healthchecks.io (or similar) check with
the backup schedule; put its ping URL in `BACKUP_HEARTBEAT_URL` (§4). It alerts when a backup
*does not* run.

### 3.2 Errors (recommendation)

- **Now, no new service:** PM2 logs with rotation (§2) and a weekly look at
  `pm2 logs united-erp --err --lines 500`. Every server error is logged as `[api-error <ref>]`; the
  same 8-character ref is returned to the user, so a reported error can be found with
  `grep <ref> ~/.pm2/logs/*`.
- **Recommended next step:** Sentry (SaaS EU region, or self-hosted) with the Next.js SDK, server
  and client, `sendDefaultPii: false`, request bodies not captured (they hold prices, tax IDs and
  salaries). Adding it requires its ingest host in the CSP `connect-src` (`lib/security/csp.ts`) —
  a code change, not a config change. Alert on new issue types and on error-rate spikes.
- CSP violations appear in the browser console only (no report endpoint yet); a `report-to`
  endpoint can be added together with Sentry, which accepts CSP reports.

---

## 4. Scheduled, encrypted backups

Supabase's own backups remain the first line. This adds an **independent, encrypted, off-platform
daily dump** — `scripts/ops/backup-pg-dump.sh`.

### 4.1 One-time setup (VPS, user `hermes`)

1. **Client tools** matching the server major version (17): `sudo apt install postgresql-client-17 age`.
2. **Encryption key pair — generated on the owner's Mac, not on the VPS:**
   `age-keygen -o ~/united-backup-identity.txt` (keep this file in the password manager / offline;
   it is the only way to read the backups). Copy only the **public** key (`age1…`) to the VPS.
3. **Credentials in a pgpass file readable only by `hermes`.** Use the Supabase **session pooler**
   (Dashboard → Connect → Session pooler): host `aws-0-<region>.pooler.supabase.com`, port `5432`,
   user `postgres.<project-ref>`. Type the password at a prompt so it never reaches shell history:
   ```bash
   umask 077
   read -r -s -p 'DB password: ' PW && printf '%s:5432:postgres:%s:%s\n' \
     'aws-0-<region>.pooler.supabase.com' 'postgres.<project-ref>' "$PW" > ~/.pgpass; unset PW
   chmod 600 ~/.pgpass && ls -l ~/.pgpass      # -rw------- hermes
   ```
4. **Non-secret settings** in `~/.config/united-backup.env` (mode 600):
   ```bash
   PGHOST=aws-0-<region>.pooler.supabase.com
   PGPORT=5432
   PGUSER=postgres.<project-ref>
   PGDATABASE=postgres
   BACKUP_DIR=/home/hermes/backups/united
   BACKUP_AGE_RECIPIENT=age1…            # the PUBLIC key from step 2
   BACKUP_RETENTION_DAYS=30
   BACKUP_KEEP_MIN=7
   BACKUP_MARKER_FILE=/home/hermes/backups/united/LAST_SUCCESS
   BACKUP_HEARTBEAT_URL=                 # optional, §3.1
   ```
   Add `BACKUP_MARKER_FILE=/home/hermes/backups/united/LAST_SUCCESS` to the app's `.env.local` too
   and `pm2 restart united-erp --update-env`, so `/api/health/deep` reports the last backup.
5. **First run by hand:** `set -a; . ~/.config/united-backup.env; set +a; scripts/ops/backup-pg-dump.sh`
   → `ok: united-<stamp>.dump.age (<bytes>)`. It refuses (exit 2) on a world-readable pgpass,
   `PGPASSWORD` in the environment, no recipient, or a `pg_dump` older than the server.

### 4.2 Schedule (systemd timer, 02:30 Cairo time)

`/etc/systemd/system/united-backup.service`:
```ini
[Unit]
Description=UNITED ERP encrypted pg_dump
After=network-online.target
[Service]
Type=oneshot
User=hermes
EnvironmentFile=/home/hermes/.config/united-backup.env
ExecStart=/home/hermes/releases/current/scripts/ops/backup-pg-dump.sh
Nice=10
```
`/etc/systemd/system/united-backup.timer`:
```ini
[Unit]
Description=Daily UNITED ERP backup
[Timer]
OnCalendar=*-*-* 02:30:00 Africa/Cairo
Persistent=true
[Install]
WantedBy=timers.target
```
`sudo systemctl daemon-reload && sudo systemctl enable --now united-backup.timer`;
check with `systemctl list-timers united-backup*` and `journalctl -u united-backup --since today`.
(Point `ExecStart` at a stable path — a `current` symlink or a copy of the script outside the
release folders — so a release switch never breaks the schedule.)

### 4.3 Off-site copy and retention

- The VPS keeps 30 days (never fewer than the 7 newest). Copy each new `*.dump.age` +
  `.sha256` off the VPS daily (the owner's Mac via `rsync` pull, or an object store bucket with
  its own retention). The files are encrypted; the private key is not on the VPS.
- Keep monthly copies for 12 months off-site (accounting records).

---

## 5. Monthly restore test

A backup that has never been restored is a hope, not a backup. Monthly, on the owner's Mac (local
Postgres 17, the age identity file present) — same approach as
`~/UNITED_FINAL_BACKUP_20261102/metadata/restore-test.sh`:

```bash
AGE_IDENTITY=~/united-backup-identity.txt BACKUP_DIR=~/backups/united \
RESTORE_PGPORT=5432 EXPECTED_MIGRATIONS=<count from /api/health/deep> \
  scripts/ops/verify-restore.sh                 # newest dump; or pass a file
```
It verifies the checksum, decrypts to a private temp dir, restores into a **new local** database
(it refuses any non-local host and production-looking names), checks the migration count, prints
row counts per table and that every journal entry balances, prints `PASS`/`FAIL`, and drops the
database (`KEEP=1` to inspect). Record date, dump name, migration count, `PASS` and the
`User`/`JournalEntry`/`SalesInvoice` counts in the change log. Quarterly, follow the full drill in
`BACKUP_RESTORE.md` (application fingerprint compare).

---

## 6. Database password rotation (no downtime)

Supabase's *Reset database password* invalidates the old password for **new** connections at once;
connections already open stay up. Two procedures:

**A. Standard (a few seconds of risk, no planned outage)** — for a routine rotation:
1. Prepare: on the VPS, have the editor open on `.env.local` (`DATABASE_URL`, `DIRECT_URL`) and
   `~/.pgpass`. Generate the new password in the password manager.
2. Supabase Dashboard → Project Settings → Database → *Reset database password* → paste the new one.
3. Immediately replace the password inside `DATABASE_URL`/`DIRECT_URL` in `.env.local` and in
   `~/.pgpass` (URL-encode special characters in the URLs). Never echo the file.
4. `pm2 restart united-erp --update-env` (the PM2 app name in use).
5. `curl -fsS http://127.0.0.1:3000/api/health` → `{"status":"ok"}`; sign in; check the external
   monitor saw no failure; next morning confirm the backup ran (`/api/health/deep` → `backup.ageHours`).
   Between steps 2 and 4 existing pooled connections keep serving; only a brand-new connection
   could fail, for the seconds the edit takes.

**B. Zero-risk (dual credential)** — when even seconds matter: create a second login role with the
same privileges as the app's role (SQL editor, once), switch `.env.local` to it and
`pm2 restart --update-env`, verify, *then* rotate the first role's password, and alternate at the
next rotation. Do this only after checking with Supabase docs how custom roles authenticate
through the pooler (`<role>.<project-ref>`), on a branch/staging project first.

Also rotate when: someone with VPS access leaves, a `.env*` file may have been exposed, or a
connection string was pasted anywhere (chat, ticket, screenshot).

---

## 7. GitHub hardening checklist

- [ ] **Make every UNITED repository private** (Settings → General → Danger zone → Change
      visibility). The application repository is currently public (see project memory, 2026-11-01).
      After that: treat anything ever committed as public — rotate any secret that was ever in git
      history (search: `git log -p | grep -iE 'secret|password|apikey|service_role'`).
- [ ] Owner account and every collaborator: **2FA required** (organization setting if moved to an org).
- [ ] **Protect `main` and every `release/*` branch** (Settings → Rules → Rulesets): require a pull
      request, **1 approving review**, dismiss stale approvals, require the `ci` workflow to pass,
      require branches up to date, block force-pushes and deletion, include administrators.
- [ ] **CODEOWNERS** for `prisma/migrations/`, `lib/auth.ts`, `lib/authz*.ts`, `lib/security/`,
      `middleware.ts`, `next.config.js`, `.github/` — the owner reviews those.
- [ ] Secret scanning **and push protection** on; Dependabot alerts and security updates on.
- [ ] Actions: default `GITHUB_TOKEN` permission **read-only**; allow only GitHub-owned and
      verified actions; no self-hosted runners on the production VPS.
- [ ] Review collaborators, deploy keys, OAuth/GitHub Apps with repo access; remove what is unused.
- [ ] Deploy from a tag or protected branch only; the VPS clones read-only (deploy key without
      write access).

---

## 8. Break-glass: MFA lockout

**Normal path:** an administrator opens *Users → ⋯ → Reset two-step sign-in*, gives a reason; the
user's sessions end and they enrol again at next sign-in. Audited (`mfa_reset`). A super admin
cannot reset their **own** MFA while another active super admin exists.

**Only super admin, lost phone and recovery codes** (nobody can sign in to reset): an operator with
`DIRECT_URL`, owner approval, and a record in the change log —
```sql
BEGIN;
-- 1. Identify exactly one account.
SELECT id, username, role, "mfaEnabledAt" FROM "User" WHERE username = '<username>';
-- 2. Clear its second factor and end its sessions.
UPDATE "User" SET "mfaSecret" = NULL, "mfaEnabledAt" = NULL, "mfaPendingSecret" = NULL,
       "mfaPendingAt" = NULL, "mfaLastStep" = NULL, "sessionEpoch" = "sessionEpoch" + 1
 WHERE username = '<username>';
DELETE FROM "UserMfaRecoveryCode" WHERE "userId" = '<id from step 1>';
-- 3. Leave the same trace the application would.
INSERT INTO "AuditLog" (id, "userId", "userName", role, action, "entityType", "entityId", "fieldChanged", "newValue", reason, source)
VALUES (gen_random_uuid()::text, NULL, '<operator name>', 'SYSTEM', 'mfa_reset_break_glass', 'user', '<id>', 'mfa', '<username>', '<ticket / reason>', 'system');
COMMIT;
```
Then the user signs in with their password and enrols again immediately.

If `MFA_ENCRYPTION_KEY` was lost or changed, every enrolled user is in this situation: restore the
key from the password manager rather than resetting everyone.
