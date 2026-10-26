# Credimi external runner contract — proposed v1.0

This is the contract to implement, not an existing PagoPA API. It is deliberately small. Implement it separately in the two forks; do not create a shared npm platform during this work.

## Boundaries and first release

`ForkbombEu/itw-conformance-tool` runs the real upstream Vitest matrix and its native issuer/RP/TA services against a wallet. First support the single presentation scenario `WP_RP_HAPPY`, retaining every matrix assertion in that scenario. `ForkbombEu/wallet-conformance-test-fb` runs the older simulated wallet against configured issuers/RPs, preserving its existing generic OID4VCI work. The first legacy target is its existing `credimi-issuance-smoke` test, explicitly labelled interoperability. Add further entries explicitly; never silently run all tests when selection is invalid.

Credimi uses StepCI for short control requests, Temporal for bounded polling/retries/cleanup, and the existing Maestro/mobile workflow for wallet actions. Evidence parses already captured bytes offline. Capture remains an issuer/verifier fixture and optional SUT. PagoPA's native counterpart services stay in ITWCT; replacing them with Capture is outside this implementation.

One active run per runner instance; no queue, dynamic port allocator, general remote command API, or Docker scheduler. Deploy independent isolated worker replicas when parallelism is needed. Serialize the native listeners as well as the test child. API code never imports a Vitest-bearing package barrel into ordinary Node runtime.

## API

Except `GET /healthz`, every route requires `Authorization: Bearer <operator token>`. Bind to `127.0.0.1` by default; require a configured nonempty token even for development. The token is read from the process environment, never from a tracked config file or response. Do not enable CORS unless required by a separate task. The target audience is authenticated Credimi workers, not browsers.

| Request | Success | Contract |
| --- | --- | --- |
| GET /healthz | 200 | Liveness only; must not claim suite conformance or service readiness. |
| GET /v1/capabilities | 200 | contract version, engine/build revision, supported categories, non-secret profile IDs, selection catalogue, maximum timeout. |
| POST /v1/runs | 202 new; 200 replay | Requires `Idempotency-Key`. Returns a compact RunSnapshot. |
| GET /v1/runs/{run_id} | 200 | Compact RunSnapshot, including zero or one unacknowledged wallet interaction. |
| POST /v1/runs/{run_id}/cancel | 200 | Idempotent cancellation request and compact snapshot. It may still be stopping children. |
| POST /v1/runs/cancel-by-key | 200 known; 404 unknown | Uses the original Idempotency-Key header. Cancels an existing run without creating one, even when its start response was lost. |
| POST /v1/runs/{run_id}/interactions/{interaction_id}/ack | 200 | Body `{ "driver_status": "completed" }` or `{ "driver_status": "failed", "message": "bounded diagnostic" }`. Acknowledges the driver only. |
| GET /v1/runs/{run_id}/result | 200 terminal | RunnerResult JSON. 409 while not terminal. Available on failed/cancelled runs with explicit incomplete evidence. |
| GET /v1/runs/{run_id}/artifacts/{artifact_id} | 200 | Exact allowlisted artifact bytes, content type and hash. Never a raw filesystem path. |

Errors are `{ "error": { "code": "STABLE_CODE", "message": "bounded safe text" } }`. Use 400 for malformed payload, 401 for auth, 404 for unknown run/artifact, 409 for `RUNNER_BUSY`, idempotency conflict or result not ready, 410 for expired interaction, 413 for oversized JSON. An unknown profile/selection is rejected with 400 before spawning. Profile incompatibility/unsupported category is explicit 400. Never redirect artifact clients to a different authenticated origin.

Request JSON (snake_case everywhere on the wire):

```json
{
  "contract_version": "1.0",
  "profile_id": "operator-provided-id",
  "category": "presentation",
  "selection": { "ids": ["WP_RP_HAPPY"] },
  "target": { "actor_type": "wallet", "actor_name": "Example wallet", "actor_version": "dev" },
  "timeout_ms": 600000,
  "parameters": {}
}
```

`category` initially allows only issuance/presentation. `selection.ids` is nonempty, unique, maximum 32; it contains scenario IDs for ITWCT or logical catalogue entry IDs for WCT, never arbitrary paths, command fragments, regular expressions, or shell commands. ITWCT initially accepts presentation + exactly `["WP_RP_HAPPY"]`. WCT initially accepts issuance + exactly `["credimi-issuance-smoke"]`. `parameters` is empty for the first ITWCT release. The WCT extension explicitly validates issuer_url, credential_offer_uri, credential_configuration_ids, and authorization_interaction only after its profile prompt implements them. Unknown keys are errors. Unsupported selection never falls back to the full matrix.

`target` records the actual SUT. It must agree with the selected profile/category and effective config; labels cannot silently claim a different endpoint, actor or wallet. Target actor types for MVP: wallet/issuer/verifier/relying_party. Engine metadata identifies the external suite separately. Never accept untrusted test code, script paths, INI text, secret material or arbitrary environment variables in this request.

