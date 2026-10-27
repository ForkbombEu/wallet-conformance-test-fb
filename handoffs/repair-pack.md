# Rolling Handoff — Legacy Repairs (`wallet-conformance-test-fb`)

## Follow-up pack 2026-10-27 (L08–L15) — CURRENT STATUS

The L01–L07 table further below is historical; the 2026-10-27 review found
several of those "Done" claims only partial. Statuses here are authoritative.
Per-task handoffs live in `/home/bario/pagopa-followup-20261027/handoffs/`.

| Task | Status | Notes |
|------|--------|-------|
| L08 profile/INI startup | DONE (audited + completed) | catalogue drives HTTP + executor; port-0 URL fixed |
| L09 child config/discovery | DONE for source mode | real Vitest child proven; built mode = L14 |
| L10 native browser path | DONE | runner child resolves operator driver; callback readiness/cancel; presentation rejected (MVP) |
| L11 lifecycle truth | DONE | abort reasons, single-write finalization, shutdown gate |
| L12 recovery/ownership | DONE | owner-token lock, hash migration, quarantine, restart recovery |
| L13 persistent evidence | DONE | durable run-scoped manifests, wire validation at publication |
| L14 built distribution | NOT RUN | |
| L15 production proof | NOT RUN | |
| Live SUT | NOT RUN | no operator SUT supplied |

---

# Historical (L01–L07, pre-review claims)

**Repository:** `ForkbombEu/wallet-conformance-test-fb`
**Branch:** `main`
**HEAD:** `271a23ea8d0505198cce74f0bbf32a3c93e08f8c`
**Repair pack:** `/home/bario/pagopa-runner-repairs-20261027/`
**Status (historical claim, superseded by the review):** All 7 prompts complete.

---

## Repair status

| Prompt | Status | Commit | Summary |
|--------|--------|--------|---------|
| L01 | ✅ Done | `f8e2d1a` | Native result translation: camelCase→snake_case adapter, false PASS eliminated, INCONCLUSIVE preserved |
| L02 | ✅ Done | `edb0b6c` | Job identity: recursive hash, per-run workspace, atomic lock, deadline timers |
| L03 | ✅ Done | `2028ee0` | SUT config: CONFIG_FILE_INI, issuer/offer overrides, tests dir passed to child |
| L04 | ✅ Done | `6fb6b7d` | Browser auth + RP factory wiring: authorizationDriver check, driver to handlePidFlow, factory to orchestrator |
| L05 | ✅ Done | `78242da` | Runner entrypoint: profile loading, real executor composition, CLI args |
| L06 | ✅ Done | `700a316` | Evidence downloads: real artifact paths, registration, run_id binding |
| L07 | ✅ Done | `271a23e` | Real composition suite: producer→adapter→summarizer→API, artifact binding |

---

## L01 — Native result translation (done)

**Defect:** Producer emits camelCase (`nativeStatus`, `title`, `ancestorTitles`); summarizer reads snake_case (`native_status`). FAIL → `summary.pass`.

**Fix:**
- `src/runner-api/native-result-adapter.ts` — runtime schema, explicit camelCase→snake_case mapping, runId validation, `assertion_id` from occurrence index
- `src/runner-api/summarize.ts` — INCONCLUSIVE scenario stays inconclusive even with failed assertions
- `src/runner-api/native-worker.ts` — uses adapter, validates runId, honest `engine.revision = "unknown"`

**Tests:** 38 passing (11 adapter + 12 worker + 13 summarize + 2 reporter-fixture)

---

## L02 — Job identity, isolation, deadlines (done)

**Defect:** `canonicalRequestHash` dropped nested keys; all jobs shared rootDir; no deadline timer; non-atomic lock.

**Fix:**
- `src/runner-api/job-store.ts` — `sortKeysDeep()` recursive canonicalization, `O_CREAT|O_EXCL` atomic lock, `workDir(runId)` for per-run isolation
- `src/runner-api/job-manager.ts` — deadline timer from `timeout_ms`, `cancelRequested` guard, error envelope before terminal state

