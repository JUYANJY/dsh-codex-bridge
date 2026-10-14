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

## 16. A restarted Codex made an old failure look new

The board read `stream disconnected before completion: Transport error: network
error: error decoding response body (48s ago)` for a turn that had actually failed
1h19m earlier. The turn had not moved; the Codex desktop app had been restarted,
which re-touches every thread it loads, and the state machine was measuring the
failure's age from `thread.updatedAt`.

Two consequences, one obvious and one not: the quoted age was wrong, and — because
`updatedAt` also decides whether a failure is old enough to stop asking for a
person — **any** thread you merely opened would have kept an ancient failure red
forever, which is exactly the "red column people stop reading" problem this rule
exists to prevent. The failure's age now comes from the turn's own `completedAt`
(`completionMs()` accepts epoch seconds, epoch millis or an ISO string, and
`failureAgeMs` falls back to the thread's freshness only when the turn has no
completion time, i.e. it was stopped or is still going).

The general lesson, worth more than the fix: a field named `updatedAt` in this
protocol means "someone looked at this thread", not "work happened". `recencyAt`
exists alongside it for the same reason.

## 17. The supervisor reads error text, not causes

`src/supervise.js` decides whether a stopped run may be picked up again by matching
Codex's own recorded error string against a list of patterns, and by quoting what
Codex last said. Both halves are honest about being text, and both are worth stating
as limits:

- **It is pattern matching.** `transient` (dropped stream, transport/network error,
  502/503/504, timeout) and `context` (context window exhausted) are retried; `quota`
  (usage limit, rate limit, spend control), `auth` (401/403) and everything unmatched
  are not. There is no error-code table to consult — the strings below are the actual
  text this machine's threads recorded:

  ```
  Error running remote compact task: stream disconnected before completion:
  Transport error: network error: error decoding response body      → transient
  You've hit your usage limit. To get more access now, send a request
  to your admin or try again on <date>                              → quota
  ```

  Note the first two: the same wrapper (`Error running remote compact task`) sits over
  both, so the wrapper cannot be the signal — the inner text is. A new wrapper with a
  new wording would be classified `unknown`, and `unknown` is never retried. That is
  the designed failure direction: a stopped run stays stopped rather than looping on
  something nobody understands.

- **The brief quotes, it does not summarise.** Goal objective, Codex's last
  `agentMessage` (with its phase), the turn status, the error text, the age of the
  failure, the item counts. Codex's prose is taken from the recorded items — the
  newest `agentMessage` of the newest turn, read through `thread/turns/list`. A thread
  whose turns cannot be read (an ephemeral `codex_ask` thread, see §12) has nothing to
  quote, and the brief says so rather than inventing a summary.

- **What it cannot know.** Whether the work Codex reported is *true*; whether the
  message it sends will actually restart anything (a queued message is delivered, but
  the thread may fail again — that is what the per-thread cap and the two-failure halt
  are for); and whether the goal objective is still what the user wants. The brief
  restates the goal verbatim precisely because it cannot check it.

## 18. A prepared takeover is not a handover, and a resume is not a re-run

When Codex's quota is gone the panel offers to **prepare a takeover**, and nothing
about that operation is allowed to overstate itself.

- **The plugin cannot push into a Harness conversation.** There is no protocol
  method that transfers a Codex thread to another process, and the direction is
  fixed the other way: the panel calls the host (`connection.fetch.register`), not
  the reverse. So a prepared brief is a file plus a record, and the record carries
  `claimedAt: null` until someone claims it — `codex_handoff action=claim`, or the
  card's **Mark taken over** button. Until then the card reads *takeover prepared,
  unclaimed*, with "a brief nobody claimed is not a handover" attached. Softening
  that would be the easiest lie in the whole plugin.

- **The records are in memory; the file is on disk.** A Harness restart forgets
  which briefs were prepared and which were claimed. The markdown is still in
  `<project>/.codex-handoff/`, and it is the same brief `codex_handoff` builds — the
  file is the durable half, the claim state is not.

- **A brief that could not be built is not a takeover.** `prepare` reports
  `ok: false` with the reason (a thread that cannot be resolved, a quota that turns
  out not to be reached, a directory that cannot be written). It never reports
  success with an empty file.

- **Resume, do not replay.** Before a supervised message is sent, `src/workspace.js`
  runs `git status --porcelain` in the thread's own working directory (read-only,
  5-second timeout, and a failure is never fatal). Two limits are stated in the brief
  itself, not hidden: it can only see **uncommitted** work, so a change Codex already
  committed is invisible to this check — the failing turn's recorded `fileChange`
  count is used as a second signal for exactly that case — and a directory that is not
  a repository (or a machine without git) reads as *could not be confirmed*, which the
  brief passes on with "treat it as continue, do not redo" rather than guessing. The
  check never writes, never commits, and never resets anything.

- **What it still cannot know.** Whether the work Codex already did is *complete*
  (a dirty directory says "something is here", not "this is the part you wanted"), and
  whether a resumed run will get further than the one that stopped. Both are stated
  on the card and in the brief.

## 19. The install id has to be the manifest name, or the panel vanishes silently

The host half of this plugin loads by path, so it works under any directory name at
all. The client half does not: the web shell's module registry
(`@deepseek-ai/dsh-client-modules`, the copy inside the app bundle) discovers panels
by calling `locatePkgJson(loaderName)` — `require.resolve(loaderName)`, then walk up
from the resolved file and accept the first `package.json` **whose `name` equals
`exactPackageSpecifier(loaderName)`**. A mismatch means `nearestPackage` returns
`undefined`, the entry is skipped, and nothing anywhere logs it. The plugin keeps
working on the host and simply has no UI.

This bit us for real. The package was renamed to `@juyanjy/dsh-codex-bridge` when it
went to npm (the unscoped name there belongs to an unrelated project), but the
profile's loader row and its `node_modules` link still used the old nickname. After a
restart the panel was gone while every host-side feature kept working, and the
evidence was unambiguous:

- `GET /` returned `window.__DSH_BOOT__` with 84 entry ids and **none** containing
  "codex", while `@liustack/modlens`, `dsh-context` and `dsh-mattpocock-skills-deck`
  were all listed.
- `/plugins/??dsh-context/client.js&rev=…` answered `200` (433,630 bytes), and
  `/plugins/??dsh-codex-bridge/client.js` answered `404` for every `rev`.
- `require.resolve("dsh-codex-bridge")` from the profile *did* resolve to this
  checkout. Resolution was never the problem — the name check was.

So `scripts/install.mjs` now reads the install id from `package.json` instead of
hardcoding one (it refuses to run without a name), vendors and links a scoped name
under its scope, and keeps the loader entry's `id` a plain identifier while its
`name` is the real specifier. `tests/install.test.js` pins all three, because the
symptom is invisible from the host side.

Two consequences worth keeping:

- **Recognise the symptom, and do not chase the wrong thing.** Host tools work,
  `POST /api/codexboard` answers, and the sidebar has no Codex row. That is a dropped
  client entry, not a broken plugin, and the boot manifest is where it shows.
- **Leftover unscoped symlinks are inert, not a fallback.** An older install left
  `vendor/dsh-codex-bridge` and `node_modules/dsh-codex-bridge` behind. They resolve,
  but nothing that matters uses them, and re-pointing a loader row at the nickname
  reintroduces exactly this bug.

