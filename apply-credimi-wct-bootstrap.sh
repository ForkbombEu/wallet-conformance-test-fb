#!/usr/bin/env bash
set -euo pipefail

# Apply the current Credimi/WCT interoperability diagnostic changes to a clean
# fork of pagopa/wallet-conformance-test v1.2.1.
#
# This is a bootstrap patch, not the final architecture. It deliberately:
# - adds ordinary OID4VCI/RFC 8414 metadata fallback;
# - treats Credimi PID configuration IDs as browser authorization flows;
# - adds a small Credimi issuance smoke test and config;
# - adds a repeatable runner.
#
# Usage:
#   ./apply-credimi-wct-bootstrap.sh /path/to/wallet-conformance-test
#   ./apply-credimi-wct-bootstrap.sh --run /path/to/wallet-conformance-test
#   ./apply-credimi-wct-bootstrap.sh --force /path/to/wallet-conformance-test
#
# The script does not commit, push, or modify /etc/hosts.

SUPPORTED_PACKAGE='@pagopa/it-wallet-conformance-tool'
SUPPORTED_VERSION='1.2.1'
FETCH_BASELINE_SHA256='f0389d930fee4ca9cd38b200a9eb91b21b0fd6f6698c351e3f306da36f72002f'

RUN_AFTER=0
FORCE=0
REPO_ARG=""

usage() {
  sed -n '1,28p' "$0" | sed 's/^# \{0,1\}//'
}

while (($#)); do
  case "$1" in
    --run)
      RUN_AFTER=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$REPO_ARG" ]]; then
        echo "Only one repository path may be supplied." >&2
        exit 2
      fi
      REPO_ARG="$1"
      ;;
  esac
  shift
done

REPO_ROOT="${REPO_ARG:-$PWD}"
REPO_ROOT="$(cd -- "$REPO_ROOT" && pwd)"

required_files=(
  package.json
  src/cli.ts
  src/step/issuance/fetch-metadata-step.ts
  src/step/issuance/authorize-step.ts
  tests/config/test-metadata.ts
  bin/wct
)

for rel in "${required_files[@]}"; do
  if [[ ! -f "$REPO_ROOT/$rel" ]]; then
    echo "Not a supported WCT checkout: missing $REPO_ROOT/$rel" >&2
    exit 2
  fi
done

readarray -t package_identity < <(
  node - "$REPO_ROOT/package.json" <<'NODE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(pkg.name ?? "");
console.log(pkg.version ?? "");
NODE
)
package_name="${package_identity[0]:-}"
package_version="${package_identity[1]:-}"

if [[ "$package_name" != "$SUPPORTED_PACKAGE" ]]; then
  echo "Unsupported package: '$package_name' (expected '$SUPPORTED_PACKAGE')" >&2
  exit 2
fi
if [[ "$package_version" != "$SUPPORTED_VERSION" ]]; then
  echo "Unsupported WCT version: '$package_version'." >&2
  echo "This bootstrap targets v$SUPPORTED_VERSION. Rebase or adapt it manually." >&2
  exit 2
fi

FETCH_STEP="$REPO_ROOT/src/step/issuance/fetch-metadata-step.ts"
AUTHORIZE_STEP="$REPO_ROOT/src/step/issuance/authorize-step.ts"
ALREADY_APPLIED=0
if grep -q 'CREDIMI_GENERIC_OID4VCI_FALLBACK' "$FETCH_STEP" &&
   grep -q 'CREDIMI_GENERIC_PID_IDS' "$AUTHORIZE_STEP"; then
  ALREADY_APPLIED=1
fi

if [[ -d "$REPO_ROOT/.git" && "$FORCE" -ne 1 && "$ALREADY_APPLIED" -ne 1 ]]; then
  if [[ -n "$(git -C "$REPO_ROOT" status --short)" ]]; then
    echo "The checkout is not clean. Commit/stash changes or rerun with --force." >&2
    git -C "$REPO_ROOT" status --short >&2
    exit 2
  fi
fi

if [[ "$ALREADY_APPLIED" -ne 1 ]]; then
  actual_fetch_sha="$(sha256sum "$FETCH_STEP" | awk '{print $1}')"
  if [[ "$actual_fetch_sha" != "$FETCH_BASELINE_SHA256" ]]; then
    echo "fetch-metadata-step.ts does not match the reviewed WCT v$SUPPORTED_VERSION baseline." >&2
    echo "Expected: $FETCH_BASELINE_SHA256" >&2
    echo "Actual:   $actual_fetch_sha" >&2
    echo "Refusing to overwrite an unknown source version." >&2
    exit 2
  fi
fi

mkdir -p \
  "$REPO_ROOT/tests/credimi/issuance" \
  "$REPO_ROOT/scripts"

cat > "$FETCH_STEP" <<'TYPESCRIPT'
import { fetchMetadata } from "@pagopa/io-wallet-oid4vci";

import { fetchWithConfig } from "@/logic/utils";
import { recordSessionEntityNameFromEntityConfiguration } from "@/report/session-runtime";

import { StepFlow, StepResponse } from "../step-flow";

export interface FetchMetadataExecuteResponse {
  discoveredVia?: "federation" | "oid4vci";
  // Entity statement metadata is version-dependent and consumed structurally by orchestrators/tests.
  entityStatementClaims?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
}

export interface FetchMetadataOptions {
  baseUrl: string;
}

export type FetchMetadataStepResponse = StepResponse & {
  response?: FetchMetadataExecuteResponse;
};

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((entry): entry is string => typeof entry === "string");
}

