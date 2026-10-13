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

## 9. What the board's columns can and cannot mean

The board is a different reader of the same protocol, so it inherits every
limitation above and adds four of its own.

**"Running" is connection-scoped, and only that.** `turn/started` and
`turn/completed` are notifications, and notifications go to the connection that
owns the turn (limitation 3). A bridge connection therefore knows a turn is
running only when *it* saw the start and never saw the finish. The last column is
named **no observed activity** rather than "idle" for exactly this reason: with a
desktop-owned thread, "nothing observed" and "nothing happening" are different
claims, and only the first one is available here.

**Queue inspection is a floor, not a total.** `thread/queue/list` is one call per
thread, so a snapshot probes a bounded number of them (`maxQueueProbes`, default
6). The snapshot carries a `probe` block naming the threads it did not reach and
the probes that failed; a failed probe is recorded there rather than being counted
as "nothing waiting". The board prints that count instead of silently rounding a
partial read up to a total.

**A card's "last" line is the last *recorded* item, and its status is quoted, not
interpreted.** `thread/items/list` is one more call per thread (`maxItemProbes`,
default 6, reported in the same `probe` block), read newest-first. Two details are
deliberate:

- `reasoning` items are skipped for the label, because they trail nearly every turn
  and their text is encrypted (`(reasoning not exposed: encrypted)`); the newest
  non-reasoning item is the one that says what actually happened. A thread whose
  only items are reasoning keeps the reasoning line rather than inventing a summary.
- the status shown (`inProgress`, `failed`, …) is the status *of the item the label
  came from*, printed verbatim as the protocol reported it. It is not promoted to a
  column: a stale `inProgress` item left by an interrupted run must not be able to
  make the board claim a turn is running, so `running` still means only "this
  connection saw `turn/started` and has not seen it finish".

Measured while writing this: `thread/items/list` answers for threads this connection
does not own (unlike notifications), so the last line is available for desktop-run
threads too — it is a read of the rollout, not of the live stream.

**The panel is the only part of this plugin that runs in the browser.** Its host
half is an ordinary route on the connection service
(`/api/codexboard`, `fetch.register`), so it lives and dies with the plugin; the
panel itself is plain JS loaded by the web client with no build step, registered
into the shell's own `sidebar.panellist` and keyed `main` slots. Two consequences
worth knowing before editing it: the host half needs a Harness restart
(limitation 6), and the client half needs a page refresh unless
`pnpm run dev:web` is running.

It performs **no writes**. The snapshot endpoint is the whole surface, and the
panel has no path to a write method — that is a deliberate P0 boundary, not an
unfinished feature.

Its React tree is rendered in the test process (`tests/client.test.js`) over a
minimal React stand-in, against a snapshot shaped like the one the route serves:
that catches a renamed field or a panel that throws. Two things stay outside
every test — the shell mounting the two seats, and anything visual (CSS, widths,
colours). Both need a browser and an eye.

## 10. A loader entry's `name` is the installed directory, not the package name

DSH resolves every name in a profile's `dsh.profile.bundles` from the profile's
`node_modules` and merges the `dsh.bundle.patch` that package declares
(`dsh-app-boot`: `packageDirFromAnchor` → `resolveBundleDir` → `loadProfile`), and
the loader imports each entry's `name` as a module specifier from the profile
anchor. Neither step compares it with the package's own `package.json.name`. Two
consequences:

- A package installed as `@juyanjy/dsh-codex-bridge` has to be named that in its
  patch; a checkout vendored as `dsh-codex-bridge` has to be named that. Publishing
  under a scope therefore changes `cordis.patch.yml`, not just `package.json`.
- Installing a package both ways at once — bundle and checkout — loads the plugin
  twice, because the two entries carry different `name`s and neither is deduped.

The `id` is free: it is the address in the config tree and what `plugin_manager`
takes, so both routes keep the short `dsh-codex-bridge` even though their `name`
differs.

## 11. Publishing this package is gated, staged, and not instant

Measured while publishing `0.1.0`. The npm account's 2FA is an **emailed one-time
code**, and a plain session-token publish is refused outright:

```
403 Forbidden - PUT https://registry.npmjs.org/@juyanjy%2fdsh-codex-bridge
Two-factor authentication or granular access token with bypass 2fa enabled is
required to publish packages.
```

`--otp=<code>` does not reach that check. npm only turns `EOTP` or `E401 … one-time
pass` into a prompt (`npm/lib/utils/auth.js`, `otplease`); this endpoint answers
403, and the response carries no `www-authenticate` challenge either. The route
that works is a granular access token with `bypass_2fa`:

```bash
npm token create --registry=https://registry.npmjs.org \
  --name dsh-codex-bridge-publish --scopes=@juyanjy \
  --packages-and-scopes-permission=read-write --bypass-2fa --expires 30
npm publish --registry=https://registry.npmjs.org \
  --//registry.npmjs.org/:_authToken=<token>
```

`--packages-all` is accepted by the CLI and rejected by the registry
(`400 … You must have at least one package / scope or organization added to this
token.`) — a scope is required. Each attempt needs a **fresh** emailed code: a code
is single-use, and reusing one fails as `EOTP … typoed it, or it timed out`.

The registry then publishes in two steps. A `0.0.0-stage` version appears first,
whose own `package.json` is `{"version":"0.0.0-stage","stub":true,
"description":"Temporary package placeholder for staged publishing"}`; the real
version lands about two minutes later and stays alongside it. Propagation is
slower still: after the CLI printed `+ @juyanjy/dsh-codex-bridge@0.1.0`, the
version document (`/@juyanjy/dsh-codex-bridge/0.1.0`) answered 200 immediately,
but the packument (`/@juyanjy%2fdsh-codex-bridge`) and the tarball both answered
404 for about another five minutes. A browser showing "Not Found" right after a
successful publish is therefore a propagation window, not a failed publish.

