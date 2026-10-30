# Architecture and ownership

Satvey is a modular monolith: one Go deployment, one browser application, PostgreSQL transactions, private object storage, durable database queues, and a private PDF renderer. Splitting runtime services would complicate the evidence/review/finalisation transactions for the initial single-host deployment.

## API boundaries

`cmd/server` contains process entry only. Independent internal packages own identity/password policy, catalog normalization and CSV parsing, quality definitions and validation, report geometry/signatures, configuration, authenticated secret encryption, SMTP delivery, and integration network policy. These packages do not import `app`.

`internal/app` composes HTTP handlers, database access, adapters and workers. Cross-feature transactions deliberately remain here: adopting property facts invalidates review/worker generations, finalisation locks evidence and freezes a report, and deletion queues storage cleanup atomically. Do not move one side of these transactions behind an independent connection or service. Local type aliases preserve existing JSON and snapshot compatibility while domain ownership moves into the independent packages.

Migrations and report templates/fonts remain embedded beside their application consumers. Existing migrations are immutable; new changes append migrations. The migration command serializes SQL under its existing advisory lock, then converts legacy plaintext SSO credentials under a separate transaction/advisory lock. Provision `APP_ENCRYPTION_KEY` before upgrading an installation with SSO secrets.

## Browser boundaries

The workspace shell, authentication, inspection list/creation, dossier, capture, observation review and report have separate modules. Administration features load on demand; shared labels and small fields stay independent of those modules. Transport and domain types are separate.

Resources cancel superseded requests and guard publication against stale responses. Cache keys include user and organisation. IndexedDB version two preserves version-one data and adds cross-tab leases. Queue insertion and deleted-inspection checks share a read/write transaction. Synchronization acquires a per-scope lease, renews it during uploads, aborts on scope changes and backs off transient failures. Version conflicts retain local text for explicit resolution. Device storage failure must never be presented as a successful save.

## Operational boundaries

Production traffic follows Caddy → unprivileged Nginx → Go. Only Caddy publishes ports. Only configured proxy addresses may influence client-IP throttling. Nginx applies same-origin browser policy and does not proxy internal metrics.

Configurable OIDC and VERA destinations require exact deployment-approved HTTPS hosts. DNS addresses are checked and dialed directly, preventing a second lookup from redirecting requests to an unapproved private address. Redirects are refused; approved private hosts are a separate explicit subset. Baseten retains its fixed public endpoint.

Mail jobs encrypt recipient/link payloads at rest; password reset tokens themselves are stored as hashes. Mail delivery is at least once across crashes, while links are single-use. Sent and cancelled mail payloads are removed. Production never manufactures mock findings after a provider failure.
