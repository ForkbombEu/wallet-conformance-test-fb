# Credimi Conformance Artifacts — Changelog

## v1.1 — Source rationalization and EUDI-focused OpenID scope

### Added

- Source-scope policy file.
- Concise regulatory map replacing the bloated expanded map.
- EUDI-targeted OpenID Conformance Suite source subset:
  - OID4VCI
  - OID4VP
  - HAIP / HAIPA
  - SD-JWT
  - SD-JWT VC
  - OAuth Status List
  - OpenID Federation
  - ISO 18013-7 reference-only
- Supporting dependency policy for PKCE, PAR, JAR, JARM, DPoP, JWT/JWK/JWA, OAuth AS Metadata and OIDC Discovery.
- Trust-helper backlog items for source-scope guard and OpenID spec-link adapter.

### Changed

- Demoted the documentation map to non-core/microsite support.
- Consolidated the “169 tests” concept and flat conformance test list into one file.
- Kept OpenID Federation but labelled it partner-driven/uncertain adoption.
- Kept ISO 18013-7 as reference-only because the document was not uploaded.
- Stated that Tier 3/4 OpenID Conformance Suite profiles are excluded for now.
