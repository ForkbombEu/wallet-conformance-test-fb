# Credimi Trust Helper Backlog v0.2

This backlog supports the human-readable evidence-claim model introduced in
`credimi-conformance-evidence-registry-v0.4.yaml`.

## Key vocabulary change

Previous draft language:

```text
W-PROT-ISS-01
CRED-WALLET-ISS-001
```

New product language:

```text
Evidence claim: Wallet receives PID/EAA issuance request
Slug: wallet-receives-pid-eaa-issuance-request
Internal ID: credimi.evidence.wallet.issuance.receives_pid_eaa_request.v1
```

The helper should emit results against `slug` and `internal_id`, while the UI should primarily show `title`.

---

## 1. Architecture decision

Build the trust helper first as a **Go library + CLI**, then expose it as a service only if needed.

Recommended shape:

```text
credimi-trust-helper
├── cmd/credimi-trust-helper
├── pkg/fetch
├── pkg/schema
├── pkg/signature
├── pkg/x509
├── pkg/revocation
├── pkg/register
├── pkg/entitlement
├── pkg/fixtures
└── pkg/report
```

The CLI should be callable from StepCI/YAML or from a Credimi pipeline helper step.

Example:

```sh
credimi-trust-helper check-rp-request \
  --presentation-request presentation-request.json \
  --rp-register-url https://... \
  --lotl-url https://... \
  --out trust-result.json
```

---

## 2. Output contract

Every helper command should emit JSON with this common envelope:

```json
{
  "schema_version": "0.2",
  "claim_slug": "rp-requested-attributes-match-entitlements",
  "claim_title": "Relying Party requests only registered attributes",
  "internal_id": "credimi.evidence.rp.entitlement.requested_attributes_match_entitlements.v1",
  "result": "pass",
  "subject": {
    "actor_type": "relying_party",
    "identifier": "example-rp-id"
  },
  "checks": [
    {
      "id": "register_entry_present",
      "title": "Register entry is present",
      "result": "pass",
      "evidence": ["register-response.json"]
    }
  ],
  "artifacts": [
    {
      "type": "register_response",
      "ref": "register-response.json",
      "sha256": "..."
    }
  ],
  "limitations": []
}
```

Result enum:

```text
pass
fail
warning
partial
not_tested
manual_review
inconclusive
```

---

## 3. Priority 1 — Normalized evidence layer

### B-001 — Generate `conformance_result.json`

Goal: derive a normalized, reviewer-facing evidence result from raw Temporal/StepCI/Maestro outputs.

Inputs:
- Temporal input
- Temporal output
- step-level input/output
- screenshots
- videos
- external test results
- evidence claim slugs / internal IDs

Outputs:
- `conformance_result.json`
- optional `hash_manifest.json`
- optional PDF report later

Important:
- The UI should show `title`.
- URLs/filters should use `slug`.
- APIs/database references may use `internal_id`.

### B-002 — Add evidence claim mappings to pipeline/action definitions

Allow action definitions to declare:

```yaml
conformance:
  evidence_contributions:
    - slug: wallet-receives-pid-eaa-issuance-request
      internal_id: credimi.evidence.wallet.issuance.receives_pid_eaa_request.v1
      contribution_level: partial
      evidence_type:
        - behavioral_black_box
```

For full pipeline profiles:

```yaml
conformance:
  profile_slug: wallet-protocols-and-user-flow
  expected_claims:
    - wallet-receives-pid-eaa-issuance-request
    - wallet-completes-pid-eaa-issuance
```

### B-003 — Hash manifest

Create hashes for:
- Temporal input/output
- step input/output
- videos
- screenshots
- metadata snapshots
- external conformance test outputs

Output:

```json
{
  "algorithm": "sha256",
  "artifacts": [
    {
      "ref": "temporal-output.json",
      "sha256": "..."
    }
  ]
}
```

---

## 4. Priority 2 — External conformance test ingestion

### B-010 — External result adapter

Inputs:
- OpenID Foundation conformance output
- WE BUILD test output
- headless Wallet test output

Outputs:
- raw external output stored unchanged
- normalized `evidence_claim_results[]`
- mapping to registry evidence claims

