# Satvey Inspect

Dutch inspection application with a React/TypeScript frontend, Go API, PostgreSQL, and private S3-compatible storage in RustFS. The working application is at `/` and `/app`; the component showcase is at `/design-system`.

The inspection workflow is **Opnemen → Beoordelen → Rapport**. Select a room, take photos or record audio, and save without completing a finding form. Review generated observation proposals afterwards. Approved observations and their selected source photographs form a report; original audio stays internal.

## Start locally

Use Docker Desktop with Linux containers. Go development, formatting, tests, and builds run in containers; no host Go or Node installation is required.

```sh
docker compose up -d --build
```

Open **http://localhost:5173**. RustFS's administration console is at **http://localhost:19001**. PostgreSQL, the API, and the S3 endpoint are available only on the Compose network. Database and object data live in separate named volumes and survive container replacement and `docker compose down`.

For a new installation, create the first organisation and administrator explicitly:

```sh
docker compose exec -e BOOTSTRAP_EMAIL=admin@satvey.local -e BOOTSTRAP_PASSWORD=local-inspection-2026 -e BOOTSTRAP_ORG=satvey -e BOOTSTRAP_ORG_NAME=Satvey api /server bootstrap
```

The credentials above are for local development. The bootstrap command creates records once and refuses to overwrite existing accounts or organisations. Set your own values for another installation. No sample properties are automatically imported. The administrator can invite other accounts through **Instellingen**; invitation links expire after seven days and are not emailed automatically.

Copy `.env.example` to `.env` only when creating a new configuration; preserve an existing `.env`. Compose reads it automatically. `.env` is ignored by Git, excluded from Docker build contexts, and its values are never exposed as frontend configuration.

## De Sleutels local demo (Windows)

Start the prepared demo with Docker's API/storage services and a native Node.js 22.12+ frontend:

```powershell
.\scripts\start-sleutels-demo.ps1 -Seed
```

Open **http://localhost:5174/app**. Sign in with **demo@desleutels.local** / **SleutelsDemo2026!** and use **De Sleutels · Demo**. The existing local administrator is also added to this separate organisation. The accounts, addresses, property characteristics, evidence and policy are fictional demonstration data, not actual De Sleutels records or official quality policy.

The demo contains eight Leiden-themed properties imported through the CSV flow, a published twelve-measure quality framework with illustrated examples, published pre-inspection and final-inspection formats, and six inspections. Start with **Lakenstraat 24 (demo)** to review prepared kitchen/bathroom findings, **Molenpad 16 (demo)** to record your own evidence, or **Rijnkade 42 (demo)** to view a completed report and download its PDF. **Singelhof 8-A (demo)** is fully reviewed and ready for finalisation; **Zijlpoort 36 (demo)** is partly captured; **Plantsoenhof 7 (demo)** is another completed report for benchmarking.

Six synthetic inspection photographs are in `demo/sleutels/images`; their exact prompts and built-in image-generation provenance are in `demo/sleutels/image-prompts.json`. The reusable property import is `demo/sleutels/properties.csv`. The seeder uploads photos to the application's private storage, prepares manual demo findings and judgments through the real API, and uses mock analysis without paid inference calls. Existing completed/demo-edited dossiers are preserved when rerunning it. Generated local dossier links are written to the ignored `demo/sleutels/demo-summary.json`.

Run `.\scripts\start-sleutels-demo.ps1` without `-Seed` to bring the services/frontend up without reapplying the demo catalog. Vite runs as a hidden background process, with its PID and logs under `.cache/sleutels-vite*`. `compose.demo.yaml` publishes the authenticated API on loopback port 8088 for this native frontend; other container services and data volumes remain in Compose. A custom `TRUSTED_ORIGINS` configuration must include `http://localhost:5174` and `http://127.0.0.1:5174`.

## Property catalog, VERA and CSV

New inspections select a property from the organisation's catalog by object number, address or postcode. The stable identity is **organisation + source administration + source object ID**; an address or BAG reference never automatically merges properties. **Instellingen > Vastgoedkoppeling** lets administrators (`settings.manage`) configure sources, import files, test VERA connections, inspect sync jobs and confirm provisional-property links. Inspectors can search the catalog and refresh a VERA property with their existing inspection permissions.

