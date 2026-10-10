/**
 * The host half of the board panel's data channel.
 *
 * The client half of a DSH plugin cannot call tools; it talks to the host over
 * one exact same-origin route. This module registers that route and answers
 * `snapshot` by running the very same read-only projection the tools use, so the
 * panel and `codex_status` can never disagree about what Codex is doing.
 *
 * Registration notes (measured on this machine, 2026-10-10):
 *  - the route must be registered through `connection.fetch.register`. The
 *    `connection.rpc.handle` shape resolves `webServer` out of the *connection*
 *    service's own context, which has no such inject, and throws at assembly
 *    time — the channel then simply disappears.
 *  - one channel per route: `/api/<channel>` is claimed exactly, so this plugin
 *    uses its own channel name and never collides with another plugin's `/api/*`.
 *
 * @module dsh-codex-bridge/board-channel
 */
import { collectBoard } from "./board.js";

/** The channel segment the client asks for; the route is `/api/<channel>`. */
export const RPC_CHANNEL = "codexboard";

/** The exact route this module claims. */
export const RPC_ROUTE = `/api/${RPC_CHANNEL}`;

/** Legal rpc id shape (same rule as the connection service). */
const RPC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Legal endpoint name shape (dots allowed, so `board.snapshot` would also be legal). */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * Wrap a handler result in the transport envelope the client unwraps.
 * @param rpcId - the request id being answered.
 * @param result - `{ ok: true, value }` or `{ ok: false, error }`.
 * @returns a JSON response.
 */
function envelope(rpcId, result) {
  return Response.json({ type: "server-response", rpcId, result });
}

/**
 * Build the request handler. Exported for tests: it takes plain arguments and
 * returns a `Response`, so the whole protocol can be exercised without a host.
 * @param handlers - `Map<string, (payload) => Promise<unknown>>`.
 * @param log - optional `(level, message) => void` sink.
 * @returns a `fetch`-shaped function.
 */
export function createRouteHandler(handlers, log = () => {}) {
  const badRequest = (rpcId, why) => envelope(rpcId, { ok: false, error: { code: "gateway/bad-request", message: why, details: {} } });

  return async function routeFetch(request) {
    if (!request || request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body = null;
    try {
      body = await request.json();
    } catch {
      return new Response("body is not JSON", { status: 400 });
    }
    const rpcId = typeof body?.rpcId === "string" && RPC_ID_PATTERN.test(body.rpcId) ? body.rpcId : "invalid-request";
    if (body?.type !== "client-request") return badRequest(rpcId, "invalid client-request message");

    const call = body.payload;
    if (call === null || typeof call !== "object") return badRequest(rpcId, "missing call payload");
    const endpoint = call.method;
    if (typeof endpoint !== "string" || !ENDPOINT_PATTERN.test(endpoint)) return badRequest(rpcId, "invalid endpoint name");

    const pathname = String(request.url?.split("?")[0] ?? "");
    if (!pathname.endsWith(RPC_ROUTE)) return badRequest(rpcId, "request path is not on channel " + RPC_ROUTE);

    const handler = handlers.get(endpoint);
    if (!handler) {
      log("warn", `unknown endpoint: ${endpoint}`);
      return envelope(rpcId, { ok: false, error: { code: "internal", message: "unknown endpoint: " + endpoint, details: {} } });
    }

    try {
      return envelope(rpcId, { ok: true, value: await handler(call.payload ?? {}) });
    } catch (error) {
      const message = String(error?.message ?? error);
      log("error", `endpoint ${endpoint} failed: ${message}`);
      return envelope(rpcId, { ok: false, error: { code: "internal", message, details: {} } });
    }
  };
}

/**
 * Register the board route on the host, best effort.
 *
 * Never throws: a host with no `connection` service, or a route already claimed
 * by a live copy of this plugin, leaves the tools fully working and only costs
 * the panel.
 *
 * @param ctx - the host plugin context.
 * @param bridge - the shared bridge the snapshot reads through.
 * @param options - `{ maxThreads, maxQueueProbes, includeAccount, log }`.
 * @returns `{ ok, path, reason? }`.
 */
export function mountBoardChannel(ctx, bridge, options = {}) {
  const log = options.log ?? (() => {});
  const register = () => {
    try {
      const connection = ctx.get?.("connection");
      const registry = connection?.fetch;
      if (!registry || typeof registry.register !== "function") {
        log("warn", "connection.fetch.register is unavailable; the board panel stays off");
        return { ok: false, path: RPC_ROUTE, reason: "connection.fetch.register-missing" };
      }

      const handlers = new Map([
        ["snapshot", async (payload) => {
          const client = await bridge.connection();
          return collectBoard(client, bridge, {
            maxThreads: payload?.maxThreads ?? options.maxThreads,
            maxQueueProbes: payload?.maxQueueProbes ?? options.maxQueueProbes,
            includeAccount: options.includeAccount,
          });
        }],
      ]);

      const dispose = registry.register({
        path: RPC_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: createRouteHandler(handlers, log),
      });

      try {
        ctx.effect?.(() => () => { try { dispose?.(); } catch { /* already gone */ } }, `dsh-codex-bridge: ${RPC_ROUTE}`);
      } catch { /* effect is optional */ }

      return { ok: true, path: RPC_ROUTE };
    } catch (error) {
      const message = String(error?.message ?? error);
      // A live patch reload replays the plugin over an already-claimed route; the
      // instance that owns it keeps serving, so this is a yield, not a failure.
      const duplicate = /already registered|duplicate/i.test(message);
      log(duplicate ? "warn" : "error", `${RPC_ROUTE} registration ${duplicate ? "yielded to a live copy" : "failed"}: ${message}`);
      return { ok: false, path: RPC_ROUTE, reason: duplicate ? "fetch-route-duplicate" : message };
    }
  };

  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["connection"], register);
      return { ok: true, path: RPC_ROUTE, pending: true };
    }
  } catch { /* fall through to an immediate attempt */ }
  return register();
}
