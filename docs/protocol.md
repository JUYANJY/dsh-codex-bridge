# Protocol notes

What this plugin speaks, and the parts of it that were verified rather than
assumed. Everything below is JSON-RPC 2.0 over newline-delimited JSON on the
child process's stdio: `codex app-server`.

Read [limitations.md](./limitations.md) for what the *server* refuses to do across
processes; this file is about the wire format.

## Handshake

```jsonc
// client -> server
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "clientInfo": { "name": "dsh-codex-bridge", "title": "DSH Codex Bridge", "version": "0.1.0" },
    "capabilities": { "experimentalApi": true }      // without this, thread/queue/* is refused
} }
// then, as a notification:
{ "jsonrpc": "2.0", "method": "initialized", "params": {} }
```

Messages are separated by design into three shapes, and the client routes them by
which fields are present — this ordering matters:

| Shape | Test | Handling |
| --- | --- | --- |
| Server request | `id` **and** `method` | captured in `pendingServerRequests()`, emits `serverRequest` |
| Response | `id`, no `method` | resolves/rejects the matching pending call |
| Notification | `method`, no `id` | emits `notification` |

A response is correlated by `id`; an error is turned into an `Error` carrying
`code` and `data` from the payload, and only that one call is rejected.

## Methods used

| Method | Used by | Notes |
| --- | --- | --- |
| `account/read` | `codex_status` | result is `{ account: { email, planType, … } }` |
| `account/rateLimits/read` | `codex_status` | windows in `rateLimits.primary` / `.secondary` |
| `thread/list` | `codex_threads`, thread resolution | `{ limit, cwd? }` |
| `thread/items/list` | `codex_transcript`, `codex_watch` | `{ threadId, limit, sortDirection }` |
| `thread/queue/add` | `codex_send` | the cross-process write path |
| `thread/queue/list` | `codex_queue action=list` | `{ threadId }`; entries carry no order field |
| `thread/queue/delete` | `codex_queue action=delete` | needs `{ threadId, queuedSubmissionId }`; answers `{ deleted }` |
| `thread/resume` | `codex_send mode=turn` | fails on a desktop-owned thread |
| `turn/start` | `codex_send mode=turn` | needs this process to own the thread |
| `turn/steer` | `codex_send mode=steer` | needs `expectedTurnId`; same lock problem |

## Verified result shapes

`thread/queue/add` — note the absence of any queue-order field, which is why the
tool reports the submission id:

```json
{
  "queuedSubmission": {
    "id": "01a12470-c8b0-7992-b011-dc8fabef74f2",
    "input": [{ "type": "text", "text": "…", "text_elements": [] }],
    "clientUserMessageId": "probe-1791612733616"
  }
}
```

`thread/queue/list` — the same entries, in an envelope:

```json
{ "data": [ { "id": "01a12470-…", "input": [ … ], "clientUserMessageId": "…" } ], "nextCursor": null }
```

`thread/queue/delete` → `{ "deleted": true }`.

`thread/items/list` — items are wrapped, and the wrapper carries the turn:

```json
{ "data": [ { "turnId": "…", "item": { "type": "agentMessage", "id": "…", "content": [ … ] } } ] }
```

## Item rendering

`renderItem` projects each item type down to `{ type, text }`. Types handled
explicitly: `userMessage`, `agentMessage`, `reasoning`, `commandExecution`,
`fileChange`, `mcpToolCall`, `todoList`, `error`. Anything else falls back to
`{ type, text }` using whatever text field it carries, so an unrecognised item is
still visible rather than dropped.

`extractText` walks `content` / `summary` / `message` recursively (depth 8) and
joins the string leaves — the payloads are heterogeneously nested and predicting
the exact shape at each call site has not held up.

## Server requests this client answers

`codex_approvals` answers with `{ result: { decision: "accept" | "decline", reason? } }`,
except `currentTime/read`, which is answered with the clock (`unixMs`, …) rather
than a decision — it is a question, not an approval, and answering it with a
decision would be wrong.

Because the reply is what the app-server is waiting on, the answer is sent back
with the **same** JSON-RPC `id` it arrived with, and the id is removed from the
inbound set before sending so a second answer cannot double-respond.

## Message ids

`clientUserMessageId` is a fresh `randomUUID()` per send. It is what lets the
server correlate a queued submission with whatever it does next, so reusing one
across sends would be a bug.
