#!/usr/bin/env bash
# Smoke: start persistent analyst session briefly, curl UI, stop.
# Opt-in only — sets DSH_DATA_PRODUCT_COMPOSITION=webapp.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PORT="${DSH_ANALYST_PORT:-3091}"
HOME_DIR="${DSH_HOME:-$ROOT/.dsh-home-smoke}"
LOG="${DSH_ANALYST_SMOKE_LOG:-/tmp/dsh-analyst-session-smoke.log}"
rm -f "$LOG"
mkdir -p "$HOME_DIR"
WORKSPACE_DIR="${DSH_DATA_WORKSPACE:-$HOME_DIR/workspace}"
mkdir -p "$WORKSPACE_DIR"

export DSH_DATA_PRODUCT_COMPOSITION=webapp
export DSH_HOME="$HOME_DIR"
export DSH_DATA_WORKSPACE="$WORKSPACE_DIR"
export DSH_ANALYST_HOST=127.0.0.1
export DSH_ANALYST_PORT="$PORT"
export DSH_ANALYST_OPEN=0

npm run build >/dev/null
node scripts/serve-analyst-session.mjs >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill -TERM "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for readiness JSON + optional dsh web URL line
URL=""
for _ in $(seq 1 60); do
  if grep -q '"serving":true' "$LOG" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo '{"ok":false,"error":"serve process exited early"}'
    tail -50 "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done

if ! grep -q '"serving":true' "$LOG"; then
  echo '{"ok":false,"error":"timeout waiting for serving JSON"}'
  tail -50 "$LOG" >&2
  exit 1
fi

# Prefer authenticated URL from dsh; fall back to loopback root
if URL_LINE=$(grep -E '^dsh web: ' "$LOG" | tail -1); then
  URL=$(echo "$URL_LINE" | sed -E 's/^dsh web: ([^ ]+).*/\1/')
else
  URL="http://127.0.0.1:${PORT}/"
fi

COOKIE_JAR="${DSH_ANALYST_SMOKE_COOKIE:-/tmp/dsh-analyst-session-smoke.cookies}"
rm -f "$COOKIE_JAR"
HTML="${DSH_ANALYST_SMOKE_HTML:-/tmp/dsh-analyst-session-smoke.html}"

# Token URL mints a cookie and 303s to /. Probe both exchange and index.
CODE=""
INDEX_CODE=""
for _ in $(seq 1 20); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" --max-time 2 "$URL" || echo 000)
  if [[ "$CODE" == "303" || "$CODE" == "302" || "$CODE" == "307" || "$CODE" == "200" ]]; then
    INDEX_CODE=$(curl -sS -o "$HTML" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" --max-time 5 "http://127.0.0.1:${PORT}/" || echo 000)
    if [[ "$INDEX_CODE" == "200" ]] && grep -q 'dsh-client-modules' "$HTML" && grep -q 'dsh-api-remotes' "$HTML" && grep -q 'dsh-data-viz' "$HTML"; then
      echo "{\"ok\":true,\"pid\":$PID,\"port\":$PORT,\"httpStatus\":$CODE,\"indexStatus\":$INDEX_CODE,\"dshHome\":\"$HOME_DIR\",\"log\":\"$LOG\"}"
      exit 0
    fi
  fi
  sleep 0.5
done

echo "{\"ok\":false,\"error\":\"UI probe failed\",\"httpStatus\":\"$CODE\",\"indexStatus\":\"$INDEX_CODE\",\"log\":\"$LOG\"}"
tail -80 "$LOG" >&2
exit 1