Each source administration has one fixed delivery route: CSV or VERA. Its administration code and route cannot be edited after creation. A VERA base URL cannot change once it contains properties. Use a separate source for a genuinely different administration. API data cannot be overwritten with a CSV import.

CSV sources need no external credentials. Download the UTF-8, comma-delimited template from the import dialog. `sourceObjectId` and `address` are mandatory; optional columns are `objectNumber`, `postcode`, `city`, `bagObjectId`, `bagAddressId`, `bagBuildingIds` (pipe-separated), `complexId`, `complexName`, `objectType`, `objectTypeCode`, `buildYear`, `area`, `areaType`, `areaTypeCode`, `areaUnit`, `sourceStatus` and `sourceStatusCode`. A surface area requires an explicit measurement type and unit; use a decimal point. Unknown facts stay absent. The UI accepts files up to 750 kB; the API accepts JSON requests up to 1 MiB and 10,000 rows. Split larger exports.

Validation reports row errors without changing the catalog. A successful preview shows new, changed and unchanged counts and the first 100 changes. Confirmation is atomic and idempotent. Previews expire after one hour and must be regenerated if the source configuration or catalog has changed. Missing rows never delete existing properties. Reimporting an unchanged object preserves its internal ID and revision.

VERA uses the [VERA Vastgoed 4.3.2 specification](https://github.com/Aedes-datastandaarden/vera-openapi/blob/main/Informatiedomeinen/Vastgoed.yaml). Configure the base URL including its API version path, and either `X-API-KEY` authentication or OAuth2 client credentials (token URL, client ID, secret and supplier-provided read scopes). Satvey reads `/eenheden`, resolves its address, city, BAG, area and cluster associations, and preserves `idExtern` and other keys separately from the source resource's `id`. Responses are top-level arrays with VERA cursor/page headers. Surface-area measurements retain their definitions and validity dates; distinct measurements are never added or relabelled as each other. Cluster types remain explicit.

For VERA, generate a 32-byte encryption key once:

```sh
docker compose exec -T app node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Add the result as `PROPERTY_ENCRYPTION_KEY` in the existing `.env`, then recreate the API. Keep this key with your deployment secrets and backups: stored API keys and client secrets use AES-256-GCM bound to the organisation and source. Credentials are never returned to the browser. HTTPS is required; `ALLOW_HTTP_PROPERTY_API=true` enables an isolated local test server. Resource references stay on the configured API host and resource paths, and redirects are refused. The OAuth token endpoint is separately configured.

The catalog synchronises hourly and can be refreshed manually. Durable jobs commit each successful page, resume at the saved cursor and retry a failing page at most three times. One job per source can run at a time; repeated cursors or unit IDs stop a broken pagination sequence. Disabling or editing a source revokes its active job. Errors and per-property fetch times remain visible; source failures retain existing catalog facts. A supplier integration still needs a practical contract test against its actual API before production use. DICO and writes back to source systems are not included.

An inspector can explicitly create a **voorlopige woning** and capture/review immediately. Finalisation requires an administrator-confirmed source identity. The administrator compares the provisional property and target, then confirms their revisions; all draft inspections move to the source property, with an audit trail and renewed review. Previously finalised reports remain frozen.

Each inspection pins its own property snapshot at creation. New source facts are shown for comparison and can only be adopted explicitly; this revokes old worker leases, increments the context version and requires renewed review. Human answers and prior norm corrections are retained. AI receives the pinned facts as administrative background, with an explicit instruction that they are never proof of an element's presence, condition or defects. Reports and PDFs include the pinned property facts and provenance. No residents or contract data are imported.

Backend integration tests can use an isolated database, keeping live workers away from test jobs:

```sh
docker compose exec -T postgres createdb -U satvey satvey_catalog_tests_20261030
docker compose run --rm --no-deps -e TEST_DATABASE_NAME=satvey_catalog_tests_20261030 go go test -count=1 ./...
docker compose run --rm --no-deps tests node tests/run.cjs properties.spec.ts --project=chromium
```

Create the test database once. Backend tests use disposable tenants and a VERA HTTP test server; browser tests use CSV data and mock evidence analysis, with no paid inference calls.

## Photo analysis

With `BASETEN_KEY` set in `.env`, `IMAGE_ANALYSIS_PROVIDER=auto` uses **Baseten GLM 5.3 Flash** (`zai-org/GLM-5.3-Flash`). `BASETEN_API_KEY` is also supported by the binary, but Compose maps `BASETEN_KEY` specifically. Only the API container receives the key.

```dotenv
BASETEN_KEY=your-key
BASETEN_MODEL=zai-org/GLM-5.3-Flash
IMAGE_ANALYSIS_PROVIDER=auto
```

After changing environment values, recreate the API:

```sh
docker compose up -d api
```

The server sends JPEG analysis copies, resized to a maximum edge of 1600 pixels, directly to Baseten. Original photos remain in the private bucket. Audio is never sent for image inference. Results are validated for structure, length, and references to the supplied photos, saved as **AI-voorstel**, and always require inspector approval. The prompt asks for visible faults and inspection limitations without inventing diagnoses, measurements, cost allocations, or hidden causes.

Analysis runs in a durable PostgreSQL queue with leases, bounded retries, and visible failure states. An inspector can retry a failed analysis or choose **Handmatig verder**. The original media remains available on failure. A crash after a provider response but before the database commit can cause a repeated inference request.

Without a key, `auto` uses deterministic **Voorbeeldvoorstel** drafts. Force that behaviour with `IMAGE_ANALYSIS_PROVIDER=mock`. Explicit `baseten` mode requires a key and refuses to start without one. Mock proposals never claim that an image was analysed, and their placeholder description must be replaced before approval.

The adapter uses [Baseten's Model APIs](https://docs.baseten.co/inference/model-apis/overview) and the [GLM 5.3 Flash model](https://www.baseten.co/resources/changelog/glm-53-flash-available-on-baseten/).

Inspection editors can permanently delete a draft or final inspection from the list or dossier after confirming its address. The dossier, reviews, report and local drafts are removed; the catalog property and shared formats/frameworks remain available. Migration 012 adds a durable object-deletion queue so storage cleanup can retry after temporary outages.

When finalising an inspection, the confirmation dialog optionally collects handwritten signatures from up to ten signers, with name and role (inspector, resident or other attendee). Signatures are attached to the final report with a server timestamp and the collecting account ID. They appear in the report and PDF and cannot be edited after finalisation. Closing the confirmation dialog cancels the unsigned finalisation; signatures are only stored when the report is successfully finalised. Existing reports and finalisation without signatures remain supported.

## Norms, room elements and benchmarks

Open **Normen** to manage organisation quality policy. The default **Kwaliteitsbeheerder** role can author policy without changing inspection evidence or organisation access. Create a draft from the researched baseline (12 measures, 24 original text examples), or start empty. Each measure defines rooms, an object/element, acceptable and unacceptable conditions, AI attention points, evidence modalities, priority and examples. Publishing requires both acceptable and unacceptable examples. Published versions are immutable; a revision starts as a separate draft. Each inspection selects a published version or no framework and retains its selection in the final report.

**Normen > Ruimtes en elementen** is the room/element ontology. Define a recognizable element such as a faucet or wall, choose its rooms (including custom room names or all rooms), and add a factual description and alternate names. Acceptance criteria, AI attention points, evidence requirements and examples belong exclusively to framework measures. Eight editable starter definitions are installed for each organisation. Measures can reference these elements; selecting one fills its name and room scope. Archive an element to stop offering it to new inspections. Each new inspection snapshots the active element catalog. The worker sends only definitions matching its capture room to the model, including inspections without a framework. Catalog edits leave existing inspection context intact. Historical element attention points in old inspection snapshots are ignored when building analysis input. Definitions describe possible components, not proof of presence or absence. Migration 011 appends historical element attention points to linked draft measures without overwriting their existing instructions. If a framework has no draft, it clones its latest published version only when there are instructions to transfer. Published versions and inspection/report history remain unchanged; original element text is retained internally for history, including text with no linked measure. New organisations receive descriptive starter definitions without attention points. Framework AI instructions support up to 6,500 characters (the API validates UTF-8 bytes).

Example photos and audio files use the private bucket and authenticated, tenant-scoped downloads. All example descriptions and transcripts enter norm context; up to eight reference photos are also sent as resized images. Reference images are explicitly separated from current evidence and cannot be cited as evidence for the inspected dwelling. Example audio is retained for playback; its manually entered transcript supplies model context.

For inspection audio, expand **Transcript bij spraaknotitie**, enter/edit the spoken observation, and save. Automatic transcription is not included. Saving increments the transcript version, invalidates previous norm confirmations and any in-flight worker lease, and schedules reanalysis. Source media IDs and transcript versions are stored with assessments. Existing observation text is preserved during reanalysis. Failed analysis can be skipped for manual review, with explanations required for manual or overridden outcomes.

Each applicable measure receives one assessment per capture: acceptable, unacceptable, not assessable, or not applicable. Missing evidence never becomes a pass. The inspector confirms assessments separately from observation proposals. Included assessments must be current and confirmed before the capture can be marked reviewed or its report finalised. Reports retain the framework and confirmed assessments; original audio and raw inspection transcripts remain internal.

**Benchmark** compares confirmed assessments within one exact norm version by measure and room. It counts assessments, not unique dwellings. Excluded captures are omitted; pending and stale assessments are separate. The acceptance rate uses only confirmed acceptable and unacceptable outcomes.

The baseline is independently written draft policy using public guidance checked on 29 October 2026: [Huurcommissie defect check](https://www.huurcommissie.nl/support/onderhoud-en-gebreken-check), [Gebrekenboek July 2026](https://www.huurcommissie.nl/support/beleidsboeken/gebreken/voorwoord), [NEN public condition-assessment explanation](https://www.nen.nl/bouw/beheer-en-onderhoud/conditiemeting/achtergrond-conditiemeting), and [Rijksoverheid maintenance responsibilities](https://www.rijksoverheid.nl/themas/bouwen-en-wonen/woning-verhuren/woning-verhuren-wat-moet-ik-regelen/vraag-en-antwoord/woning-huren/welke-kosten-zijn-voor-de-huurder-en-welke-voor-de-verhuurder). This is editable corporation policy; it does not reproduce licensed NEN tables, compute NEN 2767 scores, determine liability or certify compliance.

## Inspection formats and guided capture

Open **Inspectieformats** to create an editable pre-inspection or final-inspection starter draft. A format defines whole-property and room requirements, repeatable/optional room categories, typed questions, photo requirements, written/spoken evidence, norm/element links and optional talking prompts. A preceding mandatory yes/no or choice question may activate follow-ups. Preview the inspector's conversation guide before publishing. Publishing requires a published norm framework; published format versions are immutable.

New inspections require a published format matching their type. They pin that format, its norm version and the room-element context. Required rooms and questions exist before the first capture; existing inspections keep their previous workflow. Extra rooms inherit their format category. **Woning algemeen** can draw evidence from all included rooms.

**Bespreek deze punten** shows up to three unresolved topics beside the recorder. Prompts stay fixed during recording and update after saved audio is transcribed and analysed. They use the format locally, without additional model calls or live streaming. Temporarily hiding a prompt never answers or waives the question.

The room summary combines answers and linked norm judgments across uploads. Inspectors can change answers, inspect sources, or explicitly choose **Niet te beantwoorden** with a reason. One room approval confirms its displayed valid answers after every finding has an explicit approval/rejection. A room exemption records a reason for all its questions and excludes its captures. New evidence, exclusions or transcript edits require renewed review; human corrections are retained. Finalisation checks mandatory active questions, evidence, processing and current room approval on the server. Reports freeze structured results and exceptions; benchmarks count a linked rule once per room instance rather than once per photo.

## Shared hosted transcription

The Go worker calls `https://inference.baseten.co/v1/chat/completions` using the shared hosted `meta-models/muse-spark-open` model. No GPU deployment is created. The existing `BASETEN_KEY` is used only on the server. `TRANSCRIPTION_PROVIDER=auto` enables transcription when a key is configured; `disabled` retains manual transcription. GLM Flash continues to analyse images and effective transcripts.

FFmpeg and ffprobe are installed in both the runtime and Go tooling containers. Browser WebM/MP4/OGG audio is decoded to mono 16 kHz FLAC and split into four-minute requests, with a ten-minute decoded duration limit. Private audio is sent as encoded request data; RustFS does not require public access. Durable leased jobs retry at most three times and cache successful chunks within the organisation. Input/output token counts are retained. Machine output is separate from the editable transcript; concurrent manual corrections win. Failed transcription offers retry, manual entry or an explicitly explained skip.

Baseten's [audio documentation](https://docs.baseten.co/inference/model-apis/audio) currently lists Muse Spark Open as the shared audio-capable offering. Audio uses standard token billing, including model reasoning; see [current pricing](https://www.baseten.co/pricing/). Reference/API tests mock paid inference, with a separate short hosted-model smoke check performed during development.

Inspector forms show the main task first: the selected format supplies the inspection type; address details and appointment scheduling are optional expansions. Extra rooms receive category-based names that can still be customised. Findings have direct title/description fields and an optional label. Short answers use direct choice buttons. Written observations count as their own statement rather than requiring the same text twice; photographs, measurements and explicit exceptions retain their validation requirements.

Settings use Account, Leden en uitnodigingen, Rollen en privileges and SSO tabs, with management sections available only to members with settings.manage. Each section has a white content card. Forms preserve their in-memory values when changing settings tabs. Inspection-list columns reserve space for both Open and Vastgelegd, and property icon colours remain stable for the same property.

## Roles and privileges

**Instellingen > Rollen en privileges** supports creating, renaming and editing organisation roles. Assign roles to members and invitation links. Permission edits apply to existing sessions on their next API request. The API enforces privileges independently of the UI and legacy role names.

| Privilege | Permitted actions |
| --- | --- |
| `inspections.read` | Open dossiers, media and reports |
| `inspections.write` | Capture, edit transcripts, review findings and norms, finalise reports |
| `norms.read` | Open published frameworks, elements and reference examples |
| `norms.manage` | Author/publish frameworks, manage elements and upload examples |
| `formats.read` | Open published inspection formats |
| `formats.manage` | Author/publish formats, conditional questions, evidence requirements and talking prompts; also requires `norms.read` |
| `benchmarks.read` | Open norm benchmarks |
| `settings.manage` | Manage members, invitations, SSO, roles and privileges |

Write privileges require the matching read privilege; benchmark access requires norms.read. Roles with no privileges are allowed. Default templates are Beheerder, Inspecteur, Leestoegang and Kwaliteitsbeheerder; their permissions are editable. At least one actual member must retain settings.manage. Assigned roles cannot be deleted. Versioned edits prevent overwriting concurrent changes.

## Email-first login and SSO

Login starts with email only. The API normalises its casing and checks the exact email domain against configured organisation domains. A matching domain redirects to OIDC SSO; other domains reveal a password field. Discovery does not check whether that individual user exists. Subdomains must be configured separately.

Administrators configure issuer, client ID, optional client secret, and comma-separated email domains in **Instellingen → Organisatie-SSO**. A domain can belong to one organisation. The redirect URI is:

```text
http://localhost:5173/api/v1/auth/oidc/callback
```

OIDC uses authorization code flow with PKCE, nonce, and browser-bound state. Identity mappings use issuer and subject. Existing accounts are not automatically merged by email: linking from an authenticated session proves both identities; a domain-routed first SSO login for an existing password account requires that password once to complete the link.

To run the local SSO provider:

```sh
docker compose --profile sso up -d keycloak
```

Configure issuer `http://localhost:8081/realms/satvey`, client ID `satvey`, blank client secret, and test domain `example.test`. The imported local account is `sso-inspector@example.test` with password `local-sso-inspector-2026`. Invite this email into the organisation before or after its first login. The provider console is at http://localhost:8081; the local admin password comes from `KEYCLOAK_ADMIN_PASSWORD`.

`OIDC_PUBLIC_ISSUER` and `OIDC_INTERNAL_BASE_URL` allow the API to reach the local Keycloak container while the browser uses localhost. Remove this local backchannel override for a normal publicly reachable production issuer. Plain HTTP OIDC is enabled only by the local Compose configuration; the binary defaults to HTTPS issuers.

Organisation roles and their privileges are configurable in Settings. Records are shared within an organisation. Tenant checks cover every read, write, media request, and report; composite foreign keys prevent attaching records to parents from another organisation. An organisation must retain at least one member with settings.manage.

## Recording, uploads, and offline behaviour

- Photos: JPEG, PNG, or WebP, up to 20 MB each; a capture batch contains 1–30 files. Vision decoding accepts images up to 40 megapixels.
- **Foto maken** opens a live rear-camera view with a room picker and a one-tap next-room button. Switching rooms retains the camera stream. Each shot is persisted locally; room changes and **Gereed** queue its photos automatically. Long visits are split into batches of at most 30 files. Interrupted sessions can be restored when reopening the camera. Device-camera/file import remains available when live capture is unavailable.
- Audio: real `getUserMedia`/`MediaRecorder` capture, with format negotiation, stop/discard, playback, a ten-minute browser recording limit, and a 50 MB upload limit. Recordings are automatically transcribed through a shared Baseten Model API; transcripts remain editable.
- Camera and microphone access require localhost or HTTPS. Phone use over a LAN requires HTTPS; plain `http://computer-ip` does not provide live camera/microphone access. Camera tracks stop when closing/leaving the view or hiding the application. Real iOS/Android device testing remains necessary.
- Captures and text drafts are persisted in a separate IndexedDB database, scoped by user and organisation. Pending work survives reload and authentication expiry. Sign-out preserves it for the same account and pauses uploads.
- The UI distinguishes device storage, upload, server storage, and failure. Upload retries use stable IDs and content hashes; the server never overwrites media with different content under the same ID.
- Queue retries run while the app is open and on reconnection. Previously loaded dossiers have an on-device fallback. This is not a fully offline installed application: reopening the application without connectivity is not guaranteed.
- Concurrent observation and batch edits use versions. Conflicts retain the local text for comparison and require explicit resolution; they never silently overwrite another user's edits.

Reports can only be finalised when all captures are reviewed or explicitly excluded and all included expected media has reached storage. Included observations require an approved title and description. The server freezes the report and locks further inspection/media changes. External report sharing, agreements and maintenance follow-up remain outside this workflow.

**Beoordelen** shows every room in one scrollable list, with direct title/description fields. **Goedkeuren** or **Afwijzen** saves both text and the decision; the last finding decision automatically marks a capture reviewed once processing finishes. An empty AI result still requires an explicit capture/room review. The separate room summary confirmation checks format answers and evidence; it cannot silently approve undecided findings.

Open a photo to mark it with a pen, arrow or circle, choose red/yellow/blue, undo/redo, zoom, or clear the markings. **Gereed** queues the annotations for synchronisation. Originals remain unchanged in private object storage and continue to be used for AI analysis. Versioned geometry is stored separately in PostgreSQL, with local draft recovery and visual comparison for conflicting edits. Final reports freeze the annotations; the PDF container renders them over the correctly oriented source photo. Unsaved annotation drafts and queued changes block finalisation/export.

## Server-rendered PDF reports

**PDF downloaden** submits an authenticated POST to the Go API. The API sends a dedicated HTML report, static DM Sans TrueType fonts, and private source-photo copies to **Gotenberg 8.39.0 / headless Chromium** in the `pdf` Docker service. No Puppeteer or browser print dialog is used. The renderer has no published host port; its report assets are uploaded together and it cannot fetch public or private network resources.

Reports use A4 pages, fixed margins, running headers/footers, page numbering, room-based sections, a coverage table, linked photo references, PDF structure tags and hierarchical bookmarks. Photos retain their proportions and are included once per room. Long findings can continue across pages; headings and photo rows are kept together. All source images and fonts must be ready before conversion. Unavailable photos or failed conversion return an error instead of a partial report.

Saved reports render from their immutable snapshot, including organisation and author names frozen at finalisation for new reports. Legacy snapshots without these names use current organisation/creator names for display. Draft PDF exports are marked **Concept** and include only reviewed captures, approved findings and confirmed norm assessments. Original audio and raw transcripts remain internal. The UI blocks draft export while local changes are unsaved or queued.

The PDF template is in `backend/report_assets`. The font is OFL-licensed; its licence is included beside it. Static TTF instances are generated once with `scripts/prepare-report-fonts.py` when updating the source variable font.

To generate and independently inspect short, long and draft PDF fixtures inside Docker:

```sh
docker compose run --rm --no-deps -e PDF_ARTIFACT_DIR=/artifacts go go test -v -run TestPDFActualRendering
docker compose --profile test run --rm --build --no-deps pdf-check
```

The checks read the actual PDF bookmarks and their destination pages, embedded fonts/images, A4 geometry, page numbers, text boundaries and final-page content. PDFs and rendered page previews are written to `tests/artifacts`. The parser runs only in the test container and is not part of production report generation.

To check photo annotations against source-image coordinates in a real PDF:

```sh
docker compose run --rm --no-deps -e PDF_ARTIFACT_DIR=/artifacts go go test -count=1 -run TestAnnotationReviewAndFrozenReport
docker compose run --rm --no-deps --entrypoint python pdf-check /check-annotations-pdf.py /artifacts/report-annotated.pdf
```

The old browser prototype's IndexedDB data is left untouched. It is not imported into server records.

## Develop and verify in containers

The frontend is mounted into the Vite container for live changes. Backend tooling uses a separate Go container with module/build caches:

```sh
docker compose run --rm go gofmt -w .
docker compose run --rm go go test -v ./...
docker compose run --rm go go vet ./...
docker compose up -d --build api
docker compose exec app npm run typecheck
docker compose exec app npm run build
docker compose --profile test run --rm tests
```

To narrow browser tests:

```sh
docker compose --profile test run --rm tests node tests/run.cjs tests/inspector.spec.ts --project=chromium
```

The test runner provides a loopback proxy so real browser recording APIs work inside the test container. Tests cover server-backed capture/reporting, recording/playback, queued upload recovery, edit conflicts, responsiveness, and automated accessibility. Existing showcase tests target `/design-system`.

Browser tests use the local bootstrap credentials above by default; pass `E2E_EMAIL` and `E2E_PASSWORD` with Compose `-e` to use a dedicated test organisation. They create inspection fixtures in that organisation. Image processing is explicitly mocked in browser tests to avoid spending provider credits. Keep `ALLOW_MOCK_ANALYSIS=true` for local browser tests; disable it in a deployed environment.

To remove generated browser fixtures after the suite finishes, run `docker compose run --rm -e CLEANUP_E2E_FIXTURES=1 go go test -v -run 'TestCleanup.*BrowserFixtures'`. This targets generated `Teststraat <timestamp>-<number>` inspections created by `E2E_EMAIL` (defaulting to the local bootstrap account), their object bytes, and unused `E2E Norms`, `E2E Element` and `E2E Role` fixtures. Normal test runs do not perform this cleanup.

Go tests run against real PostgreSQL/RustFS, clean up their own fixtures, and exercise a fake HTTP vision endpoint for adapter validation. They do not call a paid provider. Without `DATABASE_URL`, integration tests are explicitly skipped. Browser artifacts are written to `tests/artifacts`, with failure traces in `test-results`.

The API contract is documented in [docs/openapi.json](docs/openapi.json). SQL migrations are embedded in the Go binary, serialized under a database advisory lock, and applied by the Compose migration service before the API starts.

## Backup and restore

Back up PostgreSQL and the object volume together. Pause API writes while taking the pair; preserve the configuration/secrets separately. For PostgreSQL:

```sh
docker compose stop api
docker compose exec -T postgres pg_dump -U satvey -d satvey -Fc -f /tmp/satvey.dump
docker compose cp postgres:/tmp/satvey.dump ./satvey.dump
docker compose stop rustfs
```

While RustFS is stopped, archive or snapshot the `satvey-inspect_object_data` named volume through Docker Desktop or your volume backup tool. Then restart `rustfs` and `api`. Never use `docker compose down -v` to restart an installation whose records you need.

For restore, stop the API and RustFS, restore the object archive into that volume using the same RustFS release, start PostgreSQL/RustFS, copy the dump into the PostgreSQL container, and run `pg_restore -U satvey -d satvey --clean --if-exists /tmp/satvey.dump`. Run `docker compose run --rm migrate`, then start the API. Validate an existing report and photo/audio download before resuming use.

## Deployment configuration

The included Compose setup binds public listeners to localhost and contains development credentials. For deployment, set your own database/storage credentials, HTTPS `APP_URL`, OIDC configuration, and exact trusted origins. Set `ALLOW_HTTP_OIDC=false` and `ALLOW_MOCK_ANALYSIS=false`. The binary enables Secure session cookies when `APP_URL` is HTTPS. Serve the frontend and API under one origin; the supplied Nginx configuration proxies `/api` and supports SPA fallback and bounded uploads.

The bundled frontend Dockerfile produces a static Nginx image and expects the Go service to resolve as `api` on its Docker network. The original colour tokens, shared components, fonts, and licensed illustrative photos remain available in the separate showcase. No site has been published externally.
