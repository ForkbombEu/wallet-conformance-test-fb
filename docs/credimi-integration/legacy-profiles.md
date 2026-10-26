# Legacy profiles and writable-path isolation

This document describes the profile system for the legacy WCT runner and how
writable outputs are isolated per-run.

## Profile catalogue

Profiles are defined in `src/runner-api/profiles.ts` with Zod validation.
Each profile has:

| Field | Description |
| ----- | ----------- |
| `id` | Safe lowercase identifier (`^[a-z0-9][a-z0-9_-]*$`) |
| `configFile` | Native INI config file loaded by `loadConfigWithHierarchy` |
| `category` | `issuance` or `presentation` |
| `selections` | Logical selection entries mapped to reviewed test files |
| `coverageMode` | `interoperability` (generic) or `it_wallet_profile` (Italian) |
| `allowedAuthorizationInteraction` | Enum values this profile supports |
| `initializedAssets` | Optional read-only seed assets |
| `browserDriver` | Optional trusted browser driver config (prompt 18) |

### First selection: `credimi-issuance-smoke`

Mapped to `tests/credimi/issuance/credimi-flow.issuance.spec.ts` with
`coverageMode: interoperability`. This is deliberately **not** Italian
conformance — the generic smoke test has no Italian conformance assertions.

## Typed run overrides

Only these properties are accepted in `RunOverrides`:

| Property | Constraint |
| -------- | ---------- |
| `issuer_url` | Absolute HTTPS URL |
| `credential_offer_uri` | Valid credential offer URI, no newlines |
| `credential_configuration_ids` | 1–16 nonempty unique strings, no newlines |
| `authorization_interaction` | `auto`, `browser_redirect`, or `credential_presentation` |

Unknown properties are rejected (`.strict()` on the Zod schema). Values
containing newlines or INI section markers are rejected to prevent injection.

## Browser driver gate

A `browser_redirect` flow cannot run headless. Until prompt 18 supplies a
trusted browser driver, the runner rejects starts requiring that interaction
with `UNSUPPORTED_AUTHORIZATION_INTERACTION`.

## Writable-path isolation

All writable outputs are isolated per-run under a workspace directory:

| Output | Config field / env | Default |
| ------ | ------------------- | ------- |
| SQLite DB + WAL/SHM | `WCT_DB_PATH` env | `data/wct.db` |
| Log file | `logging.log_file` | `data/logs/test_run.log` |
| Saved credentials | `wallet.credentials_storage_path` | `data/credentials/` |
| Wallet attestations | `wallet.wallet_attestations_storage_path` | `data/attestation/` |
| Backup | `wallet.backup_storage_path` | `data/backup/` |
| TLS certs | `trust_anchor.tls_cert_dir` | `data/backup/` |
| JWK keys | Caller-supplied (config-derived) | via `src/logic/jwk.ts` |
| PEM certs | Caller-supplied (config-derived) | via `src/logic/pem.ts` |

The `buildEffectiveConfig` function in `src/runner-api/effective-config.ts`
resolves all writable paths under the run's workspace directory, ensuring
fresh per-run isolation.

## Authorization driver

The profile may specify an `authorizationDriver` for automated browser-based
authorization flows. The driver config is operator-owned and cannot be supplied
via HTTP request parameters.

| Field | Description |
| ----- | ----------- |
| `type` | Must be `"puppeteer"` |
| `modulePath` | Path to an operator-owned ES module implementing `driveAuthorization({page, authorizationUrl, redirectUri, signal})` |

When no driver is configured, the CLI mode uses the system browser (`xdg-open`,
`open`, `start`). In runner mode, a `browser_redirect` profile without a
configured driver is rejected before spawning the test suite.

The driver receives the authorization URL and must perform target-specific
navigation/approval/login in the Puppeteer page. It must not fabricate
authorization codes or set suite verdicts — the callback server's OAuth result
is the sole source of truth.

Local callback URLs (`http://localhost:{port}/cb`) are only reachable from a
browser in the same network namespace. Remote device usage is not supported.

## Tested commands

### Runner API tests (offline, no public dependencies)

```bash
pnpm exec vitest run --config vitest.runner-api.config.ts
```

Covers: contract validation, summary aggregation, job store persistence,
job manager lifecycle, native worker process adapter, HTTP API routes,
artifact serving, engagement factory, authorization driver, acceptance
integration.

### Types, build, lint, format

```bash
pnpm types:check
pnpm build
pnpm format:check
pnpm lint:check
```

### Start the runner API (compiled)

```bash
CREDIMI_RUNNER_TOKEN=<token> node dist/src/runner-api/main.js
```

Binds to `127.0.0.1:8789` by default.

### Live recipe (NOT automatic — requires explicit endpoint)

Prerequisites:
1. Local WCT TA/WP/mock-issuer certificates and host entries
2. Public issuer reachability (Capture or configured issuer)
3. Browser driver configured in profile (for `browser_redirect` flows)

To run against Capture:
1. Create a fresh `/sessions` issuance fixture with explicit
   `issuer_configuration_id` and `credential_configuration_id`
2. Bind the generated offer and path-based `issuer_identifier` into the
   WCT profile/request (do NOT reuse stale `config.credimi-direct.ini`)
3. Verify wallet proof/client auth supports the selected fixture
4. If using `jwt-proof-only` diagnostic fixture, label the run
   `interoperability` and document limitations
5. Run only against an explicitly supplied endpoint

Do not change host files automatically or disable trust verification.

## Stale config warning

`config.credimi-direct.ini` is stale. Capture now uses path-based issuers
(e.g. `/issuers/eu-pid-device-bound`). Do not hardcode the old root URL or
`urn:eu.europa.ec.eudi:pid:1.jwt`. Use operator-discovered supported IDs
instead. Do not use `trust_anchor.verify=false` or
`NODE_TLS_REJECT_UNAUTHORIZED=0` as a universal compatibility switch.
