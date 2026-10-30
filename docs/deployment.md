# Single-host production deployment

Target Linux Docker Engine/Compose, 8 vCPUs, 16 GiB RAM and SSD storage. Reserve disk for evidence growth and encrypted backup staging. Development Compose and Keycloak's development profile are not production manifests.

## Provision

1. Build the API from `apps/api` and the frontend from the root Dockerfile. Scan them and publish reviewed images to your registry. Resolve these and Caddy, PostgreSQL 18, RustFS 1.0.4 and Gotenberg 8.39.0 to `repository@sha256:digest` references. Deployment rejects mutable references.
2. Copy `infra/.env.production.example` to root `.env.production`, protect it with mode 600, and fill its values. Generate separate random 32-byte base64 application/property keys. Use random database/object secrets of at least 20 characters. URL-encode the database password in `DATABASE_URL`; it must match `POSTGRES_PASSWORD`.
3. Point `APP_DOMAIN` DNS at the host and permit inbound TCP 80/443. Set matching HTTPS `APP_URL` and certificate contact. Persist Caddy's certificate volumes.
4. Configure a verified SMTP sender, STARTTLS or implicit TLS, and provider authentication as required. Set the Baseten server key. Production requires both image and transcription providers; outages remain recoverable through explicit manual review.
5. Set exact `INTEGRATION_ALLOWED_HOSTS` for enabled OIDC/VERA systems, including separate token/JWKS/authorization hosts. Leave empty when neither is enabled. Private destinations additionally require their hostname in `INTEGRATION_PRIVATE_HOSTS`. Wildcards are unsupported.

Values go only to server containers, never frontend build arguments. Protect Docker access and environment files; inspection privileges can read process configuration. Do not expose database, storage administration, API, metrics or PDF ports.

## Deploy and upgrade

Run `bash scripts/deploy.sh` from a protected checkout with Node 22.12+, Docker and Compose. It validates images/configuration, starts dependencies, runs migrations/storage initialization, then waits for application/HTTPS services. It does not seed demo records or create accounts.

For the first administrator, run the API `bootstrap` command with the production manifest/environment and explicit `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `BOOTSTRAP_ORG` and `BOOTSTRAP_ORG_NAME`. Use a protected environment file or secret manager to avoid shell-history disclosure. Bootstrap refuses existing accounts/organisations.

Before upgrades, take a paired backup and retain previous image digests and keys. Migrations append; there are no automatic down migrations. For an application rollback compatible with the schema, restore prior API/web digests and redeploy. Otherwise restore the paired backup into a separate verified project before switching traffic. Never guess at a destructive down migration.

The default private subnet is `172.30.0.0/24`, with Caddy/Nginx at `.2`/`.3`. If it conflicts with host routing, change `NETWORK_SUBNET`, `EDGE_IP`, `WEB_IP`, and `TRUSTED_PROXY_CIDRS` together.

## Operate

`/api/v1/health/live` checks the process; `/api/v1/health/ready` and compatibility `/health` check database, private bucket and PDF renderer. External AI outages do not prevent manual work. `/internal/metrics` exposes request/error counts and job counts/age. Scrape it on the private Docker network and install `infra/alerts.yaml` into monitoring; route alerts to the operator's configured destination.

Investigate readiness failures by dependency, HTTP errors by request ID, and old/failed jobs by worker kind. Preserve evidence; retry transient failures or use manual continuation. Do not reset versions or clear queues to hide failures. Review disk/memory, backup timer failures and the newest successful off-host snapshot daily.

API request logs omit query strings, bodies and token-bearing paths. Nginx access logs retain only IDs/method/status/timing, and its raw-URI error entries are suppressed below critical severity. Caddy filters request fields from runtime logs. Browser traces can contain credentials/screenshots; restrict access and retention. The single host is a failure domain. Daily backups permit up to 24 hours of data loss and a four-hour restore; they do not provide high availability.
