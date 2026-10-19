#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restore rehearsal for docs/backup-restore.md.
#
# STATUS: written but NOT yet run against a live Docker daemon. Expect to fix small
# things on first use, and please report what broke.
#
# What it does, in an isolated Compose project so your real stack is never touched:
#   1. starts a throwaway stack (own project name, own volumes, own port, own .env)
#   2. pauses so YOU create two users/businesses (and optionally attach a statement)
#   3. records a "security fingerprint": RLS flags, policies, riffle_app grants and role
#      attributes, per-table row counts, what riffle_app can see with no tenant context,
#      and a checksum of every file in the statement vault
#   4. runs the BACKUP commands from the guide
#   5. destroys the stack and its volumes (`down -v`)
#   6. runs the RESTORE commands from the guide, in the guide's order
#   7. re-records the fingerprint and diffs it against step 3
#
# It answers the three open points in the guide:
#   - volume name:   discovered from Compose labels and compared with the guide's assumption
#   - restore order: checks riffle_app is absent after the wipe and present after step 2
#   - RLS survival:  before/after diff of policies, grants and riffle_app's visible rows
#
# Requirements: docker (with the compose plugin and a running daemon), curl, diff, sha256sum
# NOT for production machines. Run it on a throwaway box.
#
# Usage:   bash scripts/restore-test.sh            run the rehearsal
#          bash scripts/restore-test.sh --clean    remove everything it created
#
# Environment (all optional):
#   RIFFLE_IMAGE     image to test (default ghcr.io/fubarpie/riffle-accounting:latest)
#   RESTORE_FLAGS    pg_restore flags (default "--clean --if-exists --no-owner", as in the guide)
#   RTEST_PROJECT    Compose project name (default riffle-rtest; "riffle" is refused)
#   RTEST_PORT       host port for the web UI (default 3999)
#   RTEST_DIR        working directory (default /tmp/riffle-rtest)
#   RTEST_FORCE=1    tear down a leftover rehearsal project before starting
#   RTEST_SKIP_SEED=1  do not pause for manual data entry (much weaker test)
#   KEEP=1           leave the stack and working directory in place at the end

set -Eeuo pipefail

PROJECT="${RTEST_PROJECT:-riffle-rtest}"
PORT="${RTEST_PORT:-3999}"
WORK="${RTEST_DIR:-/tmp/riffle-rtest}"
RESTORE_FLAGS="${RESTORE_FLAGS:---clean --if-exists --no-owner}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$WORK/report.txt"

