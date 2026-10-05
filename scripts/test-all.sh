#!/bin/bash
# Every automated check of the Work board: the service (unit + engine tests
# over the fake Orca, the service process, the Jira/Linear/GitHub fixtures),
# the web UI (vitest + typecheck), the fixture servers, the package, and the
# acceptance against a real isolated Orca.
#   scripts/test-all.sh            everything
#   scripts/test-all.sh --no-orca  skip the real-Orca acceptance
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export CARGO_TARGET_DIR="$root/service/target"
(cd "$root/service" && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
(cd "$root/web" && npx tsc --noEmit && npx vitest run)
node --test "$root/tests/fixtures/jira/fake-jira-server.test.mjs" "$root/tests/fixtures/work-sources/fake-sources-server.test.mjs"
"$root/scripts/package-plugin.sh"
if [[ "${1:-}" != "--no-orca" ]]; then
  node "$root/tests/e2e/accept-orca.mjs"
fi