Idempotency is per runner token namespace plus key. Store a canonical validated request hash and run ID atomically before starting a child. Equivalent JSON key order replays the same run; changed array order remains meaningful. Same key + different request => 409. Check replay before the busy check. The same key after completion/restart still returns its original run while retained. Do not delete an idempotency record independently of its retained run. Concurrency races must not start two workers.

RunSnapshot required fields:

```json
{
  "contract_version": "1.0",
  "run_id": "uuid",
  "engine": "pagopa-itwct",
  "status": "running",
  "created_at": "2026-10-26T12:00:00Z",
  "updated_at": "2026-10-26T12:00:01Z",
  "cancel_requested": false,
  "pending_interactions": [],
  "result_url": "/v1/runs/uuid/result"
}
```

Engine IDs: `pagopa-itwct`, `pagopa-wct`. Status enum: `queued`, `running`, `waiting_for_interaction`, `completed`, `cancelled`, `timed_out`, `error`. Last four are terminal. `completed` means a readable suite result was collected; it may contain FAIL assertions and a nonzero Vitest exit code. `error` means spawn/setup/export/cleanup failed or evidence was unusable. Do not say cancelled/completed until all owned service/test children are stopped. A cancel response may show `cancel_requested: true` while status is still running.

Interaction shape:

```json
{
  "interaction_id": "stable-per-show-instructions-call",
  "scenario_id": "WP_RP_HAPPY",
  "correlation_id": "native-correlation-id",
  "kind": "wallet_deeplink",
  "uri": "openid4vp://authorize?request_uri=https%3A%2F%2Frp.example%2Frequest",
  "created_at": "2026-10-26T12:00:01Z",
  "expires_at": "2026-10-26T12:05:01Z"
}
```

Kinds: wallet_deeplink, wallet_qr, browser_authorization. Only the first is initially supported by Credimi automation. Expiry follows the native tester-action window; acknowledgements do not extend it. Publish after fault/config activation and event observation starts, before waiting for the wallet. In automated mode, showInstructions publishes once and returns promptly; it never waits for the driver to finish. This lets the native engine observe protocol traffic concurrently. Duplicate reads/acknowledgements do not open the wallet twice. `ack completed` does not inject success events or set suite PASS. `ack failed` makes a driver failure visible and cancels the job. Expire/close interactions when the scenario stops. Keep the original interactive CLI unchanged when automation is not enabled.

## RunnerResult

Required: contract_version, run_id, profile_id, category, engine (object), execution (object), selection, target, native (object), summary, artifacts, limitations. Engine object has id, upstream_repository, fork_repository, version, revision. execution has status, started_at, optional finished_at/exit_code/error. native has sessions, assertions and scenario_outcomes arrays (empty permitted for failed setup), native_suite_status, and coverage_mode (`it_wallet_profile` or `interoperability`). Retain assertion requirement ID when available, full title/ancestors, file, phase, credential configuration context and native status/message. Stable native_status values are PASS, FAIL, NOT_REACHED; retain the original Vitest state separately as vitest_status/raw diagnostics. Scenario verdicts are PASS, FAIL, INCONCLUSIVE. Preserve duplicate IDs as separate assertions. No invented specification links.

summary has result (`pass`, `fail`, `not_tested`, `inconclusive`, `partial`), assertion_count, and native_failed_assertion_count. Keep native binary test failures and scenario INCONCLUSIVE side by side. See result-semantics.md for aggregation. A valid result with zero assertions cannot be PASS.

Artifact manifest entries have artifact_id (safe opaque name), filename (display only), mime_type, size_bytes, sha256 (64 hex), and download_url (same-origin relative path). Produce allowlisted native JSON and optional Vitest JSON/scenario evidence; retain exact bytes. Do not serve the whole data directory, SQLite runtime database, config, keys, certificates with private material, cookies or unrestricted logs. Public-certificate evidence is only added deliberately. Hashes bind bytes; they do not prove authenticity or conformance.

Local JSON writes use temporary file + rename. Keep per-run state/data/output separate. Recover interrupted runs to error with a diagnostic, do not resume a wallet interaction after a runner restart. A replica must not accept new work until previous process ownership is known clear; use an exclusive root lock plus a process supervisor that terminates all children on restart, and do not kill a stored PID blindly (PID reuse). MVP deployment restarts the whole isolated runner process tree/container. Persist results separately from disposable native state.

Operator profiles map a safe ID to native config, supported category/selections, public endpoint expectations, optional read-only initialized seed assets and coverage mode. New ITWCT URLs are the suite's local listeners; they are not a way to replace them with arbitrary external issuer/RP components. WCT issuer/RP URLs identify the SUT. Trust/client authentication/credential profile compatibility remains real configuration work.