### B-011 — Assertion mapping file

Example:

```yaml
external_suite: openid-conformance
external_test_id: openid4vp-response-mode-direct-post-jwt
maps_to:
  - slug: wallet-processes-remote-presentation-request
    internal_id: credimi.evidence.wallet.presentation.processes_remote_request.v1
  - slug: verifier-generates-valid-presentation-request
    internal_id: credimi.evidence.rp.verifier.generates_valid_presentation_request.v1
result_mapping:
  PASSED: pass
  FAILED: fail
```

---

## 5. Priority 3 — RP registration and entitlement checks

This is strategically important because of Implementing Regulation EU 2025/848.

### B-020 — RP register fetcher

Fetch human/machine-readable RP registration data.

Inputs:
- RP identifier
- register base URL or discovery config
- optional national profile config

Outputs:
- raw register response
- normalized RP record

Maps mainly to:
- `rp-registration-information-available`
- `rp-requested-attributes-match-entitlements`

Blocked by:
- concrete national / WE BUILD register schema

### B-021 — RP entitlement parser

Parse RP entitlements from:
- national register entry
- RP registration certificate
- presentation request metadata
- WE BUILD mock register/list

Output normalized entitlement model:

```json
{
  "rp_identifier": "example-rp",
  "entitlements": [
    {
      "credential_type": "pid",
      "attribute": "age_over_18",
      "purpose": "age_verification",
      "legal_basis_or_scheme": "..."
    }
  ]
}
```

### B-022 — Presentation request vs entitlement matcher

Compare:
- requested attributes in OpenID4VP presentation request
- RP registered entitlements

Results:
- pass: request is within entitlement
- fail: request includes unauthorized attributes
- warning: entitlement cannot be resolved
- inconclusive: request cannot be parsed

Maps mainly to:
- `rp-requested-attributes-match-entitlements`
- `rp-registration-certificate-entitlement-match`

### B-023 — RP access certificate parser

Parse certificate fields and policy references.

Checks:
- certificate present
- subject/identifier present
- issuer chain available
- policy OID / policy URL present if required
- validity period
- key usage / extended key usage where specified
- binding to RP identifier/register entry

Maps mainly to:
- `rp-access-certificate-validation`

Blocked by:
- final certificate profile / policy OIDs / ETSI profile details

### B-024 — RP registration certificate parser

Checks:
- certificate present where applicable
- registered attributes present
- intended use present
- validity period
- revocation pointer/status mechanism
- consistency with register entry

Maps mainly to:
- `rp-registration-certificate-entitlement-match`

Blocked by:
- final profile / certificate extension model

---

## 6. Priority 4 — LoTL / TL / trust-list validation

### B-030 — LoTL fetcher

Maps mainly to:
- `trusted-list-discovery`

Inputs:
- LoTL URL
- expected content type
- profile config

Outputs:
- raw LoTL snapshot
- hash
- discovered TL URLs

### B-031 — LoTL/TL schema validation

Maps mainly to:
- `trusted-list-schema-signature-and-freshness-validation`

Validate JSON/XML against profile schemas.

Blocked by:
- final WE BUILD / Commission / Member State schemas

### B-032 — LoTL/TL signature or seal validation

Maps mainly to:
- `trusted-list-schema-signature-and-freshness-validation`

Support likely profiles:
- JAdES
- XAdES
- XMLDSig
- detached JWS/JWS JSON serialization
- plain X.509 path validation where applicable

Do not hard-code until profiles are concrete.

### B-033 — Trust anchor resolver

Resolve trust anchors from:
- Commission-published trust anchors
- configured WE BUILD trust anchors
- local sandbox trust anchors

Output must explicitly label trust mode:

```text
production_trust
pilot_trust
sandbox_trust
mock_trust
```

### B-034 — Actor resolver

Maps mainly to:
- `trusted-actor-status-resolution`

Resolve actors:
- Wallet Provider
- PID Provider
- Attestation Provider
- RP
- Registrar
- Access Certificate Authority
- Registration Certificate Authority

Return:
- actor found/not found
- status
- validity interval
- entitlements
- relevant certificates
- revocation pointers

