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

cd "$ROOT"
corepack enable
pnpm install --frozen-lockfile
pnpm build
chmod +x ./bin/wct

./bin/wct test:issuance \
  --file-ini "$ROOT/config.credimi-direct.ini" \
  --issuance-tests-dir "$ROOT/tests/credimi/issuance"
