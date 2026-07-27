# Generic OID4VP technical spike

Generic verifier support is deliberately deferred. The current presentation flow fetches OpenID Federation entity statements, verifies Italian trust anchors, and builds authorization responses using Italian Wallet metadata. Reusable parts are request-object parsing, DCQL, Presentation Exchange helpers, VP-token construction, redirect capture, and credential loading.

The missing boundary is a normalized verifier-discovery result equivalent to generic OID4VCI discovery, plus a verifier metadata model and a profile-specific response builder. Proposed configuration is `[profile] ecosystem = generic_oid4vp`, `[presentation] verifier`, and explicit request-object acquisition mode. Phases: fixture-backed discovery/parser tests; normalized presentation orchestrator inputs; generic response submission; local verifier fixtures for DCQL and Presentation Exchange; opt-in live smoke. No Italian conformance result may be inferred from this mode.
