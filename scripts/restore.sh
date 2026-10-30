#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${RESTIC_REPOSITORY:?Set the off-host repository}"
: "${RESTIC_PASSWORD_FILE:?Set the restic password file}"
: "${BACKUP_HELPER_IMAGE:?Set the same verified alpine helper image}"
: "${RESTORE_PROJECT:?Set a new project beginning with satvey-restore-}"
[[ "$RESTORE_PROJECT" =~ ^satvey-restore-[a-z0-9-]+$ ]] || { echo 'Use an isolated restore project.' >&2; exit 1; }
[[ "$BACKUP_HELPER_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1
started=$SECONDS
staging=$(mktemp -d "${TMPDIR:-/tmp}/satvey-restore.XXXXXXXX")
trap 'case "$staging" in "${TMPDIR:-/tmp}"/satvey-restore.*) rm -rf -- "$staging" ;; esac' EXIT
restic restore "${1:-latest}" --tag satvey-paired --target "$staging"
mapfile -t manifests < <(find "$staging" -type f -name manifest.txt)
(( ${#manifests[@]} == 1 )) || { echo 'Expected exactly one paired backup.' >&2; exit 1; }
backup=$(dirname "${manifests[0]}")
test -s "$backup/database.dump" && test -s "$backup/objects.tar" && test -s "$backup/environment.env"
# Keep the restored configuration private, and do not start web/edge or workers.
export NETWORK_SUBNET=172.31.0.0/24 EDGE_IP=172.31.0.2 WEB_IP=172.31.0.3 TRUSTED_PROXY_CIDRS=172.31.0.2/32,172.31.0.3/32
config_dir=${RESTORE_CONFIG_DIR:-/etc/satvey/restores}
mkdir -p -- "$config_dir"
restore_env="$config_dir/$RESTORE_PROJECT.env"
test ! -e "$restore_env" || { echo 'Restore configuration already exists.' >&2; exit 1; }
cp -- "$backup/environment.env" "$restore_env"
printf '\nNETWORK_SUBNET=172.31.0.0/24\nEDGE_IP=172.31.0.2\nWEB_IP=172.31.0.3\nTRUSTED_PROXY_CIDRS=172.31.0.2/32,172.31.0.3/32\n' >> "$restore_env"
compose=(docker compose --project-directory . --env-file "$restore_env" -p "$RESTORE_PROJECT" -f infra/compose.production.yaml)
if docker volume inspect "${RESTORE_PROJECT}_object_data" >/dev/null 2>&1 || docker volume inspect "${RESTORE_PROJECT}_postgres_data" >/dev/null 2>&1; then
  echo 'Refusing to restore over existing volumes.' >&2; exit 1
fi
"${compose[@]}" create rustfs
volume="${RESTORE_PROJECT}_object_data"
docker run --rm --network none --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE -v "$volume:/data" -v "$backup:/backup:ro" "$BACKUP_HELPER_IMAGE" tar -C /data -xpf /backup/objects.tar
"${compose[@]}" up -d --wait postgres rustfs pdf
"${compose[@]}" exec -T postgres pg_restore -U satvey -d satvey --exit-on-error --no-owner < "$backup/database.dump"
"${compose[@]}" run --rm migrate
"${compose[@]}" run --rm --no-deps api verify-restore
elapsed=$((SECONDS-started))
echo "Restored project $RESTORE_PROJECT verified in $elapsed seconds. No public listeners or workers were started."
(( elapsed <= 14400 )) || { echo 'Restore exceeded the four-hour target.' >&2; exit 1; }
