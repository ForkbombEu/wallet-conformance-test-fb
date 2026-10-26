# Credimi Conformance Artifacts v1.1

This package is the rationalized source-of-truth set for Credimi EUDI conformance/evidence work.

## Files

1. `credimi-conformance-source-scope-v1.1.yaml` — what source families are in/out of scope.
2. `credimi-flat-conformance-test-list-v1.1.md` — human-readable atomic test list.
3. `credimi-conformance-evidence-registry-v1.1.yaml` — machine-readable evidence-claim registry.
4. `credimi-conformance-result.schema.v1.1.json` — output contract for normalized run results.
5. `credimi-conformance-aggregation-taxonomy-v1.1.yaml` — runtime/business-logic taxonomy mapping pipelines to test/evidence results.
6. `credimi-trust-helper-backlog-v1.1.md` — implementation backlog for helper checks.
7. `credimi-eudi-regulatory-map-short-v1.1.md` — concise public/human-facing map.

## How files 2, 3 and 4 hang together

### 2 — Flat test list

The flat test list answers: **what individual tests do humans need to understand/write/review?**

It is human-facing and test-authoring-oriented.

### 3 — Evidence registry

The evidence registry answers: **what machine-readable evidence claims exist, and what normative references support them?**

It is the product taxonomy / source-of-truth for evidence claims.

### 4 — Result schema

The result schema answers: **what should Credimi output after a concrete pipeline run?**

It validates actual run results.

## Relationship

```text
Flat test list
  human atomic test vocabulary

Evidence registry
  machine-readable claim/reference vocabulary

Result schema
  machine-readable runtime output contract

Aggregation taxonomy
  maps real pipelines to flat_test_results + evidence_claim_results
```

In practice:

```text
Credimi pipeline runs
  ↓
Aggregation taxonomy evaluates metadata and step results
  ↓
Output follows conformance-result.schema
  ↓
Output references evidence claims from registry
  ↓
Humans can understand the emitted tests through the flat test list
```
