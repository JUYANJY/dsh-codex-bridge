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
| `codex_budget` | Reads the rate-limit buckets and says whether Codex is out of quota, quoting the server's own flags. A high `usedPercent` is a level, not a limit, so 100% is not reported as "out of quota". |
| `codex_ask` | One question on a throwaway Codex thread, with a chosen model and effort, then hands the answer back into a development thread verbatim (`feed:false` to only read it). It is the DSH↔Codex quick-chat path; a model override that Codex declines fails the call instead of quietly asking the default model. |
| `codex_handoff` | Builds a takeover brief out of the thread's own records — the objective, the instruction quoted verbatim, what it touched, where it stopped, the quota at that moment, and what the brief cannot know. `saveTo` writes it to a file. `action: "prepare"` writes it as a **takeover** of a thread whose quota is gone; `action: "claim"` records that a person or this session has actually taken it over. |

## Board

The same projection is also a panel inside Harness: a sidebar row named **Codex**
opens a board whose columns are **Needs you** (red), **Blocked** (orange),
**Running** (green) and **Nothing observed** (grey), in that order — the four
states live in `src/task-state.js`, one rule per state.

Every judgement is made on the host, in pure functions, so the panel cannot invent
a status the protocol never reported. Each card shows the state, whether it was
`reported` or `inferred`, the reasons behind it, the evidence it rests on, the
newest recorded turn statuses as a strip, and a progress bar **only when Codex
reported a denominator** (a goal's token budget, or plan steps). With no
denominator the card shows the counts it really has and says
`no progress denominator reported` instead of drawing a bar from nothing.

Six rules keep it honest:

- A thread holding an approval this connection is responsible for is **Needs you**,
  and it is never filed under Blocked even when it also has queued messages.
- *Running* means Codex reported the turn as advancing, **or** this bridge's
  connection saw `turn/started` and has not seen it finish, **or** the rollout was
  touched seconds ago — and that last case is printed as `inferred`. The fourth
  column is **Nothing observed**, never "idle": silence from a connection-scoped
  protocol is not proof that nothing is happening.
- Every card carries a **last** line: the newest item the rollout reports that is not
  encrypted reasoning, with that item's own status printed verbatim. It reports what
  the thread last did; it is not a claim that a turn is running.
- Age is part of the judgement, not decoration, and the age is the **turn's own
  end time** (`completedAt`), never when the thread was last touched — opening a
  thread, or restarting Codex, bumps `updatedAt` and would otherwise make a
  day-old failure look new. A failed turn is **Needs you** while it is fresh; on a
  thread with no goal, a failure older than `FAILURE_ATTENTION_MS` (48 hours)
  keeps its error text as evidence and the card settles to grey. The board's first live run was three red cards whose failures
  were seconds, 3.6 days and 12.8 days old, and only the first wanted anything —
  a red column that never empties is one people stop reading. The same failure on a
  thread that still carries a goal stays red at any age, because the goal is Codex's
  own standing statement about work that is meant to be running.
- Queue, item, turn and goal inspection are sampled (a bounded number of threads per
  refresh, all of it reported in the snapshot's `probe` block), and the board says so
  rather than presenting a partial read as a total.
- The account line and the quota line come from the same predicate as
  `codex_budget`, and a reached quota is a warning that quotes the server's flag.

### When Codex runs out: prepare, then claim

A reached quota is the one failure nothing here retries — it is not a run that
stopped, it is an account that ran out, and a red card that can never change is one
people stop reading. So a quota card offers **Prepare a takeover**: the plugin writes
the handoff brief to `<project>/.codex-handoff/<threadId>-<time>.md` and the card says
so.

**A prepared brief is not a handover, and the panel keeps saying so.** The plugin
cannot push into a Harness conversation, so `claimed` may only be set by an explicit
`codex_handoff action=claim` (or the card's **Mark taken over** button). Until then
the card reads *takeover prepared, unclaimed*, with that sentence attached. The
records live in memory for the run; the file is on disk for whoever looks next.

The panel has exactly three controls. Two only read: **Refresh**, and **Takeover
brief**, which renders the same markdown `codex_handoff` builds, with a Copy
button. The third is the one write path:

**Keep Codex moving for 30m** arms the autopilot. While armed, and only then, a
host-side timer may queue a continuation message into a **Blocked** thread, or into
a **Needs you** thread whose failure the supervisor can read as transient, through
`thread/queue/add` — the same single write `codex_send` uses.

### What it sends

Not a bare "continue". Every automatic message is a **supervision brief** built from
that thread's own record — and only from it: the goal objective Codex was given,
Codex's own last `agentMessage` word for word (with its phase), the newest turn's
status and, when it failed, the error text Codex recorded plus how long ago that was,
the item counts for the turn, and whether a queue is still unconsumed. Nothing is
paraphrased and nothing is invented; where the record is empty the brief says so
(`这个线程没有记录目标`, `没有留下可读的回复文字`).

### Resume, do not replay

Before a supervised message is sent, the thread's working directory is read with
`git status --porcelain` (read-only, 5s, never fatal). A resume is not a re-run: if
the directory already carries uncommitted work — or the failing turn recorded file
changes of its own — the brief says `工作区状态：the working directory already has N
uncommitted change(s)` and lists them, followed by `不要重做已经完成的修改`. When the
directory cannot be read (not a repository, git missing) the brief says it could not
be confirmed and to treat the task as *continue, do not redo*; when it is clean the
brief says that instead, so a retry is known to be safe. The check cannot know
whether Codex already did work and committed it — that is what the brief's own
"what this cannot know" section is for.

### What it will and will not pick up

A red thread stays red when a person really is needed. The failure is classified from
Codex's own error text, and only two kinds are retried:

- **retryable** — `transient` (dropped stream, transport/network error, 502/503/504,
  timeout) and `context` (context window exhausted). These are runs that stopped
  mid-flight, not decisions, so the brief says `这类失败可以直接重试，不必等人`.
- **never retried** — `quota` (usage limit, rate limit, spend control), `auth`
  (credentials, 401/403), and `unknown`, which is anything the pattern list does not
  recognise. The brief then says not to retry and to state what it needs instead.

A thread waiting on an approval, a turn that asked a question, a queue that is not
empty, a turn that moved less than 90 seconds ago, the same stuck turn twice, or the
per-thread and per-run caps all still stop it. Two failed sends halt that thread
and the strip says so, and a thread paused by hand is skipped and shows an
`autopilot paused here` chip. Arming expires on its own after 30 minutes, `Stop keeping it
moving` ends it immediately, and every decision — sent, skipped, halted, with the
message it sent, quoted in full — is listed in the strip. Cards that failed carry a
`retryable failure (transient)` / `needs a person (quota)` line quoting the error, so
what the supervisor decided and why is visible on the card, not just in the log. It
never answers an approval: a person still does that.

The classification is pattern matching over Codex's own error strings — a heuristic,
not a diagnosis, and the module says so in every string it produces. It is written to
fail closed: an unrecognised failure is left for a person rather than retried blindly.

The client half is plain JS loaded by the web client — no build step, like the
shipped client plugins, and it is re-read from disk on page load. The host half is
imported at startup, so host changes need a Harness restart.

## What you cannot do, and why

Five of these are **structural**, not missing features — full evidence in
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
5. **This plugin cannot push into a Harness conversation.** There is no protocol
   method to hand a Codex thread's state to another process, and the panel is
   called by the page, not the other way round. A takeover is therefore prepared
   for a person (or a later Harness turn, via `codex_handoff action=claim`), never
   injected.

Also: `codex_send` is a **real write**, and the board's autopilot is a second, much
narrower one (queue only, armed by a click, capped, expiring, and logged). A queued
message is picked up promptly — in testing, almost immediately — so queueing is
sending, not drafting.
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
npm test            # 212 unit tests, no Codex install required
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
(no DOM, no browser). It covers the seats, the four state columns, the chip and
its basis, the progress bar (present only with a real denominator), the quota
line and its warning, the autopilot strip (off by default, arming, log, halt,
per-thread pause), the takeover brief and the failure path. It does not cover the
shell mounting the two seats, or anything visual — check those by eye.

### Layout

```
src/index.js          cordis entrypoint: name/inject/Config/apply
src/bridge.js         one shared app-server connection, lazily started
src/app-server.js     spawn, JSONL framing, request correlation, inbound requests
src/codex.js          protocol payloads -> compact records
src/notifications.js  which notification methods matter, and how to describe them
src/errors.js         the active-writer error and the explanation shown to users
src/board.js          the projection the tools and the board share
src/task-state.js     the four states, the reasons behind them, and the progress rules
src/autopilot.js      the opt-in queue-only continuation policy, and its log
src/supervise.js      reads Codex's own failure text, and writes the brief handed back
src/quota.js          the one "is Codex out of quota" predicate
src/handoff.js        the takeover brief, built from a thread's own records
src/workspace.js      "resume, do not replay": the read-only git status a pass sees
src/takeover.js       what happens when the quota is gone: keep red, prepare, claim
src/board-channel.js  the host route the panel calls (snapshot, autopilot, handoff, takeover)
src/client.js         the panel itself; loaded by the web client, never by Node
src/tools/*.js        one factory per tool
```

## Requirements

- Node >= 22 (uses `node:test`, ESM, `randomUUID`)
- A Codex install for anything live; the unit tests need none

## License

MIT — see [`LICENSE`](./LICENSE).