PASS=0
FAIL=0
ok()   { echo "  [PASS] $*"; PASS=$((PASS + 1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
info() { echo "  [INFO] $*"; }
step() { echo; echo "=== $* ==="; }
die()  { echo "ERROR: $*" >&2; exit 1; }

dc() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/docker-compose.yml" "$@"; }

project_volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"
}

rand_hex()    { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_base64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
envval()      { grep -E "^$1=" "$WORK/.env" | head -1 | cut -d= -f2-; }

wait_health() {
  local limit="${1:-90}" i
  for ((i = 0; i < limit; i += 2)); do
    if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# SQL on stdin, run as the database superuser (bypasses RLS, so it sees everything).
owner() {
  dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -v ON_ERROR_STOP=1'
}

fingerprint() {
  owner <<'SQL'
\echo == table security flags (rls enabled, rls forced)
select c.oid::regclass::text, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
 order by 1;
\echo == policies
select schemaname||'.'||tablename, policyname, permissive, roles::text, cmd,
       coalesce(qual,''), coalesce(with_check,'')
  from pg_policies order by 1,2;
\echo == riffle_app table grants
select table_schema||'.'||table_name, string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants where grantee = 'riffle_app'
 group by 1 order by 1;
\echo == riffle_app role (login, superuser, bypassrls)
select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'riffle_app';
\echo == row counts (as superuser)
select table_schema||'.'||table_name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables
 where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog','information_schema')
 order by 1;
SQL
}

rls_table_count() {
  owner <<'SQL'
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relrowsecurity and c.relkind in ('r','p')
   and n.nspname not in ('pg_catalog','information_schema','pg_toast');
SQL
}

gen_app_sql() {
  owner <<'SQL'
select format('select %L as tbl, count(*) as visible_rows from %s;', c.oid::regclass::text, c.oid::regclass)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relrowsecurity and c.relkind in ('r','p')
   and n.nspname not in ('pg_catalog','information_schema','pg_toast')
 order by 1;
SQL
}

# What the restricted app role sees with NO tenant context set. Errors are part of the
# answer, so they are captured and compared too. Logs in over the network with the real
# password, which also proves the restored riffle_app password works.
app_view() {
  gen_app_sql | dc exec -T -e PGPASSWORD="$APP_PW" postgres \
    psql -h postgres -U riffle_app -d "$DB" -X -q -At 2>&1 | sort || true
}

vault_volume() {
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.volume=riffle-statements"
}

vault_hash() {
  docker run --rm -v "$(vault_volume):/src:ro" alpine \
    sh -c 'cd /src && find . -type f -exec sha256sum {} + | sort -k2'
}

cleanup_all() {
  if [ -f "$WORK/docker-compose.yml" ]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
  local leftover
  leftover="$(project_volumes || true)"
  if [ -n "$leftover" ]; then echo "$leftover" | xargs docker volume rm >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}

# ----------------------------------------------------------------------------------------

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then sed -n '2,41p' "${BASH_SOURCE[0]}"; exit 0; fi
if [ "${1:-}" = "--clean" ]; then
  [ "$PROJECT" != "riffle" ] || die "refusing to touch project 'riffle'"
  cleanup_all; echo "Removed project $PROJECT and $WORK."; exit 0
fi

[ "$PROJECT" != "riffle" ] || die "RTEST_PROJECT must not be 'riffle' (that is the real stack's default)."
for tool in docker curl diff sha256sum; do command -v "$tool" >/dev/null || die "missing: $tool"; done
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
[ -f "$SRC/docker-compose.yml" ] || die "docker-compose.yml not found at $SRC (run from a repo checkout)"

if [ -n "$(project_volumes)" ] || [ -d "$WORK" ]; then
  if [ "${RTEST_FORCE:-0}" = "1" ]; then cleanup_all
  else die "leftovers from a previous run exist (project $PROJECT / $WORK). Run with --clean or RTEST_FORCE=1."; fi
fi

mkdir -p "$WORK/backups"
exec > >(tee -a "$REPORT") 2>&1
echo "Restore rehearsal started $(date -u +%FT%TZ)  project=$PROJECT  port=$PORT"
echo "Image: ${RIFFLE_IMAGE:-ghcr.io/fubarpie/riffle-accounting:latest}"
echo "pg_restore flags: $RESTORE_FLAGS"

cp "$SRC/docker-compose.yml" "$WORK/docker-compose.yml"
umask 077
cat > "$WORK/.env" <<EOF
RIFFLE_IMAGE=${RIFFLE_IMAGE:-ghcr.io/fubarpie/riffle-accounting:latest}
RIFFLE_PORT=$PORT
POSTGRES_USER=riffle
POSTGRES_DB=riffle
POSTGRES_PASSWORD=$(rand_hex 24)
RIFFLE_APP_DB_PASSWORD=$(rand_hex 24)
ALLOW_REGISTRATION=true
COOKIE_SECURE=false
RIFFLE_SECRET_KEY=1:$(rand_base64 32)
EOF
umask 022
APP_PW="$(envval RIFFLE_APP_DB_PASSWORD)"
DB="$(envval POSTGRES_DB)"
cd "$WORK"

# ---- 1. start ----------------------------------------------------------------------------
step "1. Start a throwaway stack"
if ! dc pull; then
  echo "Could not pull the image. If it is private or unpublished, build one locally and re-run with"
  echo "  RIFFLE_IMAGE=<your-local-tag> bash scripts/restore-test.sh"
  exit 1
fi
dc up -d
if wait_health 120; then ok "stack healthy at http://localhost:$PORT/healthz"; else bad "api never became healthy"; dc logs --tail 40 api || true; exit 1; fi

VOL="$(vault_volume)"
EXPECT="${PROJECT}_riffle-statements"
if [ "$VOL" = "$EXPECT" ]; then ok "vault volume is '$VOL' (= <project>_riffle-statements; the guide's riffle_riffle-statements is this pattern with project 'riffle')"
else bad "vault volume is '$VOL', expected '$EXPECT' - the guide's volume name is wrong"; fi

# ---- 2. seed -----------------------------------------------------------------------------
step "2. Seed data"
if [ "${RTEST_SKIP_SEED:-0}" != "1" ] && [ -r /dev/tty ]; then
  cat <<EOF

  Open http://localhost:$PORT in a browser and create TEST data:
    - register user A, create business "Alpha", add a couple of transactions
    - (if you can) attach a statement to a reconciliation in Alpha
    - sign out, register user B (registration is enabled for this trial), create business
      "Bravo", add a transaction
  Write down which user owns which business.

EOF
  read -r -p "  Press Enter when the data is in... " _ </dev/tty
else
  info "skipping manual seeding - the data-dependent checks below will be weak"
fi
# A marker file in the vault so the vault round-trip is checked even with no uploads.
docker run --rm -v "$VOL:/dst" alpine sh -c 'echo "rehearsal-marker $(date -u +%s)" > /dst/.rtest-marker'

# ---- 3. before fingerprint ---------------------------------------------------------------
step "3. Record the security fingerprint BEFORE backup"
fingerprint > before.fp
app_view > before.app
vault_hash > before.vault
N_RLS="$(rls_table_count | tr -d '[:space:]')"
if [ "${N_RLS:-0}" -gt 0 ]; then ok "found $N_RLS table(s) with row-level security enabled"
else bad "no RLS-enabled tables found - the isolation checks below prove nothing"; fi
FLAGS="$(owner <<'SQL'
select rolsuper::int * 2 + rolbypassrls::int from pg_roles where rolname = 'riffle_app';
SQL
)"
if [ "${FLAGS//[[:space:]]/}" = "0" ]; then ok "riffle_app is not a superuser and does not bypass RLS"
else bad "riffle_app is superuser or BYPASSRLS (flags=$FLAGS) - tenant isolation is not enforced for it"; fi
info "visible rows for riffle_app with no tenant context (before):"; sed 's/^/        /' before.app
info "row counts (before):"; sed -n '/== row counts/,$p' before.fp | sed 's/^/        /'

# ---- 4. backup (commands from the guide) ----------------------------------------------------
step "4. Backup (commands from docs/backup-restore.md)"
STAMP=$(date +%Y%m%d-%H%M%S)
dc stop api worker
dc exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "backups/riffle-db-$STAMP.dump"
docker run --rm -v "$VOL:/src:ro" -v "$PWD/backups":/out alpine \
  tar -czf "/out/riffle-statements-$STAMP.tar.gz" -C /src .
cp .env "backups/env-$STAMP" && chmod 600 "backups/env-$STAMP"
dc start api worker
for f in "riffle-db-$STAMP.dump" "riffle-statements-$STAMP.tar.gz" "env-$STAMP"; do
  if [ -s "backups/$f" ]; then ok "backup file present and non-empty: $f ($(wc -c < "backups/$f") bytes)"; else bad "backup file missing or empty: $f"; fi
done
dc stop api worker >/dev/null 2>&1 || true

# ---- 5. wipe ---------------------------------------------------------------------------------
step "5. Destroy the stack and its volumes"
dc down -v
if [ -z "$(project_volumes)" ]; then ok "all project volumes are gone"; else bad "volumes remain: $(project_volumes | tr '\n' ' ')"; fi
rm -f .env

# ---- 6. restore (commands from the guide, in the guide's order) -------------------------------
step "6. Restore (commands from docs/backup-restore.md)"
cp "backups/env-$STAMP" .env
dc up -d postgres
for i in $(seq 1 30); do dc exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break; sleep 2; done

ROLE_BEFORE="$(owner <<'SQL'
select count(*) from pg_roles where rolname = 'riffle_app';
SQL
)"
if [ "${ROLE_BEFORE//[[:space:]]/}" = "0" ]; then ok "riffle_app does NOT exist on a fresh database (so the guide's 'start the API once' step is needed)"
else bad "riffle_app already exists on a fresh database - the 'start the API once' step may be unnecessary"; fi

dc up -d api && sleep 20
if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then ok "api was healthy within the guide's 20 s wait"
else bad "api was NOT healthy after the guide's 20 s wait - the guide's 'sleep 20' is too short for this machine"; fi
dc stop api
ROLE_AFTER="$(owner <<'SQL'
select count(*) from pg_roles where rolname = 'riffle_app';
SQL
)"
if [ "${ROLE_AFTER//[[:space:]]/}" = "1" ]; then ok "riffle_app exists after the API's first start"
else bad "riffle_app was NOT created by starting the API - restore order in the guide is wrong or incomplete"; fi

set +e
dc exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" $RESTORE_FLAGS" \
  < "backups/riffle-db-$STAMP.dump" > pg_restore.log 2>&1
RC=$?
set -e
if [ "$RC" -eq 0 ]; then ok "pg_restore exited 0"
else info "pg_restore exited $RC (with --clean some warnings are normal; read the log below)"; fi
info "pg_restore output (last 25 lines):"; tail -n 25 pg_restore.log | sed 's/^/        /'

VOL="$(vault_volume)"
info "vault volume after restart: ${VOL:-<none>}"
docker run --rm -v "$VOL:/dst" -v "$PWD/backups":/in:ro alpine \
  sh -c "cd /dst && tar -xzf /in/riffle-statements-$STAMP.tar.gz"
dc up -d
if wait_health 120; then ok "stack healthy after restore"; else bad "stack not healthy after restore"; fi

# ---- 7. compare --------------------------------------------------------------------------------
step "7. Compare AFTER with BEFORE"
fingerprint > after.fp
app_view > after.app
vault_hash > after.vault

if diff -u before.fp after.fp > fp.diff; then ok "RLS flags, policies, riffle_app grants/role and row counts are identical"
else bad "database fingerprint differs after restore:"; sed 's/^/        /' fp.diff; fi
if diff -u before.app after.app > app.diff; then ok "riffle_app sees exactly what it saw before (no tenant context)"
else bad "what riffle_app can see changed after restore:"; sed 's/^/        /' app.diff; fi
if diff -u before.vault after.vault > vault.diff; then ok "statement vault files are byte-identical (incl. marker file)"
else bad "vault contents differ:"; sed 's/^/        /' vault.diff; fi

LOGBAD="$(dc logs --no-color api worker 2>&1 | grep -Ei 'error|fatal|denied|failed' | head -n 15 || true)"
if [ -z "$LOGBAD" ]; then ok "no error/denied/failed lines in api or worker logs"
else info "suspicious log lines (may be benign, please read):"; echo "$LOGBAD" | sed 's/^/        /'; fi

# ---- 8. manual checks ---------------------------------------------------------------------------
step "8. Manual checks (the script cannot do these)"
cat <<EOF

  In the browser at http://localhost:$PORT :
    [ ] sign in as user A: you see Alpha and its transactions, and NOT Bravo
    [ ] sign in as user B: you see Bravo and its transactions, and NOT Alpha
    [ ] open the reconciliation with the attached statement and download it
    [ ] reports and balances match what you saw before the backup

EOF
if [ "${RTEST_SKIP_SEED:-0}" != "1" ] && [ -r /dev/tty ]; then
  read -r -p "  Press Enter after doing these (or Ctrl-C to keep the stack for inspection)... " _ </dev/tty
  read -r -p "  Did all manual checks pass? [y/N] " ans </dev/tty
  case "$ans" in y|Y) ok "manual tenant-isolation / statement / balance checks passed";; *) bad "manual checks reported as failing or not done";; esac
fi

step "Result"
echo "  passed: $PASS   failed: $FAIL"
echo "  full report (no secrets in it): $REPORT"
echo "  Please paste the report back, plus anything that looked wrong."

if [ "${KEEP:-0}" = "1" ]; then
  echo "  KEEP=1: leaving the stack running. Clean up later with: bash scripts/restore-test.sh --clean"
else
  cp "$REPORT" "$HOME/riffle-restore-report-$STAMP.txt"
  echo "  report copied to $HOME/riffle-restore-report-$STAMP.txt"
  cd /
  cleanup_all
  echo "  throwaway stack and working directory removed."
fi
[ "$FAIL" -eq 0 ]
