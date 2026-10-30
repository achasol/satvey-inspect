# Verification and release gates

## Fast checks

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test:coverage`, and `npm run build`. Frontend unit tests exercise cancellation, stale responses, scoped caches, durable drafts, concurrent queue insertion, cross-tab synchronization, conflicts, transport failures, authentication expiry, IndexedDB upgrades and account-recovery forms.

From `apps/api`, run `go vet ./...`. The backend suite includes an FFmpeg contract, so the complete suite runs inside its tooling image. A native machine without FFmpeg can run `go test -skip '^TestHostedTranscriptionContractAndAudioConversion$' ./...`; integration cases explicitly skip without isolated services. This reduced command does not certify the integration layer.

## Isolated verification

`node scripts/test-stack.mjs` builds disposable images, creates separate Go/browser databases and buckets, initializes storage, runs Go race tests and independent PDF checks, bootstraps a browser-only administrator, then runs Chromium. `backend` and `browser` arguments run individual layers. Set `TEST_BROWSER_ARGS=--workers=1` for all five configured browser projects. The full matrix uses one worker to leave room for Firefox/WebKit and accessibility analysis within the memory budget. CI does the full matrix nightly and on manual release verification.

The stack copies code into images and writes artifacts to named volumes, avoiding Docker Desktop bind-mount failures and live-source races. Artifacts are exported into `tests/artifacts`, `test-results` and `playwright-report` before cleanup. `KEEP_TEST_STACK=1` retains only the explicitly named test project. Never combine this manifest with development or production Compose files.

On Docker 25, `SATVEY_TEST_USE_DAEMON_BUILDER=1` optionally reuses Desktop's cached base images through its classic builder, with the same hard build resource limits. This avoids duplicate large downloads into the isolated BuildKit cache. The default and CI use BuildKit; newer Docker versions without the classic builder should use the default.

Fixtures refuse databases whose names do not start with `satvey_test`, buckets not starting with `satvey-test`, or an environment other than `APP_ENV=test`. `REQUIRE_INTEGRATION=1` turns missing services into failures. Mock inference and a local SMTP capture service keep tests separate from paid inference and real recipients.

The research suite is independent: install `benchmarks/property-state/requirements.txt` and run `python -m unittest -v test_benchmark` there. Tests do not download report sources or require private images.

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
