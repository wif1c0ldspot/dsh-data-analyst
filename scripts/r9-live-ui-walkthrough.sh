#!/usr/bin/env bash
# Live authenticated walkthrough of /api/analyst/ui/* on the standard web profile.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DSH_WALK_PORT:-3088}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
WORKSPACE="${DSH_DATA_WORKSPACE:-$HOME/.dsh/workspace}"
LOG="${DSH_WALK_LOG:-/tmp/dsh-r9-walkthrough.log}"
COOKIE="${DSH_WALK_COOKIE:-/tmp/dsh-r9-walkthrough.cookies}"
PIDFILE="${DSH_WALK_PID:-/tmp/dsh-r9-walkthrough.pid}"
SUMMARY="${DSH_WALK_SUMMARY:-/tmp/dsh-r9-walkthrough-summary.json}"

export DSH_HOME="$HOME_DIR"
export DSH_DATA_WORKSPACE="$WORKSPACE"

pkill -f "apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port ${PORT}" 2>/dev/null || true
sleep 1
rm -f "$LOG" "$COOKIE" "$SUMMARY"
: >"$LOG"

cd "$ROOT/deepseek-harness"
node --import tsx/esm apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port "$PORT" --no-open >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
disown || true

for _ in $(seq 1 90); do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && grep -q 'dsh web:' "$LOG"; then
    break
  fi
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo '{"ok":false,"error":"dsh exited early"}'
    tail -80 "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done

URL=$(grep -Eo "http://127\\.0\\.0\\.1:${PORT}/\\?token=[^[:space:]]+" "$LOG" | tail -1)
if [[ -z "$URL" ]]; then
  echo '{"ok":false,"error":"no token url"}'
  tail -80 "$LOG" >&2
  exit 1
fi

curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE" -b "$COOKIE" --max-time 10 "$URL" >/tmp/dsh-r9-token.code
curl -sS -o /tmp/dsh-r9-index.html -w '%{http_code}' -b "$COOKIE" -c "$COOKIE" --max-time 10 "http://127.0.0.1:${PORT}/" >/tmp/dsh-r9-index.code

DASH=$(sqlite3 "$WORKSPACE/catalog.sqlite" "SELECT dashboard_id FROM dashboards WHERE title LIKE '%shared-filter%' LIMIT 1;")
[[ -n "$DASH" ]] || DASH=$(sqlite3 "$WORKSPACE/catalog.sqlite" "SELECT dashboard_id FROM dashboards LIMIT 1;")
ANA=$(sqlite3 "$WORKSPACE/catalog.sqlite" "SELECT analysis_id FROM analysis_revisions WHERE analysis_id='ana_bf05722dbfae4dd5' LIMIT 1;")
[[ -n "$ANA" ]] || ANA=$(sqlite3 "$WORKSPACE/catalog.sqlite" "SELECT analysis_id FROM analysis_revisions LIMIT 1;")

ORIGIN=(-H "Origin: http://127.0.0.1:${PORT}" -H "Referer: http://127.0.0.1:${PORT}/")

curl -sS -D /tmp/dsh-r9-dash.hdr -o /tmp/dsh-r9-dash.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" \
  "http://127.0.0.1:${PORT}/api/analyst/ui/dashboard?dashboardId=${DASH}" >/tmp/dsh-r9-dash.code
VER=$(awk 'tolower($1)=="x-analyst-resource-version:"{print $2}' /tmp/dsh-r9-dash.hdr | tr -d '\r')

curl -sS -D /tmp/dsh-r9-ana.hdr -o /tmp/dsh-r9-ana.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" \
  "http://127.0.0.1:${PORT}/api/analyst/ui/analysis?analysisId=${ANA}" >/tmp/dsh-r9-ana.code
AVER=$(awk 'tolower($1)=="x-analyst-resource-version:"{print $2}' /tmp/dsh-r9-ana.hdr | tr -d '\r')