/**
 * Build an OAuth/OIDC well-known URL for an issuer identifier.
 * For an issuer with a path, RFC 8414 places the suffix after the well-known
 * name, e.g. https://example.test/.well-known/oauth-authorization-server/tenant.
 */
function buildWellKnownUrl(issuer: string, name: string): string {
  const parsed = new URL(issuer);
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `/.well-known/${name}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Flow step to fetch issuer metadata.
 *
 * CREDIMI_GENERIC_OID4VCI_FALLBACK:
 * WCT normally delegates discovery to the Italian Wallet SDK. That parser
 * deliberately requires Italian Wallet V1.3/V1.4 metadata extensions. When
 * those profile-specific checks reject an otherwise ordinary OID4VCI issuer,
 * this step falls back to standard OpenID Credential Issuer and RFC 8414
 * OAuth Authorization Server metadata discovery.
 *
 * The fallback changes discovery only. Later PAR, Wallet Instance Attestation,
 * client-attestation PoP, authorization, token, nonce, DPoP and credential
 * requests continue to use the existing WCT implementations.
 */
export class FetchMetadataDefaultStep extends StepFlow {
  static readonly tag = "FETCH_METADATA";

  async run(options: FetchMetadataOptions): Promise<FetchMetadataStepResponse> {
    const log = this.log;

    log.info("Discovering metadata...");

    return this.execute<FetchMetadataExecuteResponse>(async () => {
      try {
        const result = await fetchMetadata({
          callbacks: {
            fetch: fetchWithConfig(this.config.network),
          },
          config: this.ioWalletSdkConfig,
          credentialIssuerUrl: options.baseUrl,
        });

        log.debug(
          "Metadata fetched successfully:",
          JSON.stringify(result, null, 2),
        );

        recordSessionEntityNameFromEntityConfiguration(
          "issuance",
          result.openid_federation_claims,
        );

        return {
          discoveredVia: result.discoveredVia,
          entityStatementClaims: result.openid_federation_claims,
          status: 200,
        };
      } catch (italianProfileError) {
        const reason =
          italianProfileError instanceof Error
            ? italianProfileError.message
            : String(italianProfileError);

        log.warn(
          `Italian Wallet metadata discovery rejected the issuer; ` +
            `trying ordinary OID4VCI discovery instead. Original error: ${reason}`,
        );

        const fetcher = fetchWithConfig(this.config.network);
        const issuerMetadataUrl = buildWellKnownUrl(
          options.baseUrl,
          "openid-credential-issuer",
        );
        log.info(`OID4VCI fallback: ${issuerMetadataUrl}`);

        const issuerResponse = await fetcher(issuerMetadataUrl, {
          headers: { accept: "application/json" },
        });
        if (!issuerResponse.ok) {
          throw new Error(
            `Credential issuer metadata request failed: HTTP ${issuerResponse.status}`,
          );
        }

        const issuerMetadata = requireObject(
          await issuerResponse.json(),
          "Credential issuer metadata",
        );
        const credentialIssuer =
          optionalString(issuerMetadata.credential_issuer) ?? options.baseUrl;
        const authorizationServer =
          firstString(issuerMetadata.authorization_servers) ?? credentialIssuer;

        const oauthMetadataUrl = buildWellKnownUrl(
          authorizationServer,
          "oauth-authorization-server",
        );
        log.info(`OAuth metadata fallback: ${oauthMetadataUrl}`);

        const oauthResponse = await fetcher(oauthMetadataUrl, {
          headers: { accept: "application/json" },
        });
        if (!oauthResponse.ok) {
          throw new Error(
            `OAuth authorization-server metadata request failed: HTTP ${oauthResponse.status}`,
          );
        }

        const oauthMetadata = requireObject(
          await oauthResponse.json(),
          "OAuth authorization-server metadata",
        );
        const authorizationIssuer =
          optionalString(oauthMetadata.issuer) ?? authorizationServer;

        const entityStatementClaims = {
          iss: authorizationIssuer,
          sub: credentialIssuer,
          metadata: {
            oauth_authorization_server: oauthMetadata,
            openid_credential_issuer: issuerMetadata,
          },
        };

        log.info("CREDIMI_GENERIC_OID4VCI_FALLBACK active");
        log.debug(
          "Adapted ordinary OID4VCI metadata:",
          JSON.stringify(entityStatementClaims, null, 2),
        );

        return {
          discoveredVia: "oid4vci",
          entityStatementClaims,
          status: 200,
        };
      }
    });
  }

  tag(): string {
    return FetchMetadataDefaultStep.tag;
  }
}
TYPESCRIPT

python3 - "$AUTHORIZE_STEP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

if "CREDIMI_GENERIC_PID_IDS" not in text:
    old = 'if (options.credentialIdentifier === "dc_sd_jwt_pid") {'
    new = (
        'if (\n'
        '        options.credentialIdentifier === "dc_sd_jwt_pid" ||\n'
        '        options.credentialIdentifier === "urn:eu.europa.ec.eudi:pid:1.jwt" ||\n'
        '        options.credentialIdentifier === "urn:eu.europa.ec.eudi:pid:1.mdoc.jwt"\n'
        '      ) { // CREDIMI_GENERIC_PID_IDS'
    )
    if old not in text:
        raise SystemExit(
            "Could not find the reviewed PID-flow branch in authorize-step.ts"
        )
    text = text.replace(old, new, 1)
    path.write_text(text)
PY

cat > "$REPO_ROOT/config.credimi-direct.ini" <<'INI'
; Credimi Capture Issuer — generic OID4VCI interoperability diagnostic.
;
; This keeps wallet_version=V1_4 because WCT uses that implementation to
; construct Wallet Instance Attestation, PAR, DPoP, proof JWT and related
; requests. It does not imply that the target issuer is an Italian Wallet
; profile issuer.

[wallet]
wallet_version = V1_4

[trust]
federation_trust_anchors[] = https://trust-anchor.wct.example.org:3001

[issuance]
url = https://capture-wallet.credimi.io
credential_types[] = urn:eu.europa.ec.eudi:pid:1.jwt
callback_port = 4000
save_credential = true

[network]
timeout = 30
max_retries = 2

[trust_anchor]
verify = false

[logging]
log_level = DEBUG
log_file = ./data/logs/credimi-first-run.log
INI

cat > "$REPO_ROOT/tests/credimi/issuance/credimi-flow.issuance.spec.ts" <<'TYPESCRIPT'
import { defineIssuanceTest } from "#/config/test-metadata";
import { assertIssuanceFlowSuccess } from "#/helpers/flow-assertion-helpers";
import { WalletIssuanceOrchestratorFlow } from "@/orchestrator";
import { describe, expect, test } from "vitest";

/**
 * A deliberately small interoperability smoke test.
 *
 * It runs WCT's complete issuance orchestrator but does not apply the Italian
 * Wallet profile assertions from the official conformance suites. Once this
 * passes, run those suites separately to classify profile differences.
 */
const configurations = await defineIssuanceTest("CredimiIssuanceSmoke");

configurations.forEach((configuration) => {
  describe(`[${configuration.name}] Credimi issuance smoke`, () => {
    test("completes the authorization-code issuance flow", async () => {
      const orchestrator = new WalletIssuanceOrchestratorFlow(configuration);
      const result = await orchestrator.issuance();

      assertIssuanceFlowSuccess(result);
      expect(result.fetchMetadataResponse.success).toBe(true);
      expect(result.pushedAuthorizationRequestResponse.success).toBe(true);
      expect(result.authorizeResponse.success).toBe(true);
      expect(result.tokenResponse.success).toBe(true);
      expect(result.credentialResponse.success).toBe(true);
    }, 120_000);
  });
});
TYPESCRIPT

cat > "$REPO_ROOT/scripts/run-credimi-issuance-smoke.sh" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

required_hosts=(
  trust-anchor.wct.example.org
  wallet-provider.wct.example.org
  credential-issuer.wct.example.org
)

for host in "${required_hosts[@]}"; do
  if ! getent hosts "$host" >/dev/null 2>&1; then
    cat >&2 <<'MSG'
Missing WCT local hostname mappings. Add them once:

sudo sh -c 'echo "127.0.0.1 trust-anchor.wct.example.org wallet-provider.wct.example.org credential-issuer.wct.example.org" >> /etc/hosts'
MSG
    exit 2
  fi
done

grep -q 'CREDIMI_GENERIC_OID4VCI_FALLBACK' \
  "$ROOT/src/step/issuance/fetch-metadata-step.ts"
grep -q 'CREDIMI_GENERIC_PID_IDS' \
  "$ROOT/src/step/issuance/authorize-step.ts"

cd "$ROOT"
corepack enable
pnpm install --frozen-lockfile
pnpm build
chmod +x ./bin/wct

./bin/wct test:issuance \
  --file-ini "$ROOT/config.credimi-direct.ini" \
  --issuance-tests-dir "$ROOT/tests/credimi/issuance"
RUNNER
chmod +x "$REPO_ROOT/scripts/run-credimi-issuance-smoke.sh"

grep -q 'CREDIMI_GENERIC_OID4VCI_FALLBACK' "$FETCH_STEP"
grep -q 'CREDIMI_GENERIC_PID_IDS' "$AUTHORIZE_STEP"
test -f "$REPO_ROOT/config.credimi-direct.ini"
test -x "$REPO_ROOT/scripts/run-credimi-issuance-smoke.sh"
test -f "$REPO_ROOT/tests/credimi/issuance/credimi-flow.issuance.spec.ts"

echo
echo "Credimi WCT bootstrap applied to:"
echo "  $REPO_ROOT"
echo
echo "Added:"
echo "  config.credimi-direct.ini"
echo "  tests/credimi/issuance/credimi-flow.issuance.spec.ts"
echo "  scripts/run-credimi-issuance-smoke.sh"
echo
echo "Patched:"
echo "  src/step/issuance/fetch-metadata-step.ts"
echo "  src/step/issuance/authorize-step.ts"
echo
echo "Required /etc/hosts entry:"
echo '  127.0.0.1 trust-anchor.wct.example.org wallet-provider.wct.example.org credential-issuer.wct.example.org'
echo
echo "Run:"
echo "  ./scripts/run-credimi-issuance-smoke.sh"
echo
if [[ -d "$REPO_ROOT/.git" ]]; then
  git -C "$REPO_ROOT" status --short
fi

if [[ "$RUN_AFTER" -eq 1 ]]; then
  "$REPO_ROOT/scripts/run-credimi-issuance-smoke.sh"
fi
