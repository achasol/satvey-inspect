#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
test -f .env.production || { echo 'Create .env.production first.' >&2; exit 1; }
# Read values as data, never source an environment file as shell code.
node scripts/validate-production.mjs
compose=(docker compose --project-directory . --env-file .env.production -f infra/compose.production.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" run --rm --no-deps api check-config
"${compose[@]}" up -d --wait postgres rustfs pdf
"${compose[@]}" run --rm migrate
"${compose[@]}" run --rm storage-init
"${compose[@]}" up -d --wait api web edge
app_url=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; import {parseEnv} from "node:util"; process.stdout.write(parseEnv(readFileSync(".env.production","utf8")).APP_URL.replace(/\/$/,""))')
curl --fail --show-error --retry 12 --retry-all-errors --retry-delay 5 --max-time 10 "$app_url/api/v1/health/ready"
echo 'Deployment healthy. Verify login, an existing dossier and its PDF before opening access.'
