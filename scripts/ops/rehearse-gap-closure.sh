#!/bin/bash
# Rehearses the accounting gap-closure migrations on THROWAWAY databases of a LOCAL test
# cluster — never on a shared or production database (it refuses any host but 127.0.0.1 /
# localhost, and every database it touches is named united_test_rb*):
#   1. fresh database at migration 71 (before the release) and fresh at 77 (with it);
#   2. a third at 77, seeded (tests/reset-db.ts) and filled with demo traffic through a
#      throwaway server on port 3301 (scripts/dev/demo-data.ts);
#   3. rollback (scripts/ops/gap-closure-rollback.sql) → schema must equal fresh-71 and the
#      data fingerprint must be unchanged; preflight (gap-closure-preflight.sql) must be empty;
#   4. `prisma migrate deploy` again → schema must equal fresh-77, data unchanged.
# Needs: DATABASE_URL of the local test cluster (a role allowed to CREATE DATABASE), a
# production build (`npm run build`), JWT_SECRET for the throwaway server.
set -u
cd "$(dirname "$0")/../.."
PG=${PG_BIN:-/usr/lib/postgresql/16/bin}
B=${DATABASE_URL%/*}
case "$B" in *@127.0.0.1:*|*@localhost:*|*//127.0.0.1:*|*//localhost:*) ;; *) echo "refusing: DATABASE_URL is not a local cluster"; exit 2;; esac
W=$(mktemp -d)
P() { $PG/psql "$B/$1" -v ON_ERROR_STOP=1 -qtA "${@:2}"; }
on() { DATABASE_URL=$B/$1 DIRECT_URL=$B/$1 "${@:2}"; }
for d in united_test_rb71 united_test_rb77 united_test_rbround; do P postgres -c "DROP DATABASE IF EXISTS $d WITH (FORCE)" -c "CREATE DATABASE $d" >/dev/null; done
mkdir -p $W/prisma/migrations && cp prisma/schema.prisma $W/prisma/ && cp prisma/migrations/migration_lock.toml $W/prisma/migrations/
for m in $(ls prisma/migrations | grep '^2'); do [[ "$m" > "20261030131000_function_search_path" ]] || cp -r prisma/migrations/$m $W/prisma/migrations/; done
on united_test_rb71 npx prisma migrate deploy --schema $W/prisma/schema.prisma | tail -1
on united_test_rb77 npx prisma migrate deploy | tail -1
on united_test_rbround npx prisma migrate deploy | tail -1
on united_test_rbround env UNITED_TEST_DB=1 npx tsx tests/reset-db.ts > $W/seed.log 2>&1; echo "seed=$?"
# setsid execs in place (a background job is not a group leader), so $! leads its own
# process group and `kill -- -$SRV` stops npm, next and its workers together.
DATABASE_URL=$B/united_test_rbround DIRECT_URL=$B/united_test_rbround STORAGE_PROVIDER=local setsid npx next start -p 3301 > $W/server.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -o /dev/null -w "%{http_code}" http://localhost:3301/api/health 2>/dev/null | grep -q 200 && break; sleep 2; done
on united_test_rbround env BASE=http://localhost:3301 UNITED_TEST_DB=1 npx tsx scripts/dev/demo-data.ts > $W/demo.log 2>&1; echo "demo=$? ($(tail -1 $W/demo.log))"
kill -- -$SRV 2>/dev/null; sleep 2
curl -s -o /dev/null --max-time 3 http://localhost:3301/api/health && echo "warning: throwaway server still up (pgid $SRV)"
dump() { $PG/pg_dump -s --no-owner --no-privileges "$B/$1" | grep -v '^--\|^\\restrict\|^\\unrestrict\|^SET \|^SELECT pg_catalog' | sed '/^$/d' > $W/$2; }
fp() { P united_test_rbround -c "SELECT 'Account', count(*), md5(string_agg(id||code||name||type||coalesce(\"parentId\",'')||coalesce(\"systemKey\",''), ',' ORDER BY id)) FROM \"Account\" WHERE id NOT IN ('acc_1700','acc_2250','acc_4300','acc_6400','acc_6500')
 UNION ALL SELECT 'JournalEntry', count(*), md5(string_agg(id||number||date||\"sourceType\"||\"sourceId\"||total, ',' ORDER BY id)) FROM \"JournalEntry\"
 UNION ALL SELECT 'JournalLine', count(*), md5(string_agg(id||\"entryId\"||\"accountId\"||debit||credit, ',' ORDER BY id)) FROM \"JournalLine\"
 UNION ALL SELECT 'CashAccount', count(*), md5(string_agg(id||code||\"accountId\"||type, ',' ORDER BY id)) FROM \"CashAccount\"
 UNION ALL SELECT 'AccountingPeriod', count(*), md5(coalesce(string_agg(code||status, ',' ORDER BY code), '')) FROM \"AccountingPeriod\"
 UNION ALL SELECT 'SalesInvoice', count(*), '' FROM \"SalesInvoice\" UNION ALL SELECT 'StockMovement', count(*), '' FROM \"StockMovement\" UNION ALL SELECT 'User', count(*), '' FROM \"User\""; }
fp > $W/fp0; echo "--- data before rollback"; cat $W/fp0
P united_test_rbround -1 -f scripts/ops/gap-closure-rollback.sql; echo "rollback=$?"
fp > $W/fp1; dump united_test_rb71 s71; dump united_test_rbround r71
echo "schema after rollback = fresh 71: $(diff -q $W/s71 $W/r71 >/dev/null && echo YES || echo NO)"
echo "data after rollback unchanged:    $(diff -q $W/fp0 $W/fp1 >/dev/null && echo YES || echo NO)"
echo "preflight rows (must be 0):       $(P united_test_rbround -f scripts/ops/gap-closure-preflight.sql | grep -v '^[0-9]\.\|^Preflight\|^$' | wc -l)"
on united_test_rbround npx prisma migrate deploy | tail -1
fp > $W/fp2; dump united_test_rb77 s77; dump united_test_rbround r77
echo "schema after re-apply = fresh 77: $(diff -q $W/s77 $W/r77 >/dev/null && echo YES || echo NO)"
echo "data after re-apply unchanged:    $(diff -q $W/fp0 $W/fp2 >/dev/null && echo YES || echo NO)"
for d in united_test_rb71 united_test_rb77 united_test_rbround; do P postgres -c "DROP DATABASE IF EXISTS $d WITH (FORCE)" >/dev/null; done
rm -rf $W
