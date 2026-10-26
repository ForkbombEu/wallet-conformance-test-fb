# Evidence semantics and output rules

There are three distinct results: execution status; native suite/scenario outcomes; and successful import into Credimi. Preserve all three.

## Conservative aggregation

1. Preserve every native assertion and every native scenario outcome, including native INCONCLUSIVE. Neither ACK nor a successful HTTP/mobile action changes them.
2. A native scenario FAIL or a separately identifiable failed conformance assertion establishes `fail`. A native INCONCLUSIVE remains `inconclusive` at scenario level even when the upstream strict PASS matcher represents it as a failed Vitest assertion.
3. If an INCONCLUSIVE scenario and failed assertions cannot be reliably associated, aggregate as `inconclusive` with an explicit limitation that native failed assertions also exist; retain their native FAILED status. Do not use string matching on an error sentence to pretend this association is known. Conversely, a failing payload assertion when all observed scenarios passed must make the suite `fail`.
4. If cancelled/timed out/errored, result is `partial` when useful assertions completed, otherwise `inconclusive` (or not_tested when none ran and no protocol result exists). Never turn incomplete execution into PASS. A cancelled run may still contain individual real FAIL results.
5. With no assertions, use not_tested. With NOT_REACHED/skipped assertions and some executed assertions, use partial unless a proven failure dominates. Only a complete, nonempty execution with all applicable assertions and scenario outcomes passed can be pass.

Table tests must include: clean pass; failed assertion with PASS scenario; INCONCLUSIVE + strict matcher failure; mixed explicit FAIL + INCONCLUSIVE; NOT_REACHED; zero assertions; failed setup; cancel after one passing assertion; and a malformed export.

## Source of truth v1.1

The supplied JSON schema is authoritative for the final Credimi document. It uses snake_case and additionalProperties:false in many places. Do not add `flat_test_results`; the taxonomy mentions it, but the actual v1.1 schema does not allow it. Do not change the schema to accommodate your implementation.

For the first importer use the EXISTING profile `third-party-conformance-ingestion` and claim `external-conformance-test-result-ingested` (internal_id `credimi.evidence.external.conformance_result_ingested_and_mapped.v1`). Successful ingestion sets that claim to pass; it says ingestion succeeded, not that the SUT conforms. Set run.overall_result (and optional top-level overall_result) from the external result, independently. Keep native assertions in the claim's observed_outputs, with counts, selection, native outcome, engine revision and explicit limitations. Unknown upstream IDs remain unmapped; do not manufacture one Credimi evidence claim per WP_/CI_ ID.

The target is the real wallet/issuer/verifier, with external_suite_name/version stored on target, and provenance/coverage_mode in environment.metadata. Set evidence_type to `["third_party_result"]`. Put raw JSON references under raw_evidence_refs.external_test_output_refs and evidence_artifacts type external_test_result. Preserve artifact hashes in hash_manifest. workflow_id/run_id/timestamps come from the real caller; unit fixtures use explicitly synthetic IDs.

Do not copy all normative references from the registry/taxonomy onto imported results. No approved per-assertion mapping exists in this pack. The registry's legal references contain fields not accepted by the strict runtime schema, another reason not to copy them blindly. A later reviewed mapping task may add justified references.

The existing ingestion profile title mentions OpenID/WE BUILD. Retain the existing slug; identify PagoPA in the result's profile_title/observed_outputs and document this reuse without editing the registry or claiming these tools are OpenID Foundation certification tests. PagoPA tools are not established here as the official IPZS validators.

Evidence importer is offline: reader/byte input only, no fetching request_uri, no ResolveDeeplink, no shell command, no signature verification claim. The existing JWT decoder only decodes. Artifact collection belongs to Credimi activities, before the offline import. Schema validation does not prove truth or certification.
