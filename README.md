# dsh-codex-bridge

Observe and steer a local **Codex** (OpenAI) session from **DeepSeek Harness**.

The plugin talks to `codex app-server` — the same protocol the Codex app itself
uses — which is what makes the live parts possible at all:

| | Reading the rollout `.jsonl` | This plugin |
| --- | --- | --- |
| Transcript | after it is written | live deltas, plus polls |
| Reasoning | only what was flushed | summary deltas as they stream |
| Rate-limit budget | not present | `account/rateLimits/read` |
| Send a message | not possible | queue (the only cross-process path) |
| Answer an approval | not possible | only for turns this bridge started |

It was built as a DSH counterpart to a Codex session running in the Codex desktop
app: read what that session is doing, hand it the next instruction, and know
exactly which parts are impossible rather than guessing.

## Tools

| Tool | What it does |
| --- | --- |
| `codex_status` | Account, plan, rate-limit budget, local processes, latest thread, pending approvals. Degrades to a readable message when Codex is not reachable instead of throwing. |
| `codex_threads` | Recent threads, optionally filtered by a search string. |
| `codex_transcript` | Items of one thread, newest first. |
| `codex_watch` | Watches a thread for N seconds and returns what streamed past, merging the live notification stream with transcript polls and labelling each event's `source`. |
| `codex_send` | `queue` (default), `turn`, or `steer`. Falls back to the queue when the desktop app holds the thread's write lock. |
| `codex_approvals` | Lists pending approval requests and answers them. |

## What you cannot do, and why

Four of these are **structural**, not missing features — full evidence in
[`docs/limitations.md`](./limitations.md):

1. **The desktop app holds an exclusive write lock on every thread it has opened**,
   even while idle. So `turn`/`steer` are unavailable for those threads and
   `queue` is the only write path.
2. **Approvals go to the client that owns the turn.** For a turn the Codex app is
   running, `codex_approvals` sees nothing and cannot answer for it. Approving the
   app's turns from here is impossible over this protocol.
3. **Live deltas go only to the owning connection.** Watching a desktop-owned
   thread works, but through polling, so it is up to ~1.2s behind and arrives as
   `source: "transcript"`.
4. **Reasoning bodies are encrypted.** You get the emitted summary — rendered as
   `(reasoning not exposed: encrypted)` when there is none — not the hidden chain
   of thought.

Also: `codex_send` is a **real write** and cannot be recalled. A queued message is
picked up promptly.

## Install

The plugin is loaded by name, so the profile needs two symlinks. The script
creates them, moves any existing vendored copy aside (never deletes it), and
records what it did so the change is reversible:

```bash
node scripts/install.mjs --dry-run     # show the plan
node scripts/install.mjs               # apply it
node scripts/install.mjs --write-config # also append the loader entry if missing
```

It targets `~/.dsh/profiles/desktop` by default; override with
`--profile <dir>` or `DSH_PROFILE_DIR`.

Then restart DeepSeek Harness. **This is not optional**: `patchReload: live`
re-reads config, not module code, so a running Harness keeps the module it already
imported (see limitation 6).

To undo:

```bash
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

The loader entry in the profile's `cordis.patch.yml` is hand-maintained config and
is never edited silently — `install.mjs` prints the exact YAML to paste when it is
missing, and `uninstall.mjs` tells you which block to remove.

## Configuration

```yaml
- insert:
    - id: dsh-codex-bridge
      name: dsh-codex-bridge
      config:
        binary: ""            # explicit path to `codex`; empty = auto-detect
        requestTimeoutMs: 30000
```

Binary resolution order:

1. explicit `binary`
2. `$DSH_CODEX_BIN`
3. `/Applications/ChatGPT.app/Contents/Resources/codex`
4. `/opt/homebrew/bin/codex`
5. `/usr/local/bin/codex`
6. `/usr/bin/codex`
7. bare `codex` (resolved on `PATH`)

## Development

```bash
npm test            # 46 unit tests, no Codex install required
node scripts/smoke.mjs   # live handshake against the real app-server
```

`tests/helpers/fake-codex.js` is a real `codex app-server` stand-in: it speaks the
protocol over stdio in a child process, so the transport, framing, correlation and
timeout paths are exercised for real rather than mocked. Its behaviour is driven
by environment variables:

- `FAKE_CODEX_LOCK=1` — `thread/resume` and `turn/steer` answer with the
  active-writer error, which is what a desktop-owned thread does.
- `FAKE_CODEX_SILENT=1` — never answers, for the timeout path.

The smoke script is the only test that needs Codex installed, and it writes to no
thread.

### Layout

```
src/index.js          cordis entrypoint: name/inject/Config/apply
src/bridge.js         one shared app-server connection, lazily started
src/app-server.js     spawn, JSONL framing, request correlation, inbound requests
src/codex.js          protocol payloads -> compact records
src/notifications.js  which notification methods matter, and how to describe them
src/errors.js         the active-writer error and the explanation shown to users
src/tools/*.js        one factory per tool
```

## Requirements

- Node >= 22 (uses `node:test`, ESM, `randomUUID`)
- A Codex install for anything live; the unit tests need none
