#!/usr/bin/env bash
# Final acceptance run: builds nothing (run `npm run build` first), starts the REAL api + web on scratch data seeded with
# demo data, runs the browser acceptance tests, the cross-origin attack simulation and the worker smoke test, then cleans up.
#   npm run build && npm run e2e
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
API_PORT="${E2E_API_PORT:-4010}"; WEB_PORT="${E2E_WEB_PORT:-3010}"; KEY="e2e-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export E2E_WEB="http://127.0.0.1:$WEB_PORT" E2E_API_KEY="$KEY"
PIDS=()
# Servers run in their own process GROUPS (setsid) so cleanup kills the real node children, not just a wrapper shell.
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; done; sleep 1; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT
# Never test a stack other than the one this script starts.
for url in "http://127.0.0.1:$API_PORT/api/status" "$E2E_WEB/"; do
  if curl -s -o /dev/null --max-time 2 "$url"; then echo "port already in use ($url): stop that process or set E2E_API_PORT/E2E_WEB_PORT"; exit 1; fi
done
FAIL=0

echo "== seeding demo data in $WORK"
(cd "$ROOT/server" && DATA_DIR="$WORK" npx tsx scripts/seed-demo.ts >/dev/null) || { echo "seed failed"; exit 1; }

echo "== starting api :$API_PORT and web :$WEB_PORT"
setsid bash -c 'cd "$1/server" && exec env DATA_DIR="$2" API_KEY="$3" API_PORT="$4" WEB_ORIGIN="$5" node dist/index.js' _ "$ROOT" "$WORK" "$KEY" "$API_PORT" "$E2E_WEB" >"$WORK/api.log" 2>&1 & PIDS+=($!)
setsid bash -c 'cd "$1/web" && exec env API_URL="http://127.0.0.1:$2" API_KEY="$3" npx next start -p "$4" -H 127.0.0.1' _ "$ROOT" "$API_PORT" "$KEY" "$WEB_PORT" >"$WORK/web.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/api/status" >/dev/null && curl -sf "$E2E_WEB/" >/dev/null && break; sleep 1; done
curl -sf "$E2E_WEB/" >/dev/null || { echo "stack did not start"; tail -5 "$WORK/api.log" "$WORK/web.log"; exit 1; }

mkdir -p "$ROOT/e2e/out"

# Each step's own exit status decides pass/fail (never a pipeline's last command).
step() { # name, command...
  local name="$1"; shift
  echo "== $name"
  "$@" >"$WORK/step.txt" 2>&1; local rc=$?
  grep -E "^FAIL|checks passed|ATTACK|open paper positions" "$WORK/step.txt" | sed 's/^/   /'
  if [ $rc -ne 0 ]; then echo "   -> FAILED (exit $rc)"; tail -5 "$WORK/step.txt" | sed 's/^/      /'; FAIL=1; fi
}
# Order matters: the attack simulation needs the demo's open position, which the dashboard test then closes by hand.
step "1/3 cross-origin attack simulation (real browser)" node "$ROOT/e2e/csrf.cjs"
step "2/3 dashboard acceptance (real browser)"            node "$ROOT/e2e/dashboard.cjs" "$ROOT/e2e/out"
step "3/3 worker process smoke test"                      node "$ROOT/e2e/worker-smoke.cjs"
[ "$FAIL" = 0 ] && echo "== ACCEPTANCE: PASS" || echo "== ACCEPTANCE: FAIL"
exit $FAIL
