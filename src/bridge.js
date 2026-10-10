/**
 * The one long-lived connection every tool in this plugin shares.
 *
 * The app-server child is spawned lazily on first use and kept for the life of
 * the plugin context, so the session's notification history stays in memory
 * between tool calls and Codex does not see a new client on every invocation.
 *
 * @module dsh-codex-bridge/bridge
 */
import { CodexAppServer } from "./app-server.js";

/** How many recent notifications to retain for diagnostics. */
const MAX_RECENT = 400;

/** A lazily started app-server plus the tools that talk to it. */
export class CodexBridge {
  /**
   * @param config - plugin configuration (`binary`, `requestTimeoutMs`).
   */
  constructor(config = {}) {
    this.config = config;
    this.client = null;
    this.recentNotifications = [];
    this.maxRecent = MAX_RECENT;
    this.connecting = null;
  }

  /** @returns a started app-server client (spawned on first use). */
  async connection() {
    if (this.client?.alive) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new CodexAppServer({ bin: this.config.binary || undefined });
      client.on("notification", (message) => {
        this.recentNotifications.push({ at: Date.now(), method: message.method, params: message.params ?? {} });
        if (this.recentNotifications.length > this.maxRecent) this.recentNotifications.shift();
      });
      client.on("log", () => {});
      await client.start();
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Run a body against a live connection.
   * @param body - receives the client.
   * @returns the body result.
   */
  async withClient(body) {
    const client = await this.connection();
    return body(client);
  }

  /** Stop the child process. */
  dispose() {
    this.client?.stop();
    this.client = null;
    this.recentNotifications = [];
  }
}
