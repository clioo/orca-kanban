// The board's bridge over the service's RPC: one call per contract op,
// answers checked against the op's schema, and a service that does not
// answer said in the user's words.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORK_OPS } from "../../../shared/work-contract";
import { httpRpc, workBridgeOver, type Rpc } from "./board-rpc";

afterEach(() => vi.unstubAllGlobals());

describe("workBridgeOver", () => {
  it("calls each op's method with the page's params", async () => {
    const rpc = vi.fn<Rpc>(async () => ({ ok: true, result: { deleted: "t1", key: "DRG-1" } }));
    const bridge = workBridgeOver(rpc);
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(WORK_OPS).sort());
    const result = await bridge.ticketDelete({ ticketId: "t1" });
    expect(rpc).toHaveBeenCalledWith("work.ticket_delete", { ticketId: "t1" });
    expect(result).toEqual({ ok: true, result: { deleted: "t1", key: "DRG-1" } });
    await bridge.sources();
    expect(rpc).toHaveBeenLastCalledWith("work.sources", {});
  });

  it("refuses an answer that breaks the op's contract", async () => {
    const bridge = workBridgeOver(async () => ({ ok: true, result: { deleted: 7 } }));
    const result = await bridge.ticketDelete({ ticketId: "t1" });
    expect(result).toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("passes the service's errors through", async () => {
    const error = { code: "not_found", message: "ticket x not found", retryable: false };
    const bridge = workBridgeOver(async () => ({ ok: false, error }));
    expect(await bridge.ticketShow({ ticketId: "x" })).toEqual({ ok: false, error });
  });
});

describe("httpRpc", () => {
  it("posts { method, params } to the service's /rpc", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { version: "0.2.0" } })));
    vi.stubGlobal("fetch", fetch);
    expect(await httpRpc("board.status", { a: 1 })).toEqual({ ok: true, result: { version: "0.2.0" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("./rpc");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ method: "board.status", params: { a: 1 } });
  });

  it("says the service is not answering when it is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const result = await httpRpc("work.board");
    expect(result).toMatchObject({ ok: false, error: { code: "service_unavailable", retryable: true } });
    expect(result.ok ? "" : result.error.message).toContain("Open Work board");
  });
});
