#!/bin/bash
# capture.sh <slice> <label...>: take a live traffic capture and rebuild
# the site. Designed to run unattended from cron: sources .env for the
# TomTom key, logs to data/capture.log, and leaves the repo pushed if
# credentials allow. A failed push is not fatal; the capture stays on
# disk for the next manual run.
set -uo pipefail
cd "$(dirname "$0")/.."

slice="${1:?usage: capture.sh <slice> <label...>}"
shift
label="${*:-$slice}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> data/capture.log; }

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

log "capture start: slice=$slice"
# Fresh environments (CI) need grid, osm, and water before a capture
# can read anchor locations.
if ! npx -y tsx scripts/pipeline.ts --prepare >> data/capture.log 2>&1; then
  log "prepare FAILED"
  exit 1
fi
if ! npx -y tsx scripts/fetchTraffic.ts "$slice" "$label" >> data/capture.log 2>&1; then
  log "capture FAILED"
  exit 1
fi
npx -y tsx scripts/pipeline.ts >> data/capture.log 2>&1 || { log "pipeline FAILED"; exit 1; }
npx -y tsx scripts/buildShareCard.ts >> data/capture.log 2>&1 || log "sharecard failed (non-fatal)"

git add docs/ "data/traffic-${slice}.json"
if git commit -q -m "chore(data): $label traffic capture"; then
  if git push -q origin HEAD >> data/capture.log 2>&1; then
    log "pushed"
  else
    log "push FAILED (capture committed locally)"
  fi
else
  log "nothing to commit"
fi
log "capture done"
