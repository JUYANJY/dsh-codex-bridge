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
| `codex_queue` | Shows the messages still waiting on a thread (`action=list`), and cancels one with `action=delete`. Reports what the app-server confirmed, since a live session usually consumes a queued message first. |

## Board

The same projection is also a panel inside Harness: a sidebar row named **Codex**
opens a board whose columns are **waiting for approval**, **turn observed here**,
**queued messages** and **no observed activity**.

It is deliberately **read-only**. The panel polls one host route (a single
`snapshot` endpoint) and holds no path to `codex_send` or `codex_approvals` at all:
a board that could decline an approval by accident would be worse than no board.

Four rules keep it honest, and they are why the columns are named the way they are:

- A thread waiting on an approval is never filed under Queue, even when it also has
  queued messages.
- *Running* means **this bridge's connection saw `turn/started` and has not seen it
  finish** — a statement about the connection, not about the machine. So the last
  column is **no observed activity**, never "idle": silence from a
  connection-scoped protocol is not proof that nothing is happening.
- Every card carries a **last** line: the newest item the rollout reports that is not
  encrypted reasoning (`reasoning` items trail almost every turn and their text is
  sealed), with that item's own status printed verbatim — `inProgress`, `failed`,
  whatever the protocol said. It reports what the thread last did; it is not a claim
  that a turn is running.
- Queue and last-action inspection are sampled (a bounded number of threads per
  refresh, reported in the snapshot's `probe` block), and the board says so rather
  than presenting a partial read as a total.

The client half is plain JS loaded by the web client — no build step, like the
shipped client plugins. It shows up after a Harness restart.

## What you cannot do, and why

Four of these are **structural**, not missing features — full evidence in
[`docs/limitations.md`](./docs/limitations.md):

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

Also: `codex_send` is a **real write**. A queued message is picked up promptly — in
testing, almost immediately — so queueing is sending, not drafting.
`codex_queue action=delete` can cancel an entry that is still waiting, but that is
a race rather than an undo: the tool reports the app-server's own answer instead of
assuming the message never went out.

## Install

### As a bundle (from npm, or from GitHub)

This package ships a `dsh.bundle.patch`, so a profile that installs it and lists
it in `dsh.profile.bundles` mounts it with no hand-written YAML. It is published as
[`@juyanjy/dsh-codex-bridge`](https://www.npmjs.com/package/@juyanjy/dsh-codex-bridge)
on npm, so either source works:

```bash
cd ~/.dsh/profiles/desktop
pnpm add @juyanjy/dsh-codex-bridge                            # from npm
pnpm add "git+https://github.com/JUYANJY/dsh-codex-bridge.git" # or straight from GitHub
```

Then add `"@juyanjy/dsh-codex-bridge"` to `dsh.profile.bundles` in that
`package.json`. That list is what the loader reads: it resolves every listed name
from the profile's `node_modules` and merges the `dsh.bundle.patch` it declares.
The DSH plugin UI does both steps for a bundle, and `dsh plugin --profile desktop
add "<spec>"` forwards to pnpm inside the profile directory.

Write the explicit `git+https://` URL — the `github:user/repo` shorthand goes over
SSH and fails on a machine without a GitHub SSH key. The GitHub route was verified
with a copy of a real profile: pnpm fetches
`codeload.github.com/JUYANJY/dsh-codex-bridge`, installs
`node_modules/@juyanjy/dsh-codex-bridge`, and the whole tree arrives —
`cordis.patch.yml`, `docs/`, and every `src/*.js`. The npm route was verified by
installing the published tarball into a clean directory: `added 1 package`,
26 files, sha1 `608464f2…` — the same tarball the registry reports for `0.1.0`.

### From a checkout (the development route)

For hacking on this repository, or for a profile that should track the working
tree rather than a fetched copy, the plugin can be vendored and loaded by name
instead. The script creates the two symlinks, moves any existing vendored copy
aside (never deletes it), and records what it did so the change is reversible:

```bash
node scripts/install.mjs --dry-run     # show the plan
node scripts/install.mjs               # apply it
node scripts/install.mjs --write-config # also append the loader entry if missing
```

It targets `~/.dsh/profiles/desktop` by default; override with
`--profile <dir>` or `DSH_PROFILE_DIR`.

The package name is `@juyanjy/dsh-codex-bridge` — ours, published on npm. The
unscoped `dsh-codex-bridge` there belongs to an unrelated project, so it is not
ours to use. The two routes
spell the loader entry differently, and each has to match the directory it
creates, because a profile resolves that `name` as a module specifier:

| Route | Installed directory | Entry `name` |
| --- | --- | --- |
| bundle | `node_modules/@juyanjy/dsh-codex-bridge` | `@juyanjy/dsh-codex-bridge` (shipped in `cordis.patch.yml`) |
| checkout | `node_modules/dsh-codex-bridge` → `vendor/dsh-codex-bridge` | `dsh-codex-bridge` (written into the profile) |

Both keep the short id `dsh-codex-bridge`, which is what the config tree and
`plugin_manager` address. Pick one route: with both installed, two entries load
two copies of the plugin.

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

Every entry carries the same config; only `name` differs by install route (see
the table above — the bundle route gets this from the shipped `cordis.patch.yml`).

```yaml
- insert:
    - id: dsh-codex-bridge
      name: dsh-codex-bridge   # '@juyanjy/dsh-codex-bridge' for a bundle install
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
npm test            # 79 unit tests, no Codex install required
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

`tests/client.test.js` renders the panel's React tree in the test process against
a snapshot the host route would really serve, using a minimal React stand-in
(no DOM, no browser). It covers the fields the panel reads, the coverage notes,
the badge rules and the failure path. It does not cover the shell mounting the
two seats, or anything visual — check those by eye.

### Layout

```
src/index.js          cordis entrypoint: name/inject/Config/apply
src/bridge.js         one shared app-server connection, lazily started
src/app-server.js     spawn, JSONL framing, request correlation, inbound requests
src/codex.js          protocol payloads -> compact records
src/notifications.js  which notification methods matter, and how to describe them
src/errors.js         the active-writer error and the explanation shown to users
src/board.js          the read-only projection the tools and the board share
src/board-channel.js  the host route the panel polls (one POST endpoint)
src/client.js         the panel itself; loaded by the web client, never by Node
src/tools/*.js        one factory per tool
```

## Requirements

- Node >= 22 (uses `node:test`, ESM, `randomUUID`)
- A Codex install for anything live; the unit tests need none

## License

MIT — see [`LICENSE`](./LICENSE).
