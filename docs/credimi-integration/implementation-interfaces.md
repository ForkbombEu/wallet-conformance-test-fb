# Suggested internal interfaces — use these names to avoid cross-task invention

These interfaces are part of the implementation task design. They are not claims about existing upstream exports. Keep each repository independent; do not create a shared runtime package. If an earlier task has already implemented an equivalent interface, keep it and record the exact mapping rather than rewriting working code solely to rename it.

## TypeScript runner host (both forks)

Keep wire types/validators in runner-api/contract.ts. Export `RunRequest`, `RunSnapshot`, `RunnerResult`, `PendingInteraction` and `RunStatus`. Zod schemas are `runRequestSchema`, `runSnapshotSchema` and `runnerResultSchema`. `summarizeResult(execution, native)` returns the wire summary. Do not import a CLI entrypoint or Vitest-bearing root barrel.

Use `JobManager` with these public operations (all async):

```ts
submit(request: RunRequest, idempotencyKey: string): Promise<{replayed: boolean; snapshot: RunSnapshot}>;
getSnapshot(runId: string): Promise<RunSnapshot>;
cancel(runId: string): Promise<RunSnapshot>;
cancelByKey(idempotencyKey: string): Promise<RunSnapshot>;
acknowledge(runId: string, interactionId: string,
  ack: {driver_status: 'completed' | 'failed'; message?: string}): Promise<RunSnapshot>;
getResult(runId: string): Promise<RunnerResult>;
shutdown(): Promise<void>;
```

Define a small typed RunnerError with `code`, `httpStatus` and safe message, not route code that matches arbitrary Error.message text. Missing run/key lookup returns NOT_FOUND; cancelByKey never creates work. A namespace is a stable operator configuration value, not the raw bearer token; token rotation must not silently destroy retained idempotency ownership.

Inject `execute(context): Promise<ExecutionEvidence>`, clock and newId into the manager. Context contains runId, validated request, resolved operator profile, absolute run/data/results directories and AbortSignal. ExecutionEvidence contains the RunnerResult plus private registered artifact paths. Its promise settles ONLY after owned children/listeners are stopped, including on abort. The API never receives private absolute artifact paths. The manager derives waiting_for_interaction from the validated live channel and prevents a late executor settlement overwriting a terminal cancellation/error.

JobStore owns atomic local state. Each authoritative run record contains run ID, namespace/key hash, canonical request hash, validated original request, state/timestamps and result/registered artifact metadata. An index is derived/rebuildable: if the process crashes between writing a run record and its index, startup must reconstruct the same key->run mapping before accepting starts. Test this failure window. Do not try to make two unrelated JSON renames into a transaction by claiming they are atomic together. A single process/root lock serializes mutations; independent replicas have independent roots and native ports.

Startup recovery requires prior process-tree termination by an isolated container/process supervisor. A stale owner lock is not permission to kill stored PIDs or resume native sessions. Recover interrupted run metadata to error and preserve key replay. If ownership cannot be proved, refuse new starts with an operational diagnostic. Document the supported supervised startup/recovery procedure, including lock handling; do not leave an unexplained stale-lock dead end.

HTTP constructors are import-safe `createRunnerServer(dependencies)` (new Fastify fork) and `createRunnerApp(dependencies)` (legacy Express fork). main/serve command owns listening/signals. Both use the same wire fixtures and semantics.

## Native driver

In the new conformance package define an optional EngagementDriver with `publish(interaction): Promise<void>`, `close(interactionId): Promise<void>` and `recordOutcome(outcome): Promise<void>` (outcome method can be optional if an existing outcome exporter is used). The file implementation lives with native runner code; the host reads the documented local files without importing Vitest.

Only the native engine observes/evaluates protocol events. showInstructions publishes and returns promptly. ACK is a host-side driver record, never a protocol outcome. Default human CLI behavior remains unchanged.

## Go Evidence API

Use `runner.Parse(r io.Reader) (*runner.RunnerResult, error)` under pkg/externaltests/runner, with `Raw []byte` tagged json:"-". Use `externaltests.Normalize(result *runner.RunnerResult, context NormalizationContext) (*ConformanceResult, error)` and `externaltests.ValidateNormalized(doc *ConformanceResult) error`. Context carries real workflow identity and already stored/verified raw/artifact refs. No I/O/network in normalization.

The parser may preserve native extension fields in Raw/json.RawMessage, but required version/identity/selection/status/counts are validated. The final document strictly obeys the supplied v1.1 schema. Do not use a generic map to bypass that schema.

## Credimi workflow/collector

Keep StepCI operation templates static and call the existing StepCI activity as workflows/custom.go does. Workflow polls use Temporal time. `engine_parameters` belongs to the test engine; `parameters` belongs to the existing mobile action. Only wallet_driver=true consumes a device. For MVP that mode requires one selected scenario and one action. The mobile child workflow runs on the existing PipelineTaskQueue; its activity config routes actual mobile work to the host runner task queue. Do not route a workflow to an activity-only queue.

Collection is an app-bound activity with real HTTP/filesystem/storage effects; workflow code receives only small summaries and refs. Store on the root pipeline result using telemetry/root run identity already propagated by Credimi. The offline Evidence module does not call Credimi, the runner or the SUT.
