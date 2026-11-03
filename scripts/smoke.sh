#!/usr/bin/env bash
# API smoke test against a running dev server + mock Gemini. Usage: scripts/smoke.sh [base]
set -euo pipefail
BASE=${1:-http://localhost:5173}
F=scripts/fixtures/sample.mp4
SZ=$(stat -c%s "$F")
j() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
R=$(curl -s "$BASE/api/analyses" -H 'content-type: application/json' \
  -d "{\"sizeBytes\":$SZ,\"mimeType\":\"video/mp4\",\"durationS\":60,\"playerDescription\":\"blue shirt near court\",\"consent\":true}")
ID=$(echo "$R" | j '["id"]'); URL=$(echo "$R" | j '["uploadUrl"]')
FN=$(curl -s -X POST "$URL" -H 'X-Goog-Upload-Offset: 0' -H 'X-Goog-Upload-Command: upload, finalize' --data-binary @"$F" | j '["file"]["name"]')
curl -s "$BASE/api/analyses/$ID/complete" -H 'content-type: application/json' -d "{\"fileName\":\"$FN\"}" >/dev/null
# duplicate complete must be harmless
curl -s "$BASE/api/analyses/$ID/complete" -H 'content-type: application/json' -d "{\"fileName\":\"$FN\"}" >/dev/null
for i in $(seq 1 60); do
  S=$(curl -s "$BASE/api/analyses/$ID" | j '["state"]')
  echo "poll $i: $S"
  [[ "$S" == READY || "$S" == FAILED ]] && break
  sleep 2
done
curl -s "$BASE/api/analyses/$ID" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("headline:", d["report"]["summary"]["headline"] if d["report"] else d["error"])'
[[ "$S" == READY ]]
