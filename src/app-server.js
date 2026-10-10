/**
 * Minimal JSON-RPC (JSONL over stdio) client for `codex app-server`.
 *
 * Codex ships a full duplex protocol on stdout/stdin: the client sends
 * `ClientRequest` frames, the server answers by `id`, pushes
 * `ServerNotification` frames (no `id`) and issues `ServerRequest` frames
 * (`id` + `method`) that the client is expected to answer — that second
 * channel is how approvals reach a client.
 *
 * `codex app-server` on stdio is the only carrier that works from a foreign
 * process. The ChatGPT.app-bundled CLI cannot start its daemon
 * ("this CLI has no complete local package"), `--listen unix://` builds a
 * socket but never answers, and `~/.codex/ipc/ipc.sock` belongs to the
 * Electron app and speaks something else entirely. See docs/protocol.md.
 *
 * @module dsh-codex-bridge/app-server
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** CLI candidates, in preference order. */
const CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "/usr/bin/codex",
];

/** Default per-call timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the codex executable.
 * @param explicit - an explicit path, highest priority.
 * @returns an absolute path when one exists, otherwise the bare command so PATH can resolve it.
 */
export function resolveCodexBin(explicit) {
  const ordered = [explicit, process.env.DSH_CODEX_BIN, ...CANDIDATES].filter(Boolean);
  for (const candidate of ordered) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable candidate: fall through */
    }
  }
  return "codex";
}

/**
 * A long-lived `codex app-server` child with request/response correlation,
 * notification fan-out, and inbound server-request capture.
 *
 * Events: `ready`, `notification` (message), `serverRequest` (request),
 * `serverRequestResolved` (id), `log` (string), `exit` ({code, signal}),
 * `crashed` (Error).
 */
export class CodexAppServer extends EventEmitter {
  /**
   * @param options - spawn options: `bin`, `args`, `env`, `cwd`.
   */
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.bin = resolveCodexBin(options.bin);
    this.args = options.args ?? ["app-server"];
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.child = null;
    this.starting = null;
    this.initialized = false;
    this.pending = new Map();
    this.nextId = 1;
    /** Inbound server requests awaiting a client answer, keyed by JSON-RPC id. */
    this.inbound = new Map();
    this.stopping = false;
    /**
     * Set by `stop()`. A stopped client must not silently respawn on the next
     * call: `stop()` means stopped, and only an explicit `start()` re-arms it.
     */
    this.stopped = false;
  }

  /** @returns whether a live child is attached. */
  get alive() {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Start (or join the in-flight start of) the app-server child.
   * @returns this client once `initialize` has been answered.
   */
  async start() {
    if (this.alive && this.initialized) return this;
    this.stopped = false;
    if (!this.starting) {
      this.starting = this.#boot().catch((error) => {
        this.starting = null;
        this.initialized = false;
        throw error;
      });
    }
    return this.starting;
  }

  async #boot() {
    const child = spawn(this.bin, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      ...(this.cwd ? { cwd: this.cwd } : {}),
    });
    this.child = child;
    this.initialized = false;
    this.stopping = false;

    child.on("error", (error) => this.emit("log", `spawn failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.starting = null;
      this.initialized = false;
      const failure = new Error(`codex app-server exited (code=${code} signal=${signal})`);
      for (const [, entry] of this.pending) entry.reject(failure);
      this.pending.clear();
      this.inbound.clear();
      this.emit("exit", { code, signal });
      if (!this.stopping) this.emit("crashed", failure);
    });

    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) this.emit("log", line);
    });

    await this.call(
      "initialize",
      {
        // `clientInfo` is the only required field. Everything else here is opt-in.
        clientInfo: { name: "dsh-codex-bridge", title: "DSH Codex Bridge", version: "0.1.0" },
        // Several methods the bridge needs (`thread/queue/*`, `turn/steer`,
        // `process/spawn`) answer `-32600 requires experimentalApi capability`
        // without this. The flag is the whole switch — there is no per-method grant.
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    this.initialized = true;
    this.notify("initialized", {});
    this.emit("ready");
    return this;
  }

  /**
   * Route one inbound JSONL frame.
   * @param line - one raw stdout line.
   */
  #onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.emit("log", `unparsed stdout: ${text.slice(0, 400)}`);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      const request = {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
        receivedAt: Date.now(),
      };
      this.inbound.set(message.id, request);
      this.emit("serverRequest", request);
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "codex app-server error");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else entry.resolve(message.result);
      return;
    }
    if (message.method !== undefined) this.emit("notification", message);
  }

  /**
   * Send one client request and await its result.
   * @param method - a `ClientRequest` method such as `thread/list`.
   * @param params - that method's parameters.
   * @param options - `timeoutMs` overrides the 30s default.
   * @returns the decoded result.
   */
  async call(method, params = {}, options = {}) {
    await this.#ensureChild();
    if (!this.child) throw new Error("codex app-server stopped");
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server call timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Send one client notification (no reply expected).
   * @param method - notification method.
   * @param params - its parameters.
   */
  notify(method, params = {}) {
    if (!this.alive) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch (error) {
      this.emit("log", `notify failed: ${String(error)}`);
    }
  }

  /**
   * Answer an inbound server request.
   * @param id - the inbound JSON-RPC id.
   * @param payload - either `{ result }` or `{ error }`.
   */
  respond(id, payload) {
    this.inbound.delete(id);
    if (!this.alive) return;
    const frame = "error" in payload
      ? { jsonrpc: "2.0", id, error: payload.error }
      : { jsonrpc: "2.0", id, result: payload.result ?? {} };
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.emit("log", `respond failed: ${String(error)}`);
    }
    this.emit("serverRequestResolved", id);
  }

  /** @returns inbound server requests still awaiting an answer. */
  pendingServerRequests() {
    return [...this.inbound.values()];
  }

  /** Kill the child and fail every in-flight call. */
  stop() {
    this.stopping = true;
    this.stopped = true;
    for (const [, entry] of this.pending) entry.reject(new Error("codex app-server stopped"));
    this.pending.clear();
    this.inbound.clear();
    this.child?.kill("SIGTERM");
    this.child = null;
    this.starting = null;
    this.initialized = false;
  }

  async #ensureChild() {
    if (this.stopped) throw new Error("codex app-server stopped");
    if (this.alive) {
      // Still booting: joining `start()` is what awaits the handshake.
      if (!this.initialized && this.starting) await this.starting;
      return;
    }
    if (!this.starting) {
      this.starting = this.#boot().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    await this.starting;
  }
}

/** @returns a fresh opaque client message id. */
export function newClientMessageId() {
  return randomUUID();
}
