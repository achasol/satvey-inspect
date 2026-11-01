# Verification and release gates

## Fast checks

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test:coverage`, and `npm run build`. Frontend unit tests exercise cancellation, stale responses, scoped caches, durable drafts, concurrent queue insertion, cross-tab synchronization, conflicts, transport failures, authentication expiry, IndexedDB upgrades and account-recovery forms.

From `apps/api`, run `go vet ./...`. The backend suite includes an FFmpeg contract, so the complete suite runs inside its tooling image. A native machine without FFmpeg can run `go test -skip '^TestHostedTranscriptionContractAndAudioConversion$' ./...`; integration cases explicitly skip without isolated services. This reduced command does not certify the integration layer.

The separate Go module in `tools/vera-receiver` has its own `go test ./...` and `go vet ./...` checks. The isolated backend runner executes its race tests before the API suite.

## Isolated verification

`node scripts/test-stack.mjs` builds disposable images, creates separate Go/browser databases and buckets, initializes storage, runs Go race tests and independent PDF checks, bootstraps a browser-only administrator, then runs Chromium. `backend` and `browser` arguments run individual layers. Set `TEST_BROWSER_ARGS=--workers=1` for all five configured browser projects. The full matrix uses one worker to leave room for Firefox/WebKit and accessibility analysis within the memory budget. CI does the full matrix nightly and on manual release verification.

The stack copies code into images and writes artifacts to named volumes, avoiding Docker Desktop bind-mount failures and live-source races. Artifacts are exported into `tests/artifacts`, `test-results` and `playwright-report` before cleanup. `KEEP_TEST_STACK=1` retains only the explicitly named test project. Never combine this manifest with development or production Compose files.

On Docker 25, `SATVEY_TEST_USE_DAEMON_BUILDER=1` optionally reuses Desktop's cached base images through its classic builder, with the same hard build resource limits. This avoids duplicate large downloads into the isolated BuildKit cache. The default and CI use BuildKit; newer Docker versions without the classic builder should use the default.

Fixtures refuse databases whose names do not start with `satvey_test`, buckets not starting with `satvey-test`, or an environment other than `APP_ENV=test`. `REQUIRE_INTEGRATION=1` turns missing services into failures. Mock inference and a local SMTP capture service keep tests separate from paid inference and real recipients.

The research suite is independent: install `benchmarks/property-state/requirements.txt` and run `python -m unittest -v test_benchmark` there. Tests do not download report sources or require private images.

## VERA handover test receiver

The receiver is a useful contract and integration test target for internal handover. It implements the Satvey handover profile of the official VERA OpenAPI contracts, version `4.3.3+261002.6`: Onderhoud `defecten`, `inspectierapporten`, `onderhoudstaken`, `onderhoudsverzoeken`; Dossier `informatieobjecten`; and seeded, read-only Onderhoud `onderhoudsorders` and Vastgoed `eenheden`. Writable resources support the published collection GET/POST/PUT/PATCH and member GET/PUT/PATCH operations. VERA DELETE operations are not invented. Domain `ping` operations are also available. The deployment prefixes are `/onderhoud/v4`, `/dossier/v4` and `/vastgoed/v4`.

This is **not a certification of full VERA compliance** or a replacement for a supplier sandbox. The three complete upstream specification files are embedded unchanged, with commit, URLs, SHA-256 hashes and upstream licence in `tools/vera-receiver/receiver/specs`. Requests and responses for implemented operations are validated against those schemas, including types, patterns, formats, HTTP statuses and response bodies. Discovery at `/openapi/Onderhoud.json`, `/openapi/Dossier.json` and `/openapi/Vastgoed.json` exposes only the implemented operations. The receiver implements neither other domains/processes nor supplier-specific code lists, authorisation models or workflows. It does not perform DICO handover.

Run a standalone disposable receiver. Create the `.cache` directory first if it does not exist:

```sh
docker compose -p satvey-vera-test -f infra/compose.vera-receiver.yaml up --build -d --wait
docker compose -p satvey-vera-test -f infra/compose.vera-receiver.yaml cp vera-receiver:/tmp/vera-receiver-ca.pem .cache/vera-receiver-ca.pem
curl --cacert .cache/vera-receiver-ca.pem --user satvey-test:dummy-client-secret-only-for-tests --data grant_type=client_credentials https://localhost:8090/oauth/token
```

Use `curl.exe` in Windows PowerShell. The service binds only to the host's loopback address. Its self-signed test certificate is generated on each start and lasts seven days; trust the copied certificate only in the integration client. Supply both `VERA_RECEIVER_TLS_CERT` and `VERA_RECEIVER_TLS_KEY` for a preconfigured test certificate. The published origin in `VERA_RECEIVER_BASE_URL` must match the URI used by the client, because returned document Locations and property links use that origin. For native execution, set `VERA_RECEIVER_TEST_MODE=1`, `VERA_RECEIVER_CLIENT_ID`, `VERA_RECEIVER_CLIENT_SECRET` and `VERA_RECEIVER_CONTROL_KEY`, then run `go run .` from `tools/vera-receiver`. The default listener is `127.0.0.1:8090`; `VERA_RECEIVER_LISTEN` overrides it.

The Compose credentials above are public test fixtures. The token endpoint supports OAuth2 client credentials, explicit scopes and one-hour expiry. Its default grant includes all configured contract scopes. The pinned specifications place both `.Read` and `.ReadWrite` in the same GET security requirement; OpenAPI interprets this as AND. The dummy honours that literal contract, and `.All.ReadWrite` grants expand to the explicit domain scopes. A supplier that interprets these differently needs an agreed compatibility profile. An optional `VERA_RECEIVER_API_KEY` supports the upstream API-key alternative on `ping`; resource operations use OAuth2 as declared upstream.

The following additional receiver rules deliberately make the handover test stricter than the permissive VERA schemas:

- Creates omit `id`; the receiver assigns a new key and returns HTTP 201 with the record and Location. All writes require `idExtern`, `idOrganisatie` and `idAdministratie`. Their combination is unique within a resource, and remains immutable across PATCH/PUT. Duplicate creates return 409. Collection updates find records by receiver ID or the complete source key; member updates reject conflicting path/body keys. PATCH preserves omitted fields; PUT replaces non-key fields. Successful updates have an empty HTTP 200 body, as declared upstream.
- Unit/document URI references in handover must identify resources in this receiver. The supported report, defect, task, request and order key references must already resolve. Package-local `urn:satvey:handover:` placeholders are rejected. Create cyclic report/task/request graphs in two passes, then PATCH the associations. The receiver does not fetch external URLs. Other upstream fields remain schema-validated, but relationships outside the documented handover profile are not resolved and their business semantics are not simulated.
- Documents require `bestandsnaam`, inline base64 `bestand` and the correct decoded `bestandsgrootte`. GET returns the stored content. State inspection exposes file hashes/byte counts rather than binary content.
- Collection GET supports exact `id`, `idExtern`, `idOrganisatie`, `idAdministratie` and `code` filters, `pagina`, and opaque `cursor`. Set `X-Parameters-AantalPerPagina` to 1–100. Paging returns count/page headers and a next cursor where applicable. Writes invalidate existing collection cursors. Unsupported filters and historical queries are rejected instead of silently ignored.

Test controls require `X-Test-Control-Key: dummy-control-secret-only-for-tests` in standalone Compose. These are separate from VERA and are never part of its discovery documents:

| Operation             | Purpose                                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /_test/seed`    | Supply `{"resource":"/vastgoed/v4/eenheden","record":{"id":"unit-42","code":"42"}}` to seed a unit; use `/onderhoud/v4/onderhoudsorders` to seed an order. Fixtures must match the upstream message schema.                                                                   |
| `POST /_test/faults`  | Supply `{"method":"POST","path":"/dossier/v4/informatieobjecten","mode":"after_commit","status":503,"count":1}`. Modes are `before`, `after_commit` and `disconnect_after_commit`; statuses are 429/503/504 and counts 1–20. Rules affect matching writes in insertion order. |
| `GET /_test/state`    | Inspect counts, records, document hashes and the latest 1,000 accepted-write receipts, including the sender's reference number.                                                                                                                                               |
| `DELETE /_test/state` | Clear records, receipts and faults. IDs are not reused; existing test tokens retain their normal expiry.                                                                                                                                                                      |

