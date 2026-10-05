// The board's transport: every call is `POST /rpc { method, params }` to the
// Work board service that served this page.
import type { Result } from "../../../shared/session-contract";
import { WORK_OPS, type WorkBridge, type WorkOp } from "../../../shared/work-contract";

export type Rpc = (method: string, params?: object) => Promise<Result<unknown>>;

export const httpRpc: Rpc = async (method, params = {}) => {
  try {
    const response = await fetch("./rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const reply = (await response.json()) as Result<unknown>;
    if (reply && typeof reply === "object" && "ok" in reply) return reply;
    return failure("internal_error", `${method} gave no answer`);
  } catch (err) {
    return failure("service_unavailable", "The Work board service is not answering. Run “Open Work board” again.");
  }
};

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retryable: code === "service_unavailable" } };
}

/** A `WorkBridge` over the service: one method per contract op, each answer
 *  checked against the op's schema before the page sees it. */
export function workBridgeOver(rpc: Rpc): WorkBridge {
  const bridge: Partial<Record<WorkOp, (input?: object) => Promise<Result<unknown>>>> = {};
  for (const op of Object.keys(WORK_OPS) as WorkOp[]) {
    const { method, schema } = WORK_OPS[op];
    bridge[op] = async (input = {}) => {
      const reply = await rpc(method, input);
      if (!reply.ok) return reply;
      const checked = schema.safeParse(reply.result);
      return checked.success
        ? { ok: true, result: checked.data }
        : failure("internal_error", `The ${method} response does not match its contract.`);
    };
  }
  return bridge as WorkBridge;
}
