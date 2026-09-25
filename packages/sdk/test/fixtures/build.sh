#!/usr/bin/env bash
# Compiles TestToken.sol with forge (https://getfoundry.sh) and writes TestToken.json, the artifact
# the SDK's semantic tests deploy into an in-process EVM. CI has no forge, so the artifact is
# committed: rerun this script and commit the result whenever TestToken.sol changes.
#   packages/sdk/test/fixtures/build.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"
cp "$here/TestToken.sol" "$work/src/"
cat > "$work/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
evm_version = "cancun"
TOML
(cd "$work" && forge build --silent)
python3 - "$work/out/TestToken.sol/TestToken.json" "$here/TestToken.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1]))
meta = artifact['metadata']
out = {
    'contract': 'TestToken.sol',
    'compiler': f"solc {meta['compiler']['version']}",
    'evmVersion': meta['settings']['evmVersion'],
    'abi': artifact['abi'],
    'bytecode': artifact['bytecode']['object'],
}
json.dump(out, open(sys.argv[2], 'w'), indent=2)
open(sys.argv[2], 'a').write('\n')
PY
echo "wrote $here/TestToken.json"
