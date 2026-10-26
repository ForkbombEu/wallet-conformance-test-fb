# Implementation decision

Build two small independent runner APIs directly beside the PagoPA tools. Use Credimi's existing StepCI activity for short control operations and Temporal/mobile workflows for the asynchronous wallet loop. Add an offline importer to eudi-conformance-evidence, already a Credimi dependency. Keep Capture as a stateful issuer/verifier test fixture.

First prove one presentation scenario with the new ITWCT fork. First legacy run reuses ForkbombEu/wallet-conformance-test-fb and its generic issuance smoke; do not rebuild that generic mode or claim it validates the Italian profile. No upstream merge is required for the first vertical slice; assess upstream synchronization separately.

New filenames in these prompts are deliberate proposed files. Existing filenames were checked against the pins below on 26 October 2026. No implementation or real-wallet run was performed to create this pack. Follow the dependency order, one prompt per model turn, and retain task outputs. Run prompt 00 once in each repository before its tasks.

MVP intentionally has one active run per replica and one selected wallet scenario per Credimi workflow. Full matrix assertions within that scenario are retained. It does not initially cover wallet-provider/wallet-instance categories, QR presentation, generic legacy RP discovery, or browser authorization automation. Each unsupported mode fails explicitly rather than silently narrowing coverage.
