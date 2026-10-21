#!/usr/bin/env bash
# Runtime oracle: seed -> start Rails (127.0.0.1:3000, pid file) + Sidekiq -> capture HTTP + UI -> stop.
# Run as: timeout 2700 /workspace/ruby-service-investigator/oracle.sh
set -euo pipefail
W=/workspace/ruby-service-investigator
SRC=$W/src
OUT=/project-workspace/migrations/open-banking-rails/oracle
PIDFILE=$SRC/tmp/pids/oracle-server.pid
SKPID=$SRC/tmp/pids/oracle-sidekiq.pid
INIT=$SRC/config/initializers/zz_oracle_fakes.rb

source $W/env.sh
export RAILS_ENV=development ORACLE_FAKES=1 DISABLE_DATABASE_ENVIRONMENT_CHECK=1
cd "$SRC"

cleanup() {
  set +e
  echo "[oracle] cleanup"
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
  [ -f "$SKPID" ] && kill "$(cat "$SKPID")" 2>/dev/null
  sleep 3
  [ -f "$PIDFILE" ] && kill -9 "$(cat "$PIDFILE")" 2>/dev/null
  [ -f "$SKPID" ] && kill -9 "$(cat "$SKPID")" 2>/dev/null
  pkill -f "puma.*127.0.0.1:3000" 2>/dev/null
  rm -f "$PIDFILE" "$SKPID" "$INIT"
}
trap cleanup EXIT INT TERM

mkdir -p "$OUT/http" "$OUT/ui" tmp/pids
rm -f "$OUT"/http/*.json "$OUT"/ui/*

echo "[oracle] reset + seed development DB"
bin/rails db:drop db:create db:schema:load db:seed >/dev/null 2>&1
bin/rails runner $W/scripts/oracle_seed.rb $W/oracle_fixture.json 2>&1 | grep -E "showcase|counts" || true
cp $W/oracle_fixture.json "$OUT/fixture.json"
$W/runtime/redis-cli flushall >/dev/null

cp $W/oracle/zz_oracle_fakes.rb "$INIT"
echo "[oracle] start sidekiq + rails server"
bundle exec sidekiq -C config/sidekiq.yml > $W/oracle-sidekiq.log 2>&1 &
echo $! > "$SKPID"
bin/rails server -b 127.0.0.1 -p 3000 -P "$PIDFILE" > $W/oracle-server.log 2>&1 &

for i in $(seq 1 90); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/up; then echo "[oracle] server up after ${i}s"; break; fi
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:3000/up || { echo "server did not start"; tail -50 $W/oracle-server.log; exit 1; }

cd $W/oracle
node capture.mjs http://127.0.0.1:3000 $W/oracle_fixture.json "$OUT" main

echo "[oracle] give background jobs a moment, then record job outcomes"
sleep 20
cd "$SRC"
bin/rails runner 'require "json"; OperationRun.order(:id).each { |r| puts r.attributes.to_json }' 2>/dev/null | grep '^{' > "$OUT/operation_runs_after_capture.jsonl" || true

echo "[oracle] first-run setup capture (truncate users)"
PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -U $POSTGRES_USER open_banking_rails_development -q -c "TRUNCATE users RESTART IDENTITY CASCADE"
cd $W/oracle
node capture.mjs http://127.0.0.1:3000 $W/oracle_fixture.json "$OUT" setup
cp $W/oracle-server.log "$OUT/server.log.txt" 2>/dev/null || true
echo "[oracle] done"
