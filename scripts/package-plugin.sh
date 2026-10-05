#!/bin/bash
# Builds the board (web UI + service) and assembles the installable plugin
# folder dist/clioo.work-board: what Orca's "Install plugin" copies.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/dist/clioo.work-board"
(cd "$root/web" && npx vite build >/dev/null)
cargo build --release --manifest-path "$root/service/Cargo.toml" --target-dir "$root/service/target"
rm -rf "$out" && mkdir -p "$out/bin"
cp "$root/plugin/orca-plugin.json" "$root/plugin/worker.mjs" "$root/LICENSE" "$root/THIRD_PARTY_NOTICES.md" "$out/"
cp "$root/service/target/release/work-board-svc" "$root/plugin/orca-rpc.cjs" "$out/bin/"
cp -R "$root/web/dist" "$out/web"
codesign --verify "$out/bin/work-board-svc"
# The plugin's version, the service's and the UI's are one release.
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
const c = /^version = "([^"]+)"/m.exec(fs.readFileSync(process.argv[2], "utf8"))[1];
const w = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).version;
if (m !== c || m !== w) { console.error(`version mismatch: plugin ${m}, service ${c}, web ${w}`); process.exit(1); }
' "$root/plugin/orca-plugin.json" "$root/service/Cargo.toml" "$root/web/package.json"
echo "$out"
