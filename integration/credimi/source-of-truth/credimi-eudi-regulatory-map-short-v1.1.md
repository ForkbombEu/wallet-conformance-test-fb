---
title: "EUDI Trust & Conformance Map"
description: "Concise human-readable guide to EUDI Wallet conformance sources, with reference catalogue."
updatedOn: 2026-05-26
version: "1.1"
---

# EUDI Trust & Conformance Map

This is the fast human-readable map. It is intentionally shorter than the internal registries.

## Fast reading: what matters in 5 minutes

| Area | Read first | Why it matters |
|---|---|---|
| Legal foundation | [EUDI Regulation 2024/1183](https://data.europa.eu/eli/reg/2024/1183/oj) and consolidated eIDAS | Defines the legal Wallet framework. |
| PID/EAA issuance | [CIR 2024/2977](https://data.europa.eu/eli/reg_impl/2024/2977/oj) | PID and electronic attestations issued to Wallets. |
| Wallet core | [CIR 2024/2979](https://data.europa.eu/eli/reg_impl/2024/2979/oj) | Wallet integrity and core functionality. |
| Protocols/interfaces | [CIR 2024/2982](https://data.europa.eu/eli/reg_impl/2024/2982/oj) | Issuance, presentation and interaction interfaces. |
| Wallet certification | [CIR 2024/2981](https://data.europa.eu/eli/reg_impl/2024/2981/oj) | Certification and assurance evidence context. |
| RP registration | [CIR 2025/848](https://data.europa.eu/eli/reg_impl/2025/848/oj) | Relying Party registration, entitlements and access certificates. |
| Certified Wallet list | [CIR 2025/849](https://data.europa.eu/eli/reg_impl/2025/849/oj) | Machine-readable certified Wallet list. |
| Architecture | [EUDI ARF latest](https://eudi.dev/latest/) | Technical architecture and high-level requirements. |
| OpenID4VC | [OID4VCI](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#section-) / [OID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#section-) / [HAIP](https://openid.net/specs/openid4vc-high-assurance-interoperability-profile-1_0.html#section-) | Main OpenID protocol layer. |
| SD-JWT | [SD-JWT](https://www.ietf.org/archive/id/draft-ietf-oauth-selective-disclosure-jwt-14.html#section-) / [SD-JWT VC](https://www.ietf.org/archive/id/draft-ietf-oauth-sd-jwt-vc-13.html#section-) | Selective disclosure and SD-JWT credential format. |
| mdoc/mDL | ISO 18013-5 and [ISO 18013-7](https://www.iso.org/standard/82772.html#) | mDL/mdoc presentation/security. ISO 18013-7 is reference-only here. |
| Federation | [OpenID Federation](https://openid.net/specs/openid-federation-1_0-45.html#section-) | Optional/partner-driven trust-chain and metadata federation. |
| ETSI | ETSI ESI standards | Certificate, TSP, validation, timestamping and qualified trust-service layer. |

## How Credimi maps this to evidence

Credimi evidence comes from Maestro, StepCI, Temporal, `conformance_context`, and trust-helper checks.

- **Maestro** proves observable Wallet UI behaviour.
- **StepCI** captures protocol/API traces.
- **Temporal** records inputs/outputs and execution history.
- **conformance_context** carries `credential_metadata` and `presentation_metadata`.
- **trust-helper** checks certificates, Trusted Lists, RP entitlements, revocation/status, ETSI/OpenID/Federation helpers.

## Reading routes

### Wallet

Read CIR 2024/2979, CIR 2024/2982, ARF, OID4VCI/OID4VP/HAIP, SD-JWT/SD-JWT VC, and ISO 18013-5/7 if mdoc/mDL is supported.

### Issuer / Attestation Provider

Read CIR 2024/2977, CIR 2024/2982, OID4VCI, HAIP, ETSI EAA/PID profile standards, and Trusted List/QEAA/QTSP material when qualified attestations are involved.

### Verifier / Relying Party

Read CIR 2024/2982, CIR 2025/848, OID4VP, HAIP, RP certificate/registration material, and OpenID Federation if used.

### Trust infrastructure

Read CIR 2024/2980, CIR 2025/848, CIR 2025/849, Trusted List material, OpenID Federation if used, and ETSI certificate/validation/timestamping standards.

## Full reference catalogue

For the complete machine-readable source catalogue, use:

```text
credimi-conformance-source-scope-v1.1.yaml
credimi-conformance-evidence-registry-v1.1.yaml
credimi-flat-conformance-test-list-v1.1.md
```