**Tests:** 34 passing (15 job-store + 19 job-manager)

---

## L03 — SUT config to native child (done)

**Defect:** Child receives `WCT_*` only — no `CONFIG_FILE_INI`, issuer/offer overrides, tests directory.

**Fix:**
- `src/runner-api/native-worker.ts` — passes `CONFIG_FILE_INI`, `CONFIG_ISSUANCE_TESTS_DIR`, issuer/offer/interaction overrides
- `src/runner-api/effective-config.ts` — gains `profileConfigPath` from profile

**Tests:** 26 passing (14 effective-config + 12 native-worker)

---

## L04 — Browser auth + RP factory wiring (done)

**Defect:** `assertBrowserDriverAvailable` checked obsolete `browserDriver`; `handlePidFlow` called without driver; RP orchestrator didn't pass factory.

**Fix:**
- `src/runner-api/profiles.ts` — check `authorizationDriver` instead of `browserDriver`
- `src/step/issuance/authorize-step.ts` — `AuthorizeStepOptions` gains `driver`, passed to `handlePidFlow`
- `src/orchestrator/wallet-presentation-orchestrator-flow.ts` — `engagementFactory` parameter threaded to `getAuthorizeRequestUrl`

**Tests:** 249 passing (all runner-api)

---

## L05 — Real runner entrypoint (done)

**Defect:** `main.ts` had throwing executor, no profile loading, not in build.

**Fix:**
- `src/runner-api/main.ts` — loads profiles, builds real `createNativeExecutor` via `buildEffectiveConfig`, CLI args `--profiles`/`--state-dir`/`--port`

**Tests:** 249 passing

---

## L06 — Evidence downloads (done)

**Defect:** Workers returned empty `privateArtifactPaths`; artifact route didn't bind `run_id`.

**Fix:**
- `src/runner-api/native-worker.ts` — returns real `native-results.json` path as artifact
- `src/runner-api/main.ts` — registers artifacts from `privateArtifactPaths`
- `src/runner-api/server.ts` — binds `run_id` + `artifact_id` in route

**Tests:** 249 passing

---

## L07 — Composition proof (done)

**Fix:**
- `tests/runner-api/composition.test.ts` — real producer→adapter→summarizer→API chain, artifact binding, stale export rejection, INCONCLUSIVE preservation

**Tests:** 255 passing (19 test files)

---

## Key design decisions

1. **Adapter pattern**: camelCase producer → explicit snake_case adapter → wire schema validation
2. **Recursive canonicalization**: `sortKeysDeep()` sorts object keys at every depth, preserves array order
3. **Per-run workspace**: `join(store.rootDir, 'work', runId)` — no shared output paths
4. **Atomic lock**: `O_CREAT|O_EXCL` for root lock, owner-token release
5. **Cancel guard**: `runExecution` checks `cancelRequested` before setting terminal state
6. **Run/artifact binding**: artifact IDs prefixed with `runId:` — cross-run lookup denied

---

## Validation commands

```bash
pnpm exec vitest run --config vitest.runner-api.config.ts tests/runner-api/
pnpm types:check
pnpm build
pnpm format:check
pnpm lint:check
```

---

## Test fixture vs real engine vs real SUT

- **Test fixtures**: `native-result-adapter.test.ts`, `composition.test.ts` use synthetic producer exports
- **Real engine**: `reporter-fixture.test.ts` runs real Vitest subprocess with ConformanceReporter
- **Real SUT**: NOT RUN — no wallet/issuer available. Awaiting operator-supplied Capture or compatible issuer.

---

## Unresolved gates

- Real SUT acceptance NOT RUN (requires operator-supplied issuer + wallet)
- `engine.revision` is `"unknown"` — needs real build metadata at runtime
- Browser driver real-world login NOT RUN (requires operator-supplied Puppeteer module)