---

## 7. Priority 5 — Certificate and revocation checks

### B-040 — X.509 path validation

Use Go `crypto/x509` where enough; use OpenSSL CLI/library where profile support is easier.

Checks:
- chain builds to expected trust anchor
- validity period
- key usage
- extended key usage
- certificate policies
- subject / SAN / custom extensions
- issuer constraints

Maps mainly to:
- `rp-access-certificate-validation`
- `rp-registration-certificate-entitlement-match`
- `verifier-validates-credential-signature-status-and-issuer-trust`

### B-041 — Revocation checker

Support pluggable revocation mechanisms:
- CRL
- OCSP
- status list
- custom WE BUILD / ARF list
- short-lived certificate policy

Maps mainly to:
- `issuer-validity-status-and-revocation`
- `rp-access-certificate-validation`
- `verifier-validates-credential-signature-status-and-issuer-trust`

Output:

```json
{
  "claim_slug": "issuer-validity-status-and-revocation",
  "result": "pass",
  "mechanism": "ocsp",
  "status": "good",
  "checked_at": "2026-05-19T..."
}
```

### B-042 — Negative certificate fixtures

Create fixtures:
- expired RP access cert
- revoked RP access cert
- RP cert with mismatched identifier
- registration cert with unauthorized attributes
- issuer cert not chaining to trusted anchor
- issuer present but suspended
- missing revocation endpoint
- invalid signature/seal

---

## 8. Priority 6 — Issuer / EAA / PID validation helpers

### B-050 — Issuer metadata validator

Maps mainly to:
- `pid-provider-issues-pid-to-wallet`
- `eaa-provider-issues-eaa-to-wallet`

Checks:
- `.well-known` reachable
- expected fields present
- issuer identifier consistent with credential offer
- signing certificate / trust evidence where applicable
- RP access certificate if provider authenticates as relying party

### B-051 — Credential offer validator

Maps mainly to:
- `wallet-receives-pid-eaa-issuance-request`
- `pid-provider-issues-pid-to-wallet`
- `eaa-provider-issues-eaa-to-wallet`

Checks:
- offer syntax
- credential issuer URL
- credential configuration IDs
- grant types
- deeplink format
- issuer metadata linkage

### B-052 — Issued credential validator

Best done headless / verifier-side, not via real Wallet UI.

Maps mainly to:
- `pid-provider-issues-pid-to-wallet`
- `eaa-provider-issues-eaa-to-wallet`
- `verifier-validates-credential-signature-status-and-issuer-trust`

Checks:
- credential type
- credential format
- issuer signature
- validity period
- status/revocation reference
- required claims
- cryptographic binding where inspectable

### B-053 — PID validity status checker

From 2024/2977 Article 5.

Maps mainly to:
- `issuer-validity-status-and-revocation`

Checks:
- provider has public validity-status policy
- status is available
- status does not reveal unnecessary personal data
- revoked credential fixture is rejected by verifier

---

## 9. Priority 7 — Wallet Unit Attestation helpers

### B-060 — WUA fixture library

Maps mainly to:
- `issuer-validates-wallet-unit-attestation`

Fixtures:
- valid WUA
- missing WUA
- expired WUA
- revoked WUA
- WUA signed by untrusted Wallet Provider
- WUA for wrong wallet solution
- WUA with mismatched wallet instance

### B-061 — Issuer WUA validation test

Best execution mode:
- headless Wallet
- OpenID/WE BUILD issuer conformance test
- REST-to-REST pipeline

Evidence:
- WUA fixture
- issuer response
- external test raw output
- normalized mapped result

---

## 10. Priority 8 — Report generation

### B-070 — PDF renderer

Input:
- `conformance_result.json`
- hash manifest
- selected artifacts

Output sections:
1. Executive summary
2. Target under test
3. Test profile
4. Evidence claims
5. Official references
6. Evidence artifacts
7. Raw evidence references
8. Limitations
9. Hash manifest

### B-071 — CAB/member-state view

A filtered report that hides implementation noise and shows:

```text
Evidence claim
Official legal / ARF / WE BUILD references
Result
Evidence artifact
Limitation
```

---

## 11. Open questions to resolve with WE BUILD / Member States

1. What are the final machine-readable schemas for LoTL/TL/registers?
2. What signature/seal profile will be used: JAdES, XAdES, XMLDSig, JWS, other?
3. What are the exact RP access certificate profiles?
4. What are the exact RP registration certificate profiles?
5. How are RP entitlements represented?
6. How are issuer/provider entitlements represented?
7. Which revocation mechanisms are mandatory or accepted?
8. How should sandbox/pilot lists be distinguished from production lists?
9. Are negative fixtures acceptable as evidence for wallet behavior?
10. Which external OpenID/WE BUILD test outputs are acceptable as assurance documentation?

---

## 12. Priority 9 — Qualified trust services / signature / seal / timestamp helpers

This section was added after reviewing the 2025 trust-service implementing acts uploaded later.
These helpers are mostly relevant to trust-helper work, external assurance evidence, and qualified-signature/seal/timestamp validation. They are **not** the first priority for real Wallet UI automation.

### B-080 — Remote QSCD/QSealCD management evidence collector

Maps mainly to:
- `remote-qualified-signature-seal-device-management-standards`

Inputs:
- QTSP disclosure statement or practice statement
- conformity assessment report reference
- remote QSCD/QSealCD management assurance evidence
- reference standard mapping

Checks:
- service claims management of remote qualified electronic signature creation devices or remote qualified electronic seal creation devices
- declared standard/profile references are present
- audit/conformity report reference is present

Output:
- `remote_qscd_management_assurance_result.json`

### B-081 — Qualified trust service notification / supervisory verification evidence collector

Maps mainly to:
- `qualified-trust-service-notification-and-verification-evidence`

Inputs:
- supervisory body public information
- notification information
- conformity assessment report reference
- verification methodology reference

Checks:
- required public transparency information is available
- contact / channel / methodology / documentation list are available where applicable
- notification evidence can be linked to the evidence bundle

Output:
- `qts_notification_verification_result.json`

### B-082 — Qualified time-stamp validator

Maps mainly to:
- `qualified-time-stamp-service-validation`

Inputs:
- timestamp token
- signed/sealed evidence bundle or hash
- time-stamp service information
- trusted list / certificate chain evidence

Checks:
- timestamp token validates cryptographically
- time-stamp certificate path resolves to accepted trust anchor
- revocation/status is checked where applicable
- timestamp policy/profile is identified

Output:
- `qualified_timestamp_validation_result.json`

Credimi use case:
- timestamping conformance evidence bundles
- validating external timestamp evidence attached to reports

### B-083 — Qualified validation service adapter

Maps mainly to:
- `qualified-validation-service-for-signatures-and-seals`

Inputs:
- signed/sealed object
- validation service endpoint or output
- validation policy reference

Checks:
- service result is parseable
- validation status is pass/fail/inconclusive
- qualified status is identified where provided
- raw validation report is preserved

Output:
- `qualified_validation_service_result.json`

Important:
- Credimi may call or ingest such services, but should not imply it is itself a qualified validation service.

### B-084 — Qualified certificate profile validator

Maps mainly to:
- `qualified-certificate-profile-validation`

Inputs:
- qualified certificate
- certificate chain
- trusted list resolution result
- certificate policy/profile config

Checks:
- certificate profile fields
- QCStatements where applicable
- certificate policy identifiers
- key usage / extended key usage
- validity period
- chain to qualified trust anchor
- revocation status

Output:
- `qualified_certificate_profile_validation_result.json`

### B-085 — QERDS evidence collector

Maps mainly to:
- `qualified-electronic-registered-delivery-service-evidence`

Inputs:
- delivery proof
- sending/receiving proof
- service policy reference
- QERDS interoperability evidence if applicable

Checks:
- evidence artifacts are available
- sender/recipient/service identifiers are present
- delivery proof can be linked to tested flow or evidence bundle

Output:
- `qerds_evidence_result.json`

Note:
- Peripheral to the first Credimi conformance campaign unless QERDS is used for evidence delivery or tested explicitly.

