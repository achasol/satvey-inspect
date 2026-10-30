# Satvey Inspect

Dutch property inspections: capture evidence, review proposals, and freeze a signed report with a server-rendered PDF. React/TypeScript, Go, PostgreSQL, and private S3-compatible storage.

## Repository

| Location     | Responsibility                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `apps/web`   | Browser application, shared UI, separate design-system showcase, unit tests                             |
| `apps/api`   | Go command, domain packages, HTTP/transaction orchestration, workers, embedded migrations/report assets |
| `tests`      | Browser workflows and generated verification artifacts                                                  |
| `infra`      | Isolated tests, production deployment, proxy, backup timer and alert rules                              |
| `scripts`    | Verification, deployment, recovery and explicit demo utilities                                          |
| `benchmarks` | Independent, offline property-state research tools                                                      |

## Develop

Use Docker Desktop with Linux containers:

```sh
docker compose up -d --build
docker compose exec -e BOOTSTRAP_EMAIL=admin@satvey.local -e BOOTSTRAP_PASSWORD=local-inspection-2026 -e BOOTSTRAP_ORG=satvey api /server bootstrap
```

Open http://localhost:5173. Preserve an existing `.env`; `.env.example` is a development template. No demonstration records are imported automatically.

For a native frontend with Node 22.12 or newer: `npm ci`, then `npm run dev`. Configure `API_PROXY_TARGET` if the development API is exposed elsewhere. The Windows demonstration remains available through `scripts/start-sleutels-demo.ps1 -Seed`.

## Verify

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run build
node scripts/test-stack.mjs
```

The last command creates a uniquely named, disposable Docker stack, runs Go race/integration tests, actual PDF inspection, and Chromium workflows, copies artifacts out, then removes only that test stack. Use `backend` or `browser` as its argument for one layer. Set `TEST_BROWSER_ARGS=--workers=1` for all configured browser projects. No application credentials or production volumes are inherited.

Production requires configured AI, HTTPS, SMTP, encryption keys and non-default storage/database credentials. Mock analysis remains a development/test feature. See [deployment](docs/deployment.md), [recovery](docs/recovery.md), [architecture](docs/architecture.md), [verification](docs/testing.md), and the [API contract](docs/openapi.json). Local checks do not replace staging capacity and restore gates.

Detailed workflows and demo instructions are in [development and product behavior](docs/development.md).
