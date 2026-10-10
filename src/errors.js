/**
 * Errors the Codex app-server reports that the bridge needs to understand,
 * rather than merely propagate.
 *
 * The important one: app-server refuses `thread/resume` — and therefore
 * `turn/steer` — while any other process holds the thread. The Codex desktop
 * app keeps that lock on every thread it has open, **including while idle**, so
 * a bridge living in its own process can never take a thread the app is showing.
 *
 * @module dsh-codex-bridge/errors
 */

/** Matches the app-server error text for a thread another client is holding. */
export const ACTIVE_WRITER = /already has an active writer/i;

/** What to tell the caller when that happens. */
export const ACTIVE_WRITER_HINT =
  "another Codex process (the desktop app) holds this thread's write lock, so it cannot be resumed from here. "
  + "Only mode=queue can reach it.";

/**
 * Whether an error is the "someone else owns this thread" refusal.
 * @param error - anything thrown by a client call.
 * @returns true when the message matches the active-writer refusal.
 */
export function isActiveWriterError(error) {
  return ACTIVE_WRITER.test(String(error?.message ?? error));
}