## 13. The board's colours rest on what the protocol actually reports

Measured on the same machine (Codex CLI `0.155.0-alpha.9.2`), because a task board
that guesses is worse than no board:

- `thread/list` reports `status.type: "notLoaded"` for **every** thread this
  connection has not loaded — which is every thread the user's app is driving. The
  field describes the connection, not the thread, so no state is derived from it.
- The strongest available signal is `thread/turns/list`, which reads the rollout
  from disk and works for threads this connection does not own. Its newest turn
  carries `status` and `completedAt`; a turn stopped mid-flight stays
  `"interrupted"` with `completedAt: null`. Codex does not report a live foreign turn
  as `inProgress` reliably enough to colour a whole column by it, so "Running" also
  accepts this connection's own `turn/started`, and a rollout touched in the last 90
  seconds — and that third case is printed on the card as `inferred`, not as fact.
- `thread/read` on a thread this connection does not own returns the thread with
  `turns: []`. The empty array is the connection's view, not the thread's history:
  use `thread/turns/list` for turns.
- Items carry almost no status: across 20 threads and 25 items each, only
  `commandExecution`, `fileChange` and `mcpToolCall` had one (`completed`/`failed`).
  Everything else has no status at all, so `failed` is reported where it exists and
  silence is not read as success.
- **No `plan` or `todoList` items existed anywhere in that sample** (170 reasoning,
  99 commandExecution, 62 agentMessage, 51 contextCompaction, 40 mcpToolCall, 22
  fileChange, 13 imageView, 13 userMessage, 11 imageGeneration, 3 webSearch, 2
  subAgentActivity). Plan steps are therefore only shown when Codex really reports
  them; a progress bar is drawn only from a denominator that exists (a goal's
  `tokenBudget`, or plan steps). With no denominator the card shows real counts and
  says so instead of inventing a percentage.
- A goal is reported for very few threads (`thread/goal/get` answered `{goal: null}`
  for 19 of 20), so "goal active but no turn running" is a strong signal when it
  appears and simply absent otherwise.
- Quota is a flag, not a percentage: `account/rateLimits/read` carries
  `ordinaryUsageAllowed`, per-bucket `spendControlReached`, `rateLimitReachedType`
  and `credits`, and the schema warns that clients must not infer recovery from
  percentages or reset times. `codex_budget` and the board therefore report
  "reached" only from those flags; 100% used is a level, not a refusal.

## 14. The autopilot's blast radius is one queue, and it is capped

The autopilot is the plugin's second write path (the first is `codex_send`), and it
exists only behind an explicit click:

- It writes through `thread/queue/add` only — the one path that works on a thread the
  Codex app has open. It never calls `turn/start`, never resumes, and never answers an
  approval.
- It is off until armed, disarms itself after 30 minutes, and is memory-only: a
  Harness restart returns it to off.
- It skips a thread when an approval is pending, when the newest turn failed or asked
  a question, when the queue is non-empty, when a turn moved within 90 seconds, when
  it already sent for the same stuck turn, or when that thread has had 3
  continuations (6 per run in total).
- Two failed sends halt that thread permanently for the run (until disarmed and
  re-armed), with the server's own error text kept on the halt record.
- Every decision is appended to a bounded log (80 entries, last 40 shown) and printed
  in the panel's strip. The guard rules live in `src/autopilot.js` and are unit
  tested; the panel only renders what the host decided.
- What it cannot do: tell whether a continuation was *useful*. It observes that the
  thread stopped and that the queue was empty; it cannot see the desktop app's next
  move, so a "sent" entry means "queued", not "worked".

## 15. What the board's first live run corrected

Dropping 165 tests' worth of green onto a real panel immediately produced three
things the tests could not have caught, which is the argument for running the real
thing before believing the suite:

- **Stale failures shouted forever.** Three of twelve cards were red because their
  newest turn had failed — the oldest 12.8 days earlier, on a thread nobody had
  touched since. A red column that never empties is a column people stop reading.
  Failures now decay (see `FAILURE_ATTENTION_MS` in `src/task-state.js`), and a
  thread with a goal keeps its red because the goal is a standing statement.
- **The quota line was blank.** The panel rendered `quota.line`, the client test's
  fixture had a `line`, and the host never produced one: `budgetLine()` was only
  called by the `codex_budget` tool, so the fixture was asserting a field that
  existed only in the fixture. `budgetFromLimits` now returns the line it renders,
  so the tool, the panel and any future caller share one formatter.
- **A paused thread looked like an untouched one.** The pause endpoint worked (the
  autopilot's `paused` list filled up) but the card carried nothing to show it,
  because the board was only told about *halted* threads. The channel now passes
  `autopilotPaused` through and the card shows `autopilot paused here`.

Two smaller things came out of the same pass: the panel was sending `ttlMs` while
the host's knob is `ttlMinutes` (so the click worked by accident, via the default),
and a card whose turn failed now says how long ago it was, in the reason text.

One correction to the section above, for the record: an earlier read of this table
reported the account at 12%/9% and then 25%/20% within the hour, and later still
1%/30% — the buckets move with use, and the primary window resets on its own
schedule (`resetsAt`). Nothing in the plugin extrapolates from those numbers; only
the server's flags decide `reached`.