### B-086 — Electronic signature/seal validation process helper

Maps mainly to:
- `electronic-signature-seal-validation-process`

Inputs:
- signed object or sealed object
- certificate chain
- trusted list / trust anchor resolution result
- revocation status
- validation policy

Checks:
- signature/seal cryptographic validity
- certificate validity and revocation
- trusted list resolution
- qualified or advanced status where determinable
- validation report generation

Output:
- `signature_seal_validation_result.json`

Credimi use cases:
- validating signed/sealed LoTL/TL material
- validating signed/sealed reports
- validating signed/sealed credential-related evidence
- validating qualified signature/seal evidence returned by third-party services

---

## 13. Open questions added by the 2025 trust-service acts

11. Will Credimi evidence bundles be timestamped with a qualified electronic time stamp, or only hashed/signed internally?
12. Do we need to validate qualified electronic signatures/seals directly, or is it enough to ingest validation reports from a qualified validation service?
13. Do WE BUILD / Member State trust-list signatures rely on ETSI AdES validation profiles, XMLDSig, JAdES, or another profile?
14. Will RP access/registration certificates reuse qualified certificate profile elements or separate wallet-specific profiles?
15. Is QERDS relevant to Credimi evidence delivery, or should it stay explicitly out of scope for now?
16. Should QTSP notification/conformity evidence be shown in Credimi as manual assurance evidence for issuers/verifiers using qualified services?


---

## Addendum v0.4 — eID assurance level evidence (EU 2015/1502)

The uploaded Commission Implementing Regulation (EU) 2015/1502 defines the minimum technical specifications and procedures for assurance levels low, substantial and high for electronic identification means. It is relevant to Credimi mainly as certification / assurance documentation, not as a normal black-box wallet automation test.

### B-080 — eID scheme assurance-level evidence ingestion

Maps mainly to:

```text
wallet-eid-scheme-assurance-level-evidence
```

Inputs:
- eID scheme name / identifier
- claimed assurance level: low, substantial, high
- certification or conformity assessment report
- scheme documentation for enrolment, eID means management, authentication, management and organisation
- optional national notification / certified wallet list references

Output:

```json
{
  "claim_slug": "wallet-eid-scheme-assurance-level-evidence",
  "claim_title": "Wallet/eID scheme assurance level evidence is available",
  "result": "manual_review",
  "claimed_assurance_level": "high",
  "evidence": [
    "certification-assessment-report.pdf",
    "scheme-documentation.pdf"
  ],
  "limitations": [
    "Credimi collects and maps assurance evidence; it does not itself determine notified eID assurance level."
  ]
}
```

### B-081 — Assurance-level checklist renderer

Render a reviewer-facing checklist based on the main 2015/1502 Annex categories:

- enrolment
- electronic identification means management
- authentication
- management and organisation

For each category, allow evidence attachment and review status:

```text
provided
missing
not_applicable
manual_review
```

This belongs in certification / assurance-support UX, not in the basic Maestro Action editor.

---

# ETSI standards addendum v1.1

This addendum adds the ETSI standards layer from `ETSICatalog.csv` to the trust-helper and evidence-claim implementation backlog.

## Vocabulary addition

Evidence results may now include:

```text
evidence_type: standards_validation
artifact types:
  - etsi_standard_reference
  - etsi_profile_validation_result
  - standards_profile_validation_result
  - certificate_profile_validation_result
  - timestamp_validation_result
  - validation_service_result
  - signature_validation_result
```

## P0/P1 — EAA/PID profile validation

### B-080 — EAA/PID issuance profile validator

Maps mainly to:

```text
wallet-receives-pid-eaa-issuance-request
wallet-completes-pid-eaa-issuance
pid-provider-issues-pid-to-wallet
eaa-provider-issues-eaa-to-wallet
eaa-pid-issuance-profile-validation
```

Standards:

