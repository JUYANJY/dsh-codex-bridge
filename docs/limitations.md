# Limitations

Everything here was observed against a real Codex desktop install (CLI
`0.155.0-alpha.9.2`, `codex app-server` on macOS) while this bridge was being
written. These are properties of the Codex app-server protocol as it behaves in
practice — not bugs in this plugin, and not things a later version of the plugin
can fix from the outside. Read this before trusting a tool.

The one-line summary: **a bridge process can read almost everything and can only
write through the queue.** Everything else is either unavailable across processes
or available only for turns this bridge started itself.

## 1. The desktop app holds an exclusive write lock on every thread it has opened

`thread/resume` and `turn/steer` against a thread the Codex desktop app has open
fail with:

```
thread 01a11a8d-377b-7d73-8a12-df11fd9757f3 already has an active writer
```

The lock is held **even when the thread is idle** and is not released between
turns. A second process therefore cannot take over a thread the app has touched,
and cannot steer one.

Measured directly: a bare `app-server` connection that had never opened the thread
was refused; a thread the app had never opened resumed fine.

**Consequence.** For a thread the app is driving, `codex_send mode=turn` and
`codex_send mode=steer` are permanently unavailable. The plugin does not pretend
otherwise:

- `mode=turn` detects the lock and **falls back to the queue**, reporting
  `mode=turn unavailable → … Fell back to the queue` in `detail`.
- `mode=steer` returns `accepted: false` with the same explanation rather than
  throwing a raw protocol error.

## 2. The queue is the only cross-process write path

`thread/queue/add` is accepted by the app-server even while the app owns the
thread, and the running session consumes the entry at its next opportunity.

Verified reply shape (there is **no** queue-order field):

```json
{ "queuedSubmission": { "id": "01a12470-…", "input": [ … ], "clientUserMessageId": "…" } }
```

This is why the tool reports `queued as <id>` and not an order number.

A queued message is **delivered promptly** — in testing, a message queued onto a
live thread was picked up and acted on almost immediately — so treat `codex_send`
as a real write, not a draft. Cancellation exists but it is a **race, not an undo**.
`codex_queue action=delete` calls `thread/queue/delete`, which needs **both**
`threadId` and `queuedSubmissionId`:

```json
{ "threadId": "…", "queuedSubmissionId": "01a12470-…" }   →  { "deleted": true }
```

The tool refuses to guess either argument — unlike `action=list`, it will not fall
back to "the newest thread for this project" for a destructive call — and it
reports the server's answer rather than assuming. `{ "deleted": false }` means the
entry was already consumed or never existed under that thread: by then the write
has landed and nothing here can take it back.

## 3. Live notifications go only to the connection that owns the turn

`item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
`item/commandExecution/outputDelta` and the `turn/*` markers are delivered to the
client that started the turn. A bridge process watching a thread the desktop app
is running receives **no thread-level events at all** — measured: 20 seconds of
listening produced three global notifications (`configWarning`,
`remoteControl/status/changed`, `account/updated`) and zero thread events.

**Consequence.** `codex_watch` merges two sources for this reason. The
notification stream is what makes a turn *this* bridge started legible in real
time; while the app owns the thread, the polled transcript is the only thing that
moves and each event arrives up to `POLL_INTERVAL_MS` (1.2s) late. Each event is
labelled with its `source` — `stream`, `transcript`, or `error` — so a caller can
tell which one it got.

## 4. Reasoning bodies are encrypted

Reasoning arrives as `{ summary: [...], content: [...] }`, and the provider
encrypts `content`. A reasoning item with an empty summary is normal and renders as:

```
(reasoning not exposed: encrypted)
```

So "see the model's thinking" is bounded: you get the **summary** the model chose
to emit, plus the tool calls and their output. You do not get the hidden
chain of thought. This is the honest ceiling, and the plugin says so rather than
rendering an empty string.

## 5. Inbound approvals are addressed to the owning client, so this bridge sees none

Approval and input requests (`item/commandExecution/requestApproval`,
`applyPatchApproval`, …) are ServerRequests sent to the client that owns the turn.
A bridge process is not that client.

Measured: a fresh bridge connection listening while the desktop app ran turns saw
zero ServerRequests, and had none pending.

**Consequence.** `codex_approvals` works, but its queue only ever contains
requests for turns **this bridge started** (`codex_send mode=turn`, when the thread
is free). For a turn the desktop app is running, the queue stays empty and this
bridge **cannot** answer on the app's behalf. Approving the app's turns from here
is not possible over this protocol; it would need a different channel entirely.

## 6. `patchReload: live` does not reload module code

DSH's live patch reload re-reads configuration, not already-imported ES modules.
A running Harness keeps the plugin implementation it imported at startup.

This is not theoretical: after fixing a capability bug on disk, calls from the
*already-running* Harness still failed with the old error, while a freshly spawned
Node process running the identical file succeeded. **After changing plugin code,
restart Harness (or open a new session).** Bumping `version` and restarting is the
only reliable reload.

## 7. `thread/queue/*` and `turn/steer` need the experimental capability

Without it, these methods answer:

```
thread/queue/add requires experimentalApi capability
```

`app-server.js` sends `capabilities: { experimentalApi: true }` in `initialize`.
There is no per-method grant — the flag is the whole switch — and it is opt-in on
the client side, which is why a client that omits it silently loses queueing.

## 8. Scope of the account data

`codex_status` reports the plan and rate-limit windows for whichever credentials
the local Codex install is using, and lists local `codex` processes. It is a
local-account view; it is not a usage report for a team or an organisation.