Seed a unit before sending handover data and use `https://localhost:8090/vastgoed/v4/eenheden/unit-42` as its URI. The fault modes after acceptance are particularly useful: a sender must look up the full source key after a timeout or 503 before retrying a create. Otherwise it risks duplicate work in a real receiving system.

Storage is ephemeral and bounded: 8 MiB per request, 32 MiB of stored JSON, 1,000 records per resource, 128 active tokens, and 32 active fault rules. This lightweight target tests handover semantics; large-file capacity and real supplier workflows need separate tests. Stop and remove it with `docker compose -p satvey-vera-test -f infra/compose.vera-receiver.yaml down --volumes`.

`node scripts/test-stack.mjs backend` starts a separate receiver without a published port. Its generated certificate is shared read-only with the sender; all resource requests use verified TLS. The receiver's race tests run before the API suite. `TestHandoverProductionWorkerRecoveryAndAcceptance` approves a real inspection handover through the API, runs the production worker, reconciles two failures after acceptance, resumes an expired lease, checks evidence and receiver associations, and adds follow-up work without duplicating earlier records. Permission/configuration tests cover disabled destinations, immutable endpoint identity and tenant isolation. The legacy ZIP-import round-trip remains a separate compatibility test.

The isolated browser journey configures a destination and property mapping through administrator screens, creates proposals in the Overdracht tab, exercises optimistic conflicts, approves the handover and waits for actual acceptance. It asserts that no handover package is downloaded and that approved work becomes read-only. Production still needs a supplier-specific sandbox test before a real destination is enabled. Native Go runs without the receiver explicitly skip these integration tests; REQUIRE_INTEGRATION=1 requires both VERA_RECEIVER_URL and a trusted VERA_CA_FILE.