curl -sS -D /tmp/dsh-r9-map.hdr -o /tmp/dsh-r9-map.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:${PORT}/api/analyst/ui/dashboard/map-keys" \
  -d "{\"expectedVersion\":\"${VER}\",\"dashboardId\":\"${DASH}\",\"analysisId\":\"${ANA}\",\"keys\":[\"region\"]}" >/tmp/dsh-r9-map.code
VER2=$(awk 'tolower($1)=="x-analyst-resource-version:"{print $2}' /tmp/dsh-r9-map.hdr | tr -d '\r')

curl -sS -D /tmp/dsh-r9-exp.hdr -o /tmp/dsh-r9-exp.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:${PORT}/api/analyst/ui/analysis/export" \
  -d "{\"analysisId\":\"${ANA}\"}" >/tmp/dsh-r9-exp.code

curl -sS -D /tmp/dsh-r9-ana2.hdr -o /dev/null -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" \
  "http://127.0.0.1:${PORT}/api/analyst/ui/analysis?analysisId=${ANA}" >/tmp/dsh-r9-ana2.code
AVER2=$(awk 'tolower($1)=="x-analyst-resource-version:"{print $2}' /tmp/dsh-r9-ana2.hdr | tr -d '\r')

curl -sS -D /tmp/dsh-r9-409.hdr -o /tmp/dsh-r9-409.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:${PORT}/api/analyst/ui/dashboard/map-keys" \
  -d "{\"expectedVersion\":\"${VER}\",\"dashboardId\":\"${DASH}\",\"analysisId\":\"${ANA}\",\"keys\":[\"region\"]}" >/tmp/dsh-r9-409.code

curl -sS -D /tmp/dsh-r9-filt.hdr -o /tmp/dsh-r9-filt.html -w '%{http_code}' \
  -b "$COOKIE" "${ORIGIN[@]}" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:${PORT}/api/analyst/ui/dashboard/filter" \
  -d "{\"expectedVersion\":\"${VER2}\",\"dashboardId\":\"${DASH}\",\"column\":\"region\",\"value\":\"West\"}" >/tmp/dsh-r9-filt.code
VER3=$(awk 'tolower($1)=="x-analyst-resource-version:"{print $2}' /tmp/dsh-r9-filt.hdr | tr -d '\r')

python3 - <<PY
import json, re
from pathlib import Path

def code(name):
    return Path(f'/tmp/dsh-r9-{name}.code').read_text().strip()

def actions(path):
    text = Path(path).read_text(errors='replace')
    return sorted(set(re.findall(r'data-analyst-action="([^"]+)"', text)))

def body_preview(path, n=180):
    p = Path(path)
    if not p.exists():
        return None
    return p.read_text(errors='replace')[:n]

summary = {
    "ok": True,
    "port": int("$PORT"),
    "workspace": "$WORKSPACE",
    "dashboardId": "$DASH",
    "analysisId": "$ANA",
    "tokenExchange": code("token") if Path("/tmp/dsh-r9-token.code").exists() else None,
    "index": code("index"),
    "getDashboard": code("dash"),
    "dashboardVersion": "$VER",
    "dashboardActions": actions("/tmp/dsh-r9-dash.html") if Path("/tmp/dsh-r9-dash.html").exists() else [],
    "dashboardPreview": body_preview("/tmp/dsh-r9-dash.html"),
    "getAnalysis": code("ana"),
    "analysisVersionBefore": "$AVER",
    "analysisActions": actions("/tmp/dsh-r9-ana.html") if Path("/tmp/dsh-r9-ana.html").exists() else [],
    "postMapKeys": code("map"),
    "dashboardVersionAfterMap": "$VER2",
    "postExport": code("exp"),
    "exportPreview": body_preview("/tmp/dsh-r9-exp.html"),
    "analysisVersionAfterExport": "$AVER2",
    "postMapKeysStale": code("409"),
    "postFilter": code("filt"),
    "dashboardVersionAfterFilter": "$VER3",
    "filterPreview": body_preview("/tmp/dsh-r9-filt.html"),
    "serverAlive": Path("$PIDFILE").exists(),
}
# Soft ok if core path worked
summary["ok"] = (
    summary["index"] == "200"
    and summary["getDashboard"] == "200"
    and summary["getAnalysis"] == "200"
    and "filter" in summary["dashboardActions"]
    and "export" in summary["analysisActions"]
    and summary["postMapKeys"] == "200"
    and summary["postExport"] == "200"
    and summary["analysisVersionBefore"] == summary["analysisVersionAfterExport"]
    and summary["postMapKeysStale"] == "409"
    and summary["postFilter"] == "200"
)
Path("$SUMMARY").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
raise SystemExit(0 if summary["ok"] else 2)
PY
