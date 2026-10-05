// Calls one Orca runtime method that the `orca` CLI has no command for
// (folder projects and folder workspaces), through Orca's own runtime
// client, and prints the reply envelope `{ ok, result | error }`.
// Run by Orca's own Node:
//   ELECTRON_RUN_AS_NODE=1 <App>/Contents/MacOS/Orca orca-rpc.cjs <App> <method> <json>
"use strict";
const path = require("node:path");

const [app, method, params] = process.argv.slice(2);
const done = (reply, code = 0) => {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
  process.exit(code);
};
let RuntimeClient;
try {
  ({ RuntimeClient } = require(path.join(app, "Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js")));
} catch (error) {
  done({ ok: false, error: { code: "unsupported", message: `this Orca has no runtime client the board can use: ${error.message}` } }, 1);
}
new RuntimeClient(process.env.ORCA_USER_DATA_PATH)
  .call(method, params ? JSON.parse(params) : undefined)
  .then((reply) => done(reply, reply?.ok ? 0 : 1))
  .catch((error) => done({ ok: false, error: { code: error.code ?? "error", message: error.message } }, 1));