Handover job counts and oldest queued/blocked age are exposed through the existing protected metrics endpoint as `satvey_jobs{kind="vera_handover",status="..."}` and `satvey_job_oldest_seconds`. Delivery history includes attempts, next retry, safe error text and accepted receiver keys. Logs include delivery/organisation identifiers and outcomes without credentials or raw receiver response bodies.

For the existing fictional Windows demo, `./scripts/start-sleutels-demo.ps1 -VERA` adds the optional local receiver, shares its public CA with the API, and runs `scripts/connect-vera-demo.mjs`. This helper is restricted to a loopback app URL and the `desleutels-demo` organisation. It seeds receiving units and configures their mappings under **VERA testontvanger (lokaal)** without approving or sending any handovers. `PROPERTY_ENCRYPTION_KEY` must already be configured. The optional `infra/compose.vera-local.yaml` must remain included when restarting that API; the ordinary production manifests do not include the dummy. The receiver stores test data only in memory and resets on restart. Its acceptance history in Satvey records past receipt, not permanent storage in the test double.

## Before production

- Run the complete isolated suite and image/dependency/secret scans. Resolve high/critical findings with available fixes; document advisory applicability.
- Run production images through configuration rejection, Nginx validation, HTTPS login, capture/review/finalisation, PDF and media-download smoke checks.
- Upgrade a copy of the current schema and confirm migrations apply exactly once. Verify old report snapshots and SSO secret conversion.
- Validate each enabled supplier-specific VERA integration against its actual supported contract.
- Verify real iOS/Android permissions, background interruption, reload recovery, offline reconnection and annotations.
- Perform the paired backup/restore drill in `recovery.md` and record elapsed time.
- Run a 30-minute capacity test for 25 concurrent inspectors on an 8-vCPU, 16-GiB RAM, SSD reference host. Ordinary API p95 must be below 500 ms. Use a reviewed report containing 30 photos for the PDF p95 target of 60 seconds. Observe queue age/failures and memory, and verify uploaded IDs/content afterwards. Simulate provider delay/outages with isolated adapters; measure external inference latency separately.

`scripts/load-test.mjs` runs concurrent capture, ordinary API requests, duplicate upload retries, and PDF rendering, then checks stored media IDs/content hashes and the frozen report snapshot. It creates dedicated inspection fixtures and writes `tests/artifacts/load.json`. Supply `LOAD_BASE_URL`, dedicated `LOAD_EMAIL`/`LOAD_PASSWORD`, `ALLOW_LOAD_TEST=1`, a representative JPEG/PNG `LOAD_PHOTO`, and a frozen 30-photo `LOAD_REPORT_ID`. It can discover a linked property/published format, or accept explicit `LOAD_PROPERTY_ID`/`LOAD_FORMAT_ID`. Default duration is 1,800 seconds with 25 clients. It requests mock inference unless `LOAD_LIVE_AI=1` is explicitly supplied; that option can incur provider charges. `LOAD_MODE=read` runs a narrower read-only smoke check and never counts as a reference capacity run. Observe queue age/memory with internal metrics alongside the generated report.

## Laptop resource budget

Verification runs are serialized with an atomic workspace lock. Runtime services are capped below four CPU cores and six GiB in either test phase; swap is disabled for these containers. Default Chromium tests use two workers; the full browser matrix and frontend unit tests use one worker. Go packages/builds compile serially. A dedicated BuildKit builder is capped at four CPUs and four GiB and is stopped before test services start. The runner requires eight GiB free RAM before starting to leave headroom for the desktop. CI selects `SATVEY_TEST_PROFILE=ci`: smaller runtime workers, a two-CPU/two-GiB builder, one browser worker, and a five-GiB free-memory guard for hosted runners. These caps apply to verification; production sizing is separate. Duplicate external `docker stats --no-stream` monitoring processes can still consume host memory independently of these container limits.

On Windows, WSL image caches and Windows Docker/Scout clients have separate memory budgets. A 32-GiB laptop can use a shared WSL ceiling of `memory=12GB`, `processors=8` and `swap=2GB` in `%UserProfile%/.wslconfig`. This affects all WSL 2 distributions and applies after a full WSL restart; see [Microsoft's configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config). Container swap remains disabled by the test manifest.
