#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[build-cli] bundling src/cli.ts -> dist/cli.js (node target)"
bun build src/cli.ts --target=node --outfile dist/cli.js

# Bundle inherits the source (bun) shebang; rewrite to node for npx users.
sed -i '1c#!/usr/bin/env node' dist/cli.js
sed -i '/^\/\/ @bun$/d' dist/cli.js
chmod +x dist/cli.js
echo "[build-cli] done: $(wc -c < dist/cli.js) bytes"
