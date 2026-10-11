// Calls one Orca runtime method that the `orca` CLI has no command for
// (folder projects and folder workspaces), through Orca's own runtime
// client, and prints the reply envelope `{ ok, result | error }`.
// Run by Orca's own Node, with the resources folder that holds its CLI:
//   ELECTRON_RUN_AS_NODE=1 <Orca> orca-rpc.cjs <resources> <method> <json>
// <Orca> is `Orca.app/Contents/MacOS/Orca` with `Orca.app/Contents/Resources`
// on macOS, and `orca-ide` with the `resources` folder beside it on Linux.
"use strict";
const path = require("node:path");

const [resources, method, params] = process.argv.slice(2);
const done = (reply, code = 0) => {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
  process.exit(code);
};
let RuntimeClient;
try {
  ({ RuntimeClient } = require(path.join(resources, "app.asar.unpacked/out/cli/runtime-client.js")));
} catch (error) {
  done({ ok: false, error: { code: "unsupported", message: `this Orca has no runtime client the board can use: ${error.message}` } }, 1);
}
new RuntimeClient(process.env.ORCA_USER_DATA_PATH)
  .call(method, params ? JSON.parse(params) : undefined)
  .then((reply) => done(reply, reply?.ok ? 0 : 1))
  .catch((error) => done({ ok: false, error: { code: error.code ?? "error", message: error.message } }, 1));