- [ETSI TS 119 472-3 V1.1.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11947203/01.01.01_60/ts_11947203v010101p.pdf) — profiles for issuance of EAA or PID.
- [ETSI TS 119 471 V1.1.1 (2025-05)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119471/01.01.01_60/ts_119471v010101p.pdf) — policy and security requirements for EAA service providers.
- [ETSI TS 119 478 V1.1.1 (2026-01)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119478/01.01.01_60/ts_119478v010101p.pdf) — authentic-source interfaces.
- [ETSI TR 119 479-1 V1.1.1 (2026-05)](https://www.etsi.org/deliver/etsi_tr/119400_119499/11947901/01.01.01_60/tr_11947901v010101p.pdf) — foundational EAA concepts and architecture.

Checks:

- issuer metadata references expected EAA/PID profile;
- credential offer uses expected credential configuration/profile;
- authentic-source interface evidence is present where required;
- profile validation result is attached to `conformance_result.json`.

### B-081 — EAA/PID presentation profile validator

Maps mainly to:

```text
wallet-processes-remote-presentation-request
wallet-displays-rp-identity-and-requested-attributes
wallet-selective-disclosure
verifier-generates-valid-presentation-request
eaa-pid-presentation-profile-validation
```

Standards:

- [ETSI TS 119 472-2 V1.2.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11947202/01.02.01_60/ts_11947202v010201p.pdf) — profiles for presentation of EAA or PID to Relying Parties.
- [ETSI TS 119 475 V1.2.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119475/01.02.01_60/ts_119475v010201p.pdf) — relying-party attributes supporting Wallet user authorisation decisions.
- [ETSI TR 119 476 V1.2.1 (2024-07)](https://www.etsi.org/deliver/etsi_tr/119400_119499/119476/01.02.01_60/tr_119476v010201p.pdf) — selective disclosure and ZKP analysis.
- [ETSI TR 119 476-1 V1.3.1 (2025-08)](https://www.etsi.org/deliver/etsi_tr/119400_119499/11947601/01.03.01_60/tr_11947601v010301p.pdf) — selective disclosure and ZKP feasibility study.

Checks:

- presentation request uses expected profile;
- requested attributes are parseable;
- relying-party attributes can be mapped to user-authorization context;
- selective disclosure result can be inspected verifier-side or through a headless test.

## P1 — Relying Party attributes and entitlement checks

### B-090 — ETSI RP attribute checker

Maps mainly to:

```text
rp-requested-attributes-match-entitlements
rp-registration-certificate-entitlement-match
relying-party-attributes-standards-validation
```

Standards:

- [ETSI TS 119 475 V1.2.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119475/01.02.01_60/ts_119475v010201p.pdf) — relying-party attributes supporting Wallet user authorization decisions.
- [ETSI TS 119 472-2 V1.2.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11947202/01.02.01_60/ts_11947202v010201p.pdf) — EAA/PID presentation profile.

Checks:

- RP request exposes attributes in a machine-readable way;
- requested attributes map to registered entitlements;
- Wallet-facing display values can be compared with expected RP attributes.

## P1/P2 — Certificate profile validation

### B-100 — ETSI certificate-profile validator

Maps mainly to:

```text
rp-access-certificate-validation
rp-registration-certificate-entitlement-match
qualified-certificate-profile-validation
certificate-profile-standards-validation
```

Standards:

- [ETSI EN 319 411-1 V1.5.1 (2025-04)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941101/01.05.01_60/en_31941101v010501p.pdf) — policy/security requirements for certificate-issuing TSPs.
- [ETSI EN 319 411-2 V2.6.1 (2025-06)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941102/02.06.01_60/en_31941102v020601p.pdf) — requirements for TSPs issuing EU qualified certificates.
- [ETSI EN 319 412-1 V1.7.1 (2026-05)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941201/01.07.01_60/en_31941201v010701p.pdf) — certificate profile overview and common structures.
- [ETSI EN 319 412-2 V2.5.0 (2026-05)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941202/02.05.00_20/en_31941202v020500a.pdf) — certificate profile for natural persons.
- [ETSI EN 319 412-3 V1.4.0 (2026-04)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941203/01.04.00_20/en_31941203v010400a.pdf) — certificate profile for legal persons.
- [ETSI EN 319 412-4 V1.4.1 (2025-06)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941204/01.04.01_60/en_31941204v010401p.pdf) — certificate profile for web site certificates.
- [ETSI EN 319 412-5 V2.6.1 (2026-05)](https://www.etsi.org/deliver/etsi_en/319400_319499/31941205/02.06.01_60/en_31941205v020601p.pdf) — qualified certificate statements.
- [ETSI TS 119 412-6 V1.2.1 (2026-04)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11941206/01.02.01_60/ts_11941206v010201p.pdf) — distributed ledger identifiers in certificates.
- [ETSI TS 119 495 V1.8.1 (2026-04)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119495/01.08.01_60/ts_119495v010801p.pdf) — sector-specific certificate/TSP requirements for open banking.

Checks:

- certificate parses;
- certificate profile is recognized;
- QCStatements and relevant extensions are present where expected;
- policy OIDs / policy URLs are present where required;
- certificate subject/SAN/identifier binding can be compared with issuer/RP/register evidence.

## P2 — Validation service and signature/seal validation

### B-110 — ETSI validation-service result adapter

Maps mainly to:

```text
verifier-validates-credential-signature-status-and-issuer-trust
qualified-validation-service-for-signatures-and-seals
electronic-signature-seal-validation-process
qualified-validation-service-standards-validation
```

Standards:

- [ETSI TS 119 441 V1.3.1 (2025-10)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119441/01.03.01_60/ts_119441v010301p.pdf) — policy requirements for TSPs providing signature validation services.
- [ETSI TS 119 442 V1.1.1 (2019-02)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119442/01.01.01_60/ts_119442v010101p.pdf) — protocol profiles for validation services.

Checks:

- preserve raw validation-service result;
- normalize result into `evidence_claim_results[]`;
- attach certificate-chain, signature/seal and revocation outputs;
- mark whether result is internal technical validation or qualified validation-service evidence.

## P2/P3 — Timestamp validation

### B-120 — ETSI timestamp validator / optional QTSP timestamp adapter

Maps mainly to:

```text
qualified-time-stamp-service-validation
timestamping-standards-validation
```

Standards:

- [ETSI EN 319 421 V1.3.1 (2025-07)](https://www.etsi.org/deliver/etsi_en/319400_319499/319421/01.03.01_60/en_319421v010301p.pdf) — policy and security requirements for time-stamp providers.
- [ETSI EN 319 422 V1.1.1 (2016-03)](https://www.etsi.org/deliver/etsi_en/319400_319499/319422/01.01.01_60/en_319422v010101p.pdf) — time-stamping protocol and token profiles.

Checks:

- timestamp token parses;
- timestamp signature validates;
- time-stamp provider trust can be resolved;
- evidence bundle can optionally include QTSP timestamp result.

Not MVP blocker.

## P3 — Remote signature/seal creation and Wallet trust-service interfaces

### B-130 — Remote signature/seal standards adapter

Maps mainly to:

```text
remote-qualified-signature-seal-device-management-standards
remote-signature-creation-standards-validation
```

Standards:

- [ETSI TS 119 431-1 V1.3.1 (2024-12)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11943101/01.03.01_60/ts_11943101v010301p.pdf) — policy/security requirements for remote QSCD/SCDev operation.
- [ETSI TS 119 431-2 V1.2.1 (2023-06)](https://www.etsi.org/deliver/etsi_ts/119400_119499/11943102/01.02.01_60/ts_11943102v010201p.pdf) — requirements for AdES digital signature creation service components.
- [ETSI TS 119 432 V1.3.1 (2026-03)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119432/01.03.01_60/ts_119432v010301p.pdf) — protocols for remote digital signature creation.
- [ETSI TS 119 461 V2.1.1 (2025-02)](https://www.etsi.org/deliver/etsi_ts/119400_119499/119461/02.01.01_60/ts_119461v020101p.pdf) — trust-service components providing identity proofing.
- [ETSI TR 119 462 V1.1.1 (2026-03)](https://www.etsi.org/deliver/etsi_tr/119400_119499/119462/01.01.01_60/tr_119462v010101p.pdf) — Wallet interfaces for trust services and signing.

Checks:

- remote signing protocol evidence can be captured;
- service policy/security evidence can be referenced;
- identity-proofing component evidence can be attached where relevant.

Not MVP blocker.

## P3 — TSP policy and conformity-assessment evidence

### B-140 — ETSI TSP policy/conformity evidence adapter

Maps mainly to:

```text
wallet-certification-assurance-bundle
qualified-trust-service-notification-and-verification-evidence
trusted-list-schema-signature-and-freshness-validation
```

Standards:

- [ETSI EN 319 401 V3.2.1 (2026-01)](https://www.etsi.org/deliver/etsi_en/319400_319499/319401/03.02.01_60/en_319401v030201p.pdf) — general policy requirements for TSPs.
- [ETSI EN 319 403-1 V2.3.1 (2020-06)](https://www.etsi.org/deliver/etsi_en/319400_319499/31940301/02.03.01_60/en_31940301v020301p.pdf) — TSP conformity assessment requirements.
- [ETSI TR 119 404 V1.1.1 (2023-02)](https://www.etsi.org/deliver/etsi_tr/119400_119499/119404/01.01.01_60/tr_119404v010101p.pdf) — NIS2 impact on eIDAS standards.

Checks:

- attach conformity assessment references;
- attach policy references;
- mark this as assurance/certification evidence, not a runtime Wallet test.

## Implementation note

Do not expose ETSI-heavy claims in the basic Maestro Action editor. They belong in:

```text
Advanced trust-helper settings
Evidence claim detail pages
Report appendices
Issuer/RP/trust-service profile validators
```

---

# OpenID SIOP, mDL/mdoc and Federation addendum v1.1

## B-150 — SIOPv2 request/response helper

Implement support for:

- SIOPv2 same-device request generation.
- SIOPv2 cross-device request generation.
- `direct_post` callback capture.
- RP metadata/client metadata validation.
- Self-Issued ID Token validation result normalization.

Evidence artifacts:

```text
siopv2_request
presentation_metadata
id_token_validation_result
verifier_result
```

Screenshots must be paired with Maestro `assertVisible` / `extendedWaitUntil.visible` output.

## B-160 — mDL/mdoc validation helper

Implement or integrate helper checks for:

- device engagement;
- reader request;
- data retrieval;
- MSO / issuer data authentication;
- mDL authentication;
- reader authentication;
- session encryption result;
- online retrieval TLS/JWS result.

Evidence artifacts:

```text
device_engagement_data
reader_request
mdoc_response
session_encryption_result
issuer_data_authentication_result
mdl_authentication_result
reader_authentication_result
```

## B-170 — OpenID Federation trust resolver

Implement helper checks for:

- entity configuration fetch;
- entity statement validation;
- subordinate statement fetch;
- trust-chain resolution;
- metadata policy application;
- trust mark validation;
- resolve endpoint;
- key rollover and revocation.

Evidence artifacts:

```text
entity_configuration
subordinate_statements
trust_chain
trust_chain_validation_result
metadata_policy_result
trust_mark_validation_result
```

---

# OpenID Conformance Suite EUDI subset addendum v1.1

## Source-scope rule

Do not ingest the whole OpenID Conformance Suite spec-link catalogue into EUDI artifacts.

Include as first-class EUDI/OpenID4VC sources:

```text
OID4VCI
OID4VP
HAIP / HAIPA
SD-JWT
SD-JWT VC
OAuth Status List
OpenID Federation
ISO 18013-7 reference-only
```

Include OAuth/OIDC dependencies only when directly used by a concrete EUDI test:

```text
PKCE
PAR
JAR
JARM
DPoP
JWT/JWK/JWA
OAuth AS Metadata
OIDC Discovery
OIDC Dynamic Client Registration
```

Exclude for now:

```text
FAPI
CIBA
Open Banking / regional profiles
CAEP / RISC / Shared Signals
AuthZEN
```

## B-180 — OID4VCI/OID4VP/HAIP reference adapter

Add helper metadata so every protocol helper can emit references using the same prefixes as the OpenID Conformance Suite.

## B-181 — Source-scope guard

Add a CI/build check that rejects accidental Tier 3/Tier 4 references unless explicitly whitelisted.
