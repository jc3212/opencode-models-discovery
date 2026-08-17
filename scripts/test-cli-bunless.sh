#!/usr/bin/env bash
# Bun-less CLI verification (design §8, §11).
# - pack the tarball (prepack builds dist/cli.js)
# - install into a fresh directory
# - run the CLI with bun REMOVED from PATH (node-only)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WORK="$(mktemp -d /tmp/omd-cli-bunless-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "[cli-bunless] packing tarball (prepack builds dist/cli.js)"
rm -rf packout && mkdir -p packout
TARBALL="$(npm pack --pack-destination ./packout --cache ./npm-cache 2>/dev/null | tail -1)"
TARBALL="$ROOT/packout/$TARBALL"
echo "[cli-bunless] tarball: $TARBALL"

echo "[cli-bunless] installing into clean dir"
cd "$WORK"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --cache "$ROOT/npm-cache" "$TARBALL" >/dev/null 2>&1

echo "[cli-bunless] removing bun from PATH"
# Preserve a PATH without bun for the actual run.
NODE_BIN="$(dirname "$(command -v node)")"
NPM_BIN="$(dirname "$(command -v npm)")"
CLEAN_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'bun' | paste -sd: -)"
export PATH="$CLEAN_PATH"

if command -v bun >/dev/null 2>&1; then
  echo "[cli-bunless] FAIL: bun still on PATH"
  exit 1
fi
echo "[cli-bunless] bun not on PATH (node-only environment confirmed)"

echo "[cli-bunless] running: node dist/cli.js via npx-style bin"
ls node_modules/.bin/ | grep -q opencode-models-discovery || { echo "[cli-bunless] FAIL: no bin link"; exit 1; }

# Run the installed bin directly (this is what npx executes).
OUT="$(node_modules/.bin/opencode-models-discovery 2>&1 || true)"
if echo "$OUT" | grep -q "Reasoning Audit"; then
  echo "[cli-bunless] OK: CLI ran without bun, produced Reasoning Audit"
else
  echo "[cli-bunless] FAIL: CLI output did not include Reasoning Audit"
  echo "$OUT" | head -20
  exit 1
fi

# Secret scan.
if echo "$OUT" | grep -qi 'super-secret\|Authorization: Bearer\|api[_-]key[:=]'; then
  echo "[cli-bunless] FAIL: credential leak in CLI output"
  exit 1
fi
echo "[cli-bunless] OK: 0 credential leak"

cd "$ROOT"
rm -rf packout
echo "[cli-bunless] PASS"
