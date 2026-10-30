#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${RESTIC_REPOSITORY:?Set an off-host encrypted restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set a protected restic password file}"
: "${BACKUP_HELPER_IMAGE:?Set a verified alpine image by digest}"
[[ "$BACKUP_HELPER_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Pin BACKUP_HELPER_IMAGE by digest.' >&2; exit 1; }
compose=(docker compose --project-directory . --env-file .env.production -f infra/compose.production.yaml)
staging=$(mktemp -d "${TMPDIR:-/tmp}/satvey-backup.XXXXXXXX")
paused=0
resume() {
  local previous=$?
  if (( paused )); then
    "${compose[@]}" up -d --wait rustfs api || previous=1
  fi
  case "$staging" in "${TMPDIR:-/tmp}"/satvey-backup.*) rm -rf -- "$staging" ;; esac
  exit "$previous"
}
trap resume EXIT
paused=1
"${compose[@]}" stop api
"${compose[@]}" exec -T postgres pg_dump -U satvey -d satvey -Fc > "$staging/database.dump"
"${compose[@]}" stop rustfs
storage_container=$("${compose[@]}" ps -aq rustfs)
volume=$(docker inspect "$storage_container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
[[ -n "$volume" ]] || { echo 'Object volume not found.' >&2; exit 1; }
docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH -v "$volume:/data:ro" -v "$staging:/backup" "$BACKUP_HELPER_IMAGE" tar -C /data -cf /backup/objects.tar .
cp -- .env.production "$staging/environment.env"
date -u +%FT%TZ > "$staging/manifest.txt"
git rev-parse HEAD >> "$staging/manifest.txt"
"${compose[@]}" up -d --wait rustfs api
paused=0
# Application downtime ends before the off-host upload begins.
restic backup "$staging" --tag satvey-paired
restic forget --group-by host,tags --tag satvey-paired --keep-daily 30 --prune
restic check
echo 'Encrypted paired backup completed.'
