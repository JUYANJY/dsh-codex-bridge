# PM 复查 + 两项新能力原型：Codex 快速聊天 & 额度监控接管

- 作者：快速原型师（只读分析；**未改动 `src/` 与 `tests/`**）
- 日期：2026-10-13（Asia/Shanghai）
- 落盘位置：`docs/research/`（按约束，唯一写入点）
- 证据基线：
  - **协议权威 schema**（本机实测生成，非猜测）：`/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema --experimental --out /tmp/cxs/json` → 5.3 MB，47 个顶层文件 + `v1/` + `v2/`（388 个 per-type schema）。另有 `generate-ts` 可生成 `.ts` 绑定。
  - **本机版本**：`codex-cli 0.155.0-alpha.9.2`（`/Applications/ChatGPT.app/Contents/Resources/codex`，`src/app-server.js:25-30` 的首选候选）；Homebrew 另有 `0.147.0`。
  - **活体探针**（私有 `codex app-server` 子进程 + 直接复用仓库自身的 `CodexAppServer` 类，因此不影响桌面 App 状态）：
    - `/tmp/cxprobe/probe1.mjs` / `probe1.out` — 额度、账号、模型目录、方法清单、25s 静默监听
    - `/tmp/cxprobe/probe2.mjs` / `probe2.out` — **能力 A 端到端实跑**（ephemeral 线程 + 模型覆盖 + 原文回灌）
    - `/tmp/cxprobe/probe3.mjs` / `probe3.out` — provider 能力、`config/read`、协作模式
    - `/tmp/cxprobe/probe4.mjs` — `model_providers` 实际内容
  - **方法清单来源**：故意用一个不存在的方法名调用（`account/tokenUsage/read`），app-server 回错时会把**全部合法方法名**列出来（`probe1.out`）。这比读 schema 更可靠。

---

## 0. 结论速览（TL;DR）

| # | 结论 | 状态 |
|---|---|---|
| 1 | **能力 A（快速聊天 + 原文照搬）协议完全支持，已端到端跑通**：我实测开了一个临时线程、用指定模型问了一句话、拿到回复 `"PONG"`、并把这段原文当作新 turn 的输入原样回灌成功。 | ✅ 实测通过 |
| 2 | **插件当前对能力 A 的实现度为 0%**：全仓库没有 `thread/start`、没有 `model/list`、没有 ephemeral 概念（`grep` 见 §2.3）。缺的是 3 个原语，不是重构。 | ❌ 完全缺失 |
| 3 | **能力 B 的一半已具备（数据已投影，但没人看）**：`codex.js:162-163` 已经算出 `ordinaryUsageAllowed` 和 `rateLimitReachedType`，却只在 `codex_status` 的一次性文本里渲染（`status.js:79-84`）。**没有任何阈值比较、没有事件、没有定时器**。 | ⚠️ 半成品 |
| 4 | **纠正一个直觉性错误**：`account/rateLimits/updated` **不是周期心跳**。空闲监听 25 秒 = 0 次；在一次 turn 期间 = 1 次。因此额度监控**必须轮询** `account/rateLimits/read`，推送只能当加速器。 | 🔬 实测反直觉 |
| 5 | **纠正第二个错误**：`model/list` 里 `isDefault: true` 的是 `gpt-6-astra`，但实际默认模型是 `gpt-6-sol`（`config/read` → `config.model`，且空 `model` 的 `thread/start` 回显 `gpt-6-sol`/`effort: high`）。**别信 `isDefault`，信 `ThreadStartResponse.model` 回显。** | 🔬 实测反直觉 |
| 6 | **"让 Codex 换个模型继续"做不到**：`thread/start`/`thread/resume` 确实有 `modelProvider` 字段，但本机 `config/read` 的 `model_providers` 实测是 **`{}`**（空），没有配置任何自定义 provider（也没有 deepseek/openrouter/ollama 字样）。 | ❌ 当前不可行 |
| 7 | **"接手继续开发"的诚实含义**：不是把 Codex 的会话搬走（协议没有这个门），而是 **DSH 用导出的上下文自己继续做**。插件能做的是「检测 → 中断 → 导出上下文包 → 告诉 DSH」。 | ✅ 可行（边界明确） |
| 8 | **今天就能做完 3 件**（见 §5）：修一个空文本 bug（1 行级）、`codex_budget` 结构化额度、`codex_ask` 快速聊天 MVP。 | 🎯 今天 |

**能力 B 的一个更省事的分支**：本机有 **2 个 reset credit**（`rateLimitResetCredits.availableCount: 2`，`probe1.out`），协议方法 `account/rateLimitResetCredit/consume` 可**立刻恢复额度**，有效期分别到 2026-10-30 和 2026-11-07。"耗尽时把进程接给 DSH"之前，先问一句"要不要花掉一张重置券"可能更划算。这是**不可逆消耗**，必须用户显式确认。

---

## 1. PM 视角：问题陈述（problem-statement 框架）

用 `~/.dsh/skills/problem-statement` 的 Problem Framing Narrative 复述用户目标：

- **I am:** 一个同时使用 Codex 桌面 App 和 DeepSeek Harness 做同一个项目开发的开发者。
- **Trying to:** (a) 在做关键决策时，**借用 Codex 侧最强模型的判断力来问方向**，然后把它的答案原样交回给正在干活的 Codex 线程，让它照做；(b) **别在额度耗尽的那一刻才发现**——断了能有个东西接着干。
- **But:** 现在的桥是**只读观察者为主**：它能看见额度百分比（`status.js:79-84`）却不会在越线时说话；它能看线程却**开不了线程**（无 `thread/start`）；它能发消息（`send.js`）却**指定不了用哪个模型**（`model` 参数只在 `mode=turn` 生效，而 `mode=turn` 对桌面 App 拥有的线程基本不可用 —— `README.md:67-69`、`send.js:104-115`）。
- **Because:** 插件的定位是"投影 + 少量写入"，写入面被刻意收窄（autopilot 只有 `thread/queue/add` 一条写路径，`autopilot.js:13-14, 439-443`）；而"问方向"需要一个**属于自己拥有的新线程**——那是插件从未涉足的领域。
- **Which makes me feel:** 手里有工具，但每次都要人去盯着百分比、人肉复制粘贴，像在**手动轮询一个本该自动的东西**。

**Final problem statement：** 开发者把 Codex 当主力，却必须人工盯着额度、人工搬运"最强模型的建议"，因为这座桥只学会了"看"和"塞一条消息"，没学会"开一个自己的线程替我问一句"和"快没额度时喊我一声"。

---

## 2. 功能复查：已具备 / 半成品 / 缺失（带文件行号）

### 2.1 已具备（可直接复用，别重写）

| 能力 | 证据 |
|---|---|
| JSON-RPC over JSONL 分帧、请求关联、双向（含 server→client 的 approval 通道） | `src/app-server.js:158-193`（`#onLine`）、`202-223`（`call`）、`244-256`（`respond`）、`259-261`（`pendingServerRequests`） |
| 握手与 experimental 开关（`thread/queue/*`、`turn/steer`、`process/spawn` 都需要它） | `src/app-server.js:136-147`（`capabilities.experimentalApi: true`）+ `149`（`notify("initialized")`） |
| 二进制解析（含 `DSH_CODEX_BIN` 覆盖） | `src/app-server.js:40-50` |
| 额度读取与投影：`account/read` + `account/rateLimits/read` 并行 | `src/codex.js:144-150`（`readAccountState`） |
| 额度投影已含**诚实谓词**：`ordinaryUsageAllowed`、`reached`（= `rateLimitReachedType`）、`resetCreditsAvailable` | `src/codex.js:160-170`（`compactLimits`，具体 `:162`、`:163`、`:170`） |
| 跨进程唯一可靠写路径 `thread/queue/add` + 回读校验 | `src/tools/send.js:26-44`（`queue`）、`src/autopilot.js:418-427`（`readQueueVisible`） |
| 已有定时器基础设施（可按 arm/TTL 限时启用） | `src/autopilot.js:368-378`（`startTimer`，unref，仅在 `armed` 时 tick） |
| 通知流认识额度通知方法名 | `src/notifications.js:33`（`"account/rateLimits/updated"` 在 `LIVE_MARKER_METHODS` 里） |
| 面板宿主管道（单路由 + 面板轮询） | `src/board-channel.js:25-26`（`RPC_ROUTE = /api/<channel>`）、`54-71`；`src/client.js:201`（`setInterval(load, POLL_INTERVAL_MS)`） |
| 对话/线程投影（`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/goal/get`） | `src/codex.js`（投影层，`grep` 命中 `thread/items/list`×2、`thread/turns/list`×1、`thread/goal/get`×1） |

### 2.2 半成品（有基础，但差最后一步——这些是最便宜的改进）

| # | 半成品 | 证据 | 差什么 |
|---|---|---|---|
| B-1 | **额度通知被"认识"却渲染成空** | `src/notifications.js:33` 把它列为 marker；但 `describeNotification`（`:43-51`）只处理 `delta/text/chunk/message/summary`、`params.item`、`params.status`、`params.tokenUsage`，**没有 `params.rateLimits` 分支**，落到 `:50` 返回 `""` | 一个分支。实测该通知确实会来（`probe2.out:26`，turn 期间 1 次，载荷只有 `{rateLimits: {...}}` 单桶视图），所以现在 `codex_watch` 会输出一行**空文本事件** |
| B-2 | **"到达上限"的判定算出来了，但没人消费** | `src/codex.js:162`（`ordinaryUsageAllowed`）、`:163`（`reached`）已投影；`status.js:79-84` 只把它拼成一句人读的字符串（且 `reached` 为空时不显示） | 没有 `boolean` 出参、没有阈值、没有事件、没有轮询。`grep` 全仓库：**无**任何 `usedPercent >= X` 比较、**无**任何额度轮询定时器（`setInterval` 只有 3 处：`client.js:201` 面板快照、`autopilot.js:370` 只服务续跑、`app-server.js:209` 是超时器） |
| B-3 | **额度到顶后仍然会写** | autopilot 的守卫（`autopilot.js:111-133`）涵盖未武装/过期/暂停/已停/状态非 blocked/有审批/上轮失败/已排队/沉降/指纹去重/单线程上限/全局上限/最小间隔，**但没有一条检查额度** | 加一条 `quota-reached` 短路即可（1 行判断 + 1 条 skip 文案），风格与现有 `skip()` 完全一致 |
| B-4 | **面板只读，但没有额度视图** | `README.md:38-40` 明确"deliberately read-only"；`src/client.js:126-130` 有 `usedPercent` 渲染，但那是**看板卡内的额度行** | 缺"额度红卡/顶栏告警"。另注：`README.md:38` 的"read-only"叙述与工作区里**未提交**的 `src/autopilot.js`（有 arm/disarm 写路径）已经不一致 → **文档漂移** |
| B-5 | **`codex_send` 的模型覆盖对大多数真实场景无效** | `send.js:60` 声明 `model`，`:119` 只注入 `turn/start`；`:86` 的 `queue` 分支不接受 model；`:91-96` 的 `steer` 也不接受。而实测 `TurnSteerParams` **没有** `model`/`effort` 字段（schema 权威）；`mode=turn` 对桌面 App 拥有的线程会被写锁挡住并回退成 queue（`:104-115`） | 不是 bug 而是边界；但 UI/描述会让人误以为"能换模型" |

### 2.3 缺失（能力 A / B 的真正缺口）

| # | 缺失 | 为什么关键 |
|---|---|---|
| M-1 | **`thread/start` 完全没用过**（`grep -rn "thread/start" src/` → 0 命中，只有 `turn/start`） | 能力 A 的地基：你需要一个**属于自己拥有的**线程，才能在它上面自由指定模型、跑 turn |
| M-2 | **`ephemeral` 概念缺失**（全仓库 0 命中） | 问方向是**一次性**的，不该污染用户 Codex 侧栏历史。`ThreadStartParams.ephemeral` 正是为此而设，且实测**不出现在 `thread/list`** |
| M-3 | **`model/list` 未使用**（0 命中） | 没有模型目录就无法让用户/DSH 挑"最强模型"，也无法校验模型名拼写 |
| M-4 | **`turn/interrupt` 未使用**（0 命中） | 额度耗尽时最该做的一件事是**立刻停下正在烧额度的 turn**。实测方法存在（错误文本 `"no active turn to interrupt"`） |
| M-5 | **`account/usage/read` 未使用**（0 命中） | 长期用量画像（`lifetimeTokens: 301010992`、`dailyUsageBuckets`）可用于"今天还剩多少"的估算。**注意方法名不是 `account/tokenUsage/read`**（schema 文件名 `GetAccountTokenUsageResponse.json` 有误导性，实测报错才确认真名是 `account/usage/read`） |
| M-6 | **无任何"上下文导出包"** | 接管要交接的是**任务状态**，不是一句话。已有 `thread/turns/list`/`thread/items/list` 的读能力，但没有把它组装成一份可交给 DSH 的文档 |
| M-7 | **无额度事件上报通道** | 面板是 DSH **主动 POST** 去拉的（`board-channel.js:54-71`，`client.js:201`），插件**无法主动推**给 DSH。所以"额度到顶时告诉 DSH"要么靠面板轮询，要么靠 **DSH 侧定时调 `codex_budget`** |

---

## 3. 能力 A 设计原型：快速聊天（问方向）→ 原文照搬回灌

### 3.1 协议侧答案（先回答任务里点名的三个问题）

**Q1：能否为一次询问指定更强/更快的模型？** → **能，逐 turn 可覆盖。**

`TurnStartParams.model`（`v2/TurnStartParams.json`），描述原文：`"Override the model for this turn and subsequent turns."`
`TurnStartParams` 另一个可用旋钮是 `effort: ReasoningEffort`（`"Override the reasoning effort for this turn and subsequent turns."`）—— 实测 `effort` 是**自由字符串**，`model/list` 给出的合法值是 `low|medium|high|xhigh|max|ultra`。

**Q2：「快速聊天」在协议侧对应什么？** → **`thread/start`（`ephemeral: true`）+ `turn/start`**，模型写在 `thread/start` 或 `turn/start` 的 `model` 上。

- `ThreadStartParams.model` 存在；实测 `{"ephemeral":true,"cwd":"/tmp","approvalPolicy":"never","model":"gpt-5.6-luna"}` → 回显 `{"model":"gpt-5.6-luna","effort":"high"}`，**覆盖生效且可校验**。
- 不带 model 的 `thread/start` → 回显 `{"model":"gpt-6-sol","effort":"high","sandbox":{"type":"readOnly","networkAccess":false},"approval":"never"}`（注意：不是 `model/list` 标 `isDefault` 的 `gpt-6-astra`）。
- `TurnSteerParams` **没有** model/effort → **不能中途换模型**。

本机模型目录实测（`model/list`，6 个，全部 `hidden: false`）：

| id | displayName | defaultReasoningEffort | 可用 effort | serviceTier |
|---|---|---|---|---|
| `gpt-6-astra` | GPT-6-Astra | low | low…ultra | priority "Fast"（2x speed, increased usage） |
| `gpt-6-sol` | GPT-6-Sol | medium | low…ultra | priority "Fast"（1.5x speed） |
| `gpt-6-luna` | GPT-6-Luna | medium | low…ultra | priority "Fast"（1.5x speed） |
| `gpt-5.6-sol` | GPT-5.6-Sol | low | low…ultra | priority "Fast"（1.5x, increased usage） |
| `gpt-5.6-terra` | GPT-5.6-Terra | medium | low…ultra | priority "Fast"（1.5x, increased usage） |
| `gpt-5.6-luna` | GPT-5.6-Luna | medium | low…ultra | priority "Fast"（1.5x, increased usage） |

> ⚠️ 协议**不提供**"强弱/快慢"排序字段（没有 benchmark、没有 tier 等级，只有 `serviceTier` 的"加速"语义，而那是**花更多额度换速度**）。所以"性能最强的模型"必须由**插件侧的偏好表**决定，并且要可配置。建议默认 `gpt-6-astra` + `effort: "max"`（把它当"最强"），并在工具描述里说明这是**操作者可改的假设**，不是协议结论。

**Q3：怎么拿回复、怎么"原文照搬"？** → 通知 `item/completed` 的 `params.item.text`。

实测一次 turn 期间的通知序列（`probe2.out:14-27`）：

```
thread/started, warning×2, mcpServer/startupStatus/updated×15, thread/settings/updated,
thread/status/changed×2, turn/started, account/updated, item/started×2, item/completed×2,
item/agentMessage/delta×2, thread/tokenUsage/updated, account/rateLimits/updated, turn/completed
```

文本载体只有两个：
- `item/agentMessage/delta` → `{delta: "P"}`, `{delta: "ONG"}`（增量）
- `item/completed` → `{item: {type: "agentMessage", text: "PONG"}}`（**完整**）

→ 取 `item.completed` 里 `item.type === "agentMessage"` 的 `item.text`，就是**可以直接原样交给 Codex 的字符串**。实测最终值 `"PONG"`。

原样回灌的两种写法（都实测/核对过）：
- 自己拥有的线程：`turn/start { threadId, input: [{type:"text", text: <reply>}] }` —— 实测被接受（`probe2.out:37`）。
- 桌面 App 拥有的线程：`thread/queue/add { threadId, clientUserMessageId, input: [{type:"text", text: <reply>}] }` —— 与 `send.js:26-31` 同一路径，这是**唯一**跨进程可靠写路径（`README.md:67-69`）。
- 另有 `thread/inject_items { threadId, items }`（描述原文：`"Raw Responses API items to append to the thread's model-visible history."`）—— 更适合"注入上下文"而非"发一条用户消息"，**未实测**。

### 3.2 落地流程（可实现的伪代码，建议新文件 `src/tools/ask.js`）

```
codex_ask({ question, context?, model?, effort?, threadId?, feed? })

1) 目录（可缓存 10 分钟）
   client.call("model/list", { limit: 50 })            // → data: Model[]
   const chosen = model ?? PREFERRED_STRONG ?? 生效默认

2) 开一个一次性线程（关键：ephemeral 不污染用户历史）
   const started = client.call("thread/start", {
     ephemeral: true,
     cwd: <当前工作区绝对路径>,
     approvalPolicy: "never",                 // 问方向不需要工具，别让它卡在审批上
     model: chosen,                           // 可用 ThreadStartResponse.model 回显校验
     // 不传 effort 也可以；默认会回显 high
   })
   assert started.model === chosen             // ← 这一步是"覆盖真的生效了"的证据

3) 问一句
   client.call("turn/start", {
     threadId: started.thread.id,
     effort: effort ?? "max",
     clientUserMessageId: newClientMessageId(),
     input: [{ type: "text", text: context ? `${question}\n\n---\n背景：\n${context}` : question }],
   })

4) 收原文（订阅 item/completed，直到 turn/completed / turn/failed）
   reply = item.completed where item.type === "agentMessage" → item.text
   // 注意：ephemeral 线程读不回来，见下面的坑

5) 回灌（feed === true 且给了 threadId 时）
   client.call("thread/queue/add", {
     threadId: <开发线程>,
     clientUserMessageId: newClientMessageId(),
     input: [{ type: "text", text: reply }],   // ← 一字不改
   })

返回：{ model, effort, reply, fedTo, feedAccepted }
```

### 3.3 实测踩到的坑（**必须写进实现，否则一定翻车**）

1. **`ephemeral` 线程不能用 `thread/turns/list` 读回**。实测错误原文：`"ephemeral threads do not support thread/turns/list"`（`probe2.out:38`）。
   → 含义：回复**只能**从通知流里抓，**没有第二次机会**。所以要么（a）已确保订阅了 `item/completed` 再 `turn/start`，要么（b）放弃 ephemeral。**不要**先跑再想读。
2. **`ephemeral` 确实不污染历史**：实测 `thread/list` 在开完 ephemeral 线程后 `count=10` 且 `chatThreadVisible=false`（`probe2.out:40-41`）。这是它值得用的理由。
3. **回灌进 App 拥有的线程时，`turn`/`steer` 会被写锁挡住**（`README.md:67-69`，`send.js:104-115` 的 fallback 就是为此写的）→ 默认走 `queue`。
4. **"原文照搬"要守住字面意思**：任何前缀/后缀（如"以下是建议："）都破坏了这个需求。若要标注出处，请放进 `clientUserMessageId`，或作为**独立的第二条** queue 消息，不要包在 `reply` 里。
5. **别信 `model/list.isDefault`**（见 §0 第 5 条）。
6. **`turn/start` 的 `model` 会影响"后续 turns"**（schema 原文），临时线程无所谓，但对开发线程用 `turn` 模式时要意识到这一点。

---

## 4. 能力 B 设计原型：额度实时监控 + 接管继续开发

### 4.1 额度信息从哪来（实测三源）

| 源 | 方法/通知 | 实测事实 | 用途 |
|---|---|---|---|
| 权威额度 | **`account/rateLimits/read`** `{}` | 返回 `{ ordinaryUsageAllowed, rateLimits, rateLimitsByLimitId, rateLimitResetCredits, accountId, rateLimitUpsell }` | **主数据源** |
| 用量画像 | **`account/usage/read`** `{}` | `{ summary:{lifetimeTokens:301010992, peakDailyTokens:78441478, longestRunningTurnSec:32449, currentStreakDays:0, longestStreakDays:6}, dailyUsageBuckets:[{startDate,tokens}], threadUsage }` | 辅助（趋势/估算），**不是**额度判定 |
| 推送 | 通知 **`account/rateLimits/updated`** | 空闲 25s：**0 次**；turn 期间：**1 次**。载荷**只有** `{ rateLimits: RateLimitSnapshot }`（单桶视图，**没有** `ordinaryUsageAllowed`、**没有** `rateLimitsByLimitId`） | **加速器，不能当唯一源** |

实测快照（2026-10-13 23:49，账号 `rememberthetimety@gmail.com`，plan `plus`）：

```json
{"ordinaryUsageAllowed": true,
 "rateLimits": {"limitId":"codex","limitName":null,"normalModelSlug":null,
   "primary":   {"usedPercent":23,"windowDurationMins":300,  "resetsAt":1791913980},
   "secondary": {"usedPercent":19,"windowDurationMins":10080,"resetsAt":1792475700},
   "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
   "individualLimit":null,"spendControlReached":false,
   "planType":"plus","rateLimitReachedType":null},
 "rateLimitsByLimitId": {"codex": { ...同上... }},
 "rateLimitResetCredits":{"availableCount":2,"credits":[
   {"id":"RateLimitResetCredit_7c5606...","resetType":"codexRateLimits","status":"available",
    "grantedAt":1790702094,"expiresAt":1793294094,"title":"Full reset (Weekly + 5 hr)"},
   {"id":"RateLimitResetCredit_70e60ef7...","resetType":"codexRateLimits","status":"available",
    "grantedAt":1791414309,"expiresAt":1794006309,"title":"Full reset (Weekly + 5 hr)"}]},
 "accountId":"21e6732c-30a4-48c8-a92f-1be20aebbbec","rateLimitUpsell":null}
```

**两个实现细节**：
- `resetsAt` 是 **epoch 秒**（不是毫秒）→ `new Date(resetsAt * 1000)`。`1791913980` = 2026-10-14 01:53 +08；`1792475700` = 2026-10-20 13:55 +08。
- `rateLimits`（单桶向后兼容视图）与 `rateLimitsByLimitId["codex"]` 当前内容完全相同；**不要假设永远相同**，判定要按 `limitId` 遍历 `rateLimitsByLimitId`。

### 4.2 如何判定"到达上限"（三级，诚实版）

```
L0 预警（advisory，纯百分比）
   primary.usedPercent >= WARN_PCT (建议 80)
   → 只是提醒，不代表不能干活

L1 硬事实（协议权威，任一成立）
   bucket.rateLimitReachedType !== null
     枚举：rate_limit_reached | workspace_owner_credits_depleted |
           workspace_member_credits_depleted | workspace_owner_usage_limit_reached |
           workspace_member_usage_limit_reached
   或 bucket.spendControlReached === true
   或 bucket.credits.unlimited === false && bucket.credits.hasCredits === false && ...（次要）

L2 最终裁决
   ordinaryUsageAllowed === false
   schema 原文："Backend permission for ordinary included usage ... Null means unavailable;
                 clients must not infer recovery from percentages or reset times."
```

**不要做**：
- 不要用 `usedPercent >= 100` 当上限（`usedPercent` 是 advisory 的整数百分比）。
- 不要自己推算恢复时间（`resetsAt` 只告诉你窗口何时重置，**不是**"到时一定能干活"）。
- 不要用 `credits.balance === "0"` 单独判定（`unlimited:false` + `hasCredits:false` 时它本来就是 0，是**正常**状态，不是额度耗尽）。

好消息：**这个谓词在本仓库已经被算出来了**，只是没被使用 —— `src/codex.js:162-163`（`ordinaryUsageAllowed`、`reached`）。

### 4.3 监控循环设计

```
轮询：account/rateLimits/read {}
  间隔：空闲 60s / 有 turn 在跑 15s
  成本：无模型调用、无 token 消耗、单次 <100ms
  去向：
    - 写进看板快照（新增 quota 块）→ 面板顶栏/红卡
    - autopilot 的守卫加一条短路：额度到顶时不发送（现在没有这条，autopilot.js:111-133）
    - 暴露成 DSH 可调的工具（见 4.5）
加速器：在已有的通知流里捕获 account/rateLimits/updated → 立刻触发一次 read
        （因为通知载荷只有单桶视图，拿不到 ordinaryUsageAllowed）
        ← 顺手要修 notifications.js 的空文本 bug（§2.2 B-1），否则这行在 watch 里是空白
```

### 4.4 「接手继续开发」的诚实可行边界 ⭐

这是任务点名要回答的。我把 DSH/插件**能写什么、不能写什么**列全：

**✅ 能做（全部有协议依据）**

| 动作 | 方法 | 依据 |
|---|---|---|
| 检测到顶 | `account/rateLimits/read` | §4.2 |
| 让 DSH 知道 | 面板轮询快照 + DSH 侧调 `codex_budget`（插件无法主动推 DSH，`board-channel.js:54-71` 是拉模型） | §2.3 M-7 |
| **停住正在烧额度的 turn** | `turn/interrupt { threadId, turnId }` | 方法实测存在（错误文本 `"no active turn to interrupt"`）；`TurnInterruptParams` required `[threadId, turnId]`。**但**：对**桌面 App 拥有的** turn，interrupt 会不会被所有权/写锁拒绝——**未实测**，与 `turn/steer` 同属"需要通过所有权"的方法，风险相同 |
| **导出上下文包** | `thread/read {threadId, includeTurns:true}`、`thread/turns/list {threadId, limit, sortDirection, itemsView}`、`thread/items/list {threadId, turnId?, limit, sortDirection}` | schema 权威；插件已有这些读能力（投影层） |
| **DSH 接手干活** | 无需新协议方法 | DSH 本来就有本工作区的 bash/edit/write。它读上下文包 → 自己继续。**这才是"接手"的真实含义** |
| （更省事的替代）**恢复额度** | `account/rateLimitResetCredit/consume { idempotencyKey, creditId? }` | 实测 `availableCount: 2`；两张券分别到 2026-10-30 / 2026-11-07。`creditId` 省略时由后端选下一张。**不可逆，必须用户显式确认** |

**❌ 做不到（协议里没有这扇门，别编造）**

| 想法 | 为什么不行 |
|---|---|
| 把 Codex 线程的会话状态"搬"到 DSH 的会话里 | 没有任何 export/handoff/transfer 方法。方法清单里最接近的只有 `thread/read`、`thread/items/list`（读），没有"转移所有权"或"会话导出" |
| **让 Codex 继续开发但改用别的模型（如 DeepSeek）** | `thread/start`/`thread/resume` 确实有 `modelProvider` 字段，但本机 `config/read` 的 `model_providers` 实测为 **`{}`** —— 没有配置任何自定义 provider（`config/read` 全文里没有 `deepseek`/`openrouter`/`ollama`/`wire_api` 字样）。要做这件事必须先在 `~/.codex/config.toml` 写 `model_providers` + 端点/鉴权，**且**还要面对桌面 App 的写锁（`README.md:67-69`）。**未验证**，不建议当成可行方案 |
| 让插件自己"继续开发" | 插件的写面只有 `thread/queue/add`（`autopilot.js:439-443`）、`turn/start`/`turn/steer`（`send.js:91-120`）。它**没有**编辑代码的能力，也不该有 |
| 额度耗尽后继续往 Codex 塞消息让它干 | 逻辑上说不通，且**未实测**（要真的耗尽一次才知道 queue 还能不能被消费）。**不要**把它写进设计假设 |
| 从插件主动 push 给 DSH | 宿主通道是"DSH POST 去拉"（`board-channel.js:54-71`），插件侧没有主动推送 DSH 的 API |

### 4.5 建议的接口形态

```
codex_budget({ action: "read" | "watch" | "handoff" })
  read    → { reached: bool, level: "ok"|"warn"|"reached", reason: enum|null,
              ordinaryUsageAllowed: bool|null, spendControlReached: bool,
              buckets: [{limitId, usedPercent, windowMins, resetsAtISO}],
              resetCredits: {availableCount, credits:[{id,title,expiresAtISO}]},
              resetsAtISO }
            // 尽量原样透传 codex.js:160-170 已投影的字段，只加 level 与 ISO 时间
  watch   → 按 autopilot 的 arm/TTL 模式起限时轮询（autopilot.js:173-188 的 arm 是现成范式），
            到顶时把结果写进看板快照 + 一条明确的告警行
  handoff({ threadId })
          → 读 turns/items → 写一份上下文包到 <workspace>/.codex-handoff/<threadId>-<ts>.md
            （内容：goal、最近 N 个 turn 的 item、最后一条失败命令、待审批项、额度快照）
          → 返回该路径 + 一行摘要，交给 DSH 自己继续
```

---

## 5. 优先级建议（Value vs. Effort；按 `prioritization-advisor` 的分档）

数据现状：**单人维护的插件、无用户行为埋点、需求方就是唯一的用户本人** → 量级框架（RICE）不适用（没有 Reach 数据）；用 **Value vs. Effort 2×2** 更诚实。判定依据：能力 A 已被实测证明可行（高 Confidence），能力 B 的地基（额度谓词）已在仓库里（低 Effort）。

| 优先级 | 事项 | 价值 | 投入 | 今天可做完 | 触碰文件 |
|---|---|---|---|---|---|
| **P0-1** | **`codex_ask` 快速聊天 MVP**：`thread/start{ephemeral}` + `turn/start{model,effort}` + 收 `item/completed` → 返回原文；`feed:true` 时走 `thread/queue/add` 原样回灌 | ⭐⭐⭐⭐⭐ 直接交付用户目标 (1)，实测已跑通 | ~2h | ✅ | 新增 `src/tools/ask.js`、在 `src/tools/index.js` 注册 |
| **P0-2** | **修 `describeNotification` 的空文本 bug**：加 `params.rateLimits` 分支（输出如 `budget 23%/300min`） | ⭐⭐⭐ 现在 watch 会输出空行；实测推送确实会来 | ~15min | ✅ | `src/notifications.js:43-51` |
| **P0-3** | **`codex_budget`（或给 `codex_status` 加结构化出参）**：`reached`/`ordinaryUsageAllowed`/`resetsAtISO`/`resetCredits` + 80% 预警 | ⭐⭐⭐⭐ 能力 B 的地基；字段已在 `codex.js:162-163` | ~2h | ✅ | `src/tools/status.js`（或新增 `src/tools/budget.js`）、`src/codex.js` 小改 |
| **P1-1** | **额度轮询 + 面板告警**（60s/15s，写进看板快照） | ⭐⭐⭐⭐ 从"能查"到"会喊" | ~3h | ⚠️ 紧 | `src/board.js`、`src/client.js`、`src/board-channel.js` |
| **P1-2** | **autopilot 加 `quota-reached` 守卫** | ⭐⭐⭐ 防止额度到顶后还在瞎写 | ~30min | ✅ | `src/autopilot.js:111-133` 附近 |
| **P1-3** | **`handoff` 上下文包导出** + DSH 侧接管流程写进 docs | ⭐⭐⭐⭐ 用户目标 (2) 的另一半 | ~3h | ⚠️ 紧 | 新增 `src/tools/handoff.js`、`docs/` |
| **P1-4** | **修 `README.md` 与未提交 `autopilot.js` 的漂移**（"read-only"叙述已过时） | ⭐⭐ 诚实性；这个项目的卖点就是诚实 | ~20min | ✅ | `README.md:32-60` |
| **P2-1** | 实测 `turn/interrupt` 对**桌面 App 拥有的** turn 是否可用 | ⭐⭐⭐ 决定"能不能真的止损" | ~1h | ❌ 需要有活动 turn | 探针脚本（`/tmp`） |
| **P2-2** | 实测"额度耗尽后 `thread/queue/add` 是否仍被消费" | ⭐⭐⭐ 决定接管流程的紧急程度 | 需真实耗尽窗口 | ❌ | — |
| **P2-3** | 评估 `model_providers` 自定义 provider（让 Codex 走别的模型） | ⭐⭐⭐ 潜在的大收益，但成本未知 | 未知 | ❌ 需先决策 | `~/.codex/config.toml`（**不是**本仓库） |
| **P2-4** | （可选）reset credit 一键恢复（`account/rateLimitResetCredit/consume`） | ⭐⭐⭐ 比接管更省事；但不可逆 | ~1h | ✅ 但**需用户显式确认** | 新增工具 |

### 「今天就能做完」的 4 件（P0-1 ~ P0-3 + P1-2 + P1-4）

合起来约 **5 小时**，且能同时交付用户的两个目标：
- P0-1 交付**目标 (1) 的完整闭环**（问方向 → 原文回灌），已被实测证明可行；
- P0-2/P0-3/P1-2 交付**目标 (2) 的"看得见、喊得出、不乱写"部分**；
- 剩下的"导出上下文包 + DSH 接手"（P1-3）是目标 (2) 的下一半，但它依赖一个**产品决策**（见 §6）。

---

## 6. 未验证清单与需要用户决策的点

**未验证（我没能实测，别当成已确认）**
1. `turn/interrupt` 对**桌面 App 拥有的** turn 是否会被所有权/写锁拒绝 —— 只验证了方法存在与参数形状。
2. 额度真正耗尽后 `thread/queue/add` 是否仍被消费、App 行为如何。
3. `thread/inject_items` 的 `items` 具体应传什么形状（schema 只说 "Raw Responses API items"，`UserInput` 联合类型与 Responses API item 不完全同构）。
4. 自定义 `model_providers` + `modelProvider` 覆盖是否能真的把 Codex 的模型调用路由到非 OpenAI 端点。
5. `thread/start` 的 `sandbox`/`permissions`/`serviceTier` 在**非临时**线程上的实际缺省与副作用（我只观察到 `/tmp` + `approvalPolicy:"never"` 下缺省变成 `{type:"readOnly",networkAccess:false}`）。
6. 用 `serviceTier: "priority"` 会如何影响额度消耗速率（目录说 "increased usage"，但没给倍数）。

**需要用户决策**
1. **"最强模型"是谁？** 协议不排序。建议默认 `gpt-6-astra` + `effort:"max"`，但这是**操作者的判断**，请确认或给一张偏好表。
2. **快速聊天要不要 `ephemeral`？** 代价：不能用 `thread/turns/list` 读回（只能靠抓通知）。收益：不污染 Codex 侧栏。建议：默认 ephemeral，把"抓不到回复"当失败返回而不是静默。
3. **额度到顶时默认动作是什么？** 三选一（或组合）：(a) 只告警；(b) 中断正在跑的 turn + 导出上下文包给 DSH；(c) 花一张 reset credit 立刻恢复。建议默认 (a)+(b)，(c) 永远需要显式确认。
4. **"原文照搬"是否允许加出处标注？** 严格原样 = 不加。建议：`reply` 一律原样，出处信息只放在工具的返回值里（不进 Codex）。

---

## 附录 A：本机实测方法清单（从 app-server 的错误 dump 提取，权威）

写读：
`initialize`, `server/diagnostics`, `userVerification/{status,enroll,delete,verify,cancel}`,
`thread/{start,resume,fork,archive,delete,unsubscribe,increment_elicitation,decrement_elicitation,name/set,goal/set,goal/get,goal/clear,unarchive,compact/start,shellCommand,approveGuardianDeniedAction,revert,list,read,turns/list,items/list,inject_items,search,searchOccurrences,loaded/list,timeline/list,backgroundTerminals/{clean,list,terminate},settings/update,metadata/update,memoryMode/set,attachment/{add,list,remove},section/move}`,
`thread/queue/{add,list,update,delete,reorder,start}`,
`project/{list,read,create,import,update,move,delete}`, `threadSection/{list,create,update,delete}`,
`skills/{list,config/write}`, `skills/extraRoots/set`, `hooks/list`,
`marketplace/{add,remove,upgrade}`, `plugin/{list,search,installed,reconcile,read,install,uninstall,skill/read,share/{save,updateTargets,list,checkout,delete}}`,
`app/{read,list,installed}`,
`fs/{readFile,writeFile,createDirectory,getMetadata,readDirectory,remove,copy,watch,unwatch}`,
`turn/{start,settings/update,steer,interrupt}`, `review/start`,
`thread/realtime/{start,appendAudio,appendText,appendSpeech,stop,listVoices}`,
`model/list`, `modelProvider/capabilities/read`, `experimentalFeature/{list,enablement/set}`,
`permissionProfile/list`, `collaborationMode/list`, `mock/experimentalMethod`,
`remoteControl/{enable,disable,status/read,pairing/start,pairing/status,client/list,client/revoke}`,
`environment/{add,info,status}`,
`mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServerStatus/list`, `mcpServer/resource/read`,
`mcpServer/event/stream/{start,stop}`, `mcpServer/tool/call`,
`windowsSandbox/{setupStart,readiness}`,
`account/{login/start,login/cancel,logout,read,bedrock/discover,bedrock/setup,rateLimits/read,rateLimitResetCredit/consume,usage/read,workspaceMessages/read,sendAddCreditsNudgeEmail}`,
`feedback/upload`, `command/{exec,exec/write,exec/terminate,exec/resize}`,
`process/{spawn,writeStdin,kill,resizePty}`, `config/{read,value/write,batchWrite,requirements/read}`,
`externalAgentConfig/{detect,import,import/recordHistory,import/readHistories}`,
`getConversationSummary`, `gitDiffToRemote`, `getAuthStatus`,
`fuzzyFileSearch`, `fuzzyFileSearch/session{Start,Update,Stop}`

> 注意：这里面**没有** `account/tokenUsage/read`（那是 `GetAccountTokenUsageResponse.json` 文件名造成的错觉，真名是 `account/usage/read`）；也**没有**任何 session/agent 转移类方法。

## 附录 B：复现命令

```bash
# 1) 权威 schema（把协议变成可 grep 的文件，而不是猜）
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema \
  --experimental --out /tmp/cxs/json          # 5.3 MB, 47 files + v1/ + v2/
ls /tmp/cxs/json/v2 | grep -i 'TurnStart\|RateLimit\|ModelList'

# 2) 活体探针（私有子进程，不动桌面 App）
node /tmp/cxprobe/probe1.mjs   # 额度 / 账号 / 模型目录 / 25s 静默监听
node /tmp/cxprobe/probe2.mjs   # 能力 A 端到端：ephemeral + 模型覆盖 + 原文回灌
node /tmp/cxprobe/probe3.mjs   # provider 能力 / config.read / collaborationMode
node /tmp/cxprobe/probe4.mjs   # model_providers 实际内容

# 3) 方法清单（故意用错方法名，读 app-server 回错里的合法枚举）
#    见 probe1.out 的 "===== account tokenUsage (best-effort) =====" 段
```

## 7. Verification (live, 2026-10-13)

Every claim the new code rests on was measured against the running Codex app-server
before it was written into the plugin, and the tools were then run live:

- **`codex_budget`** — `level: ok`, line
  `quota: ok · 25% of 300min · 20% weekly · 2 reset credits`, with
  `ordinaryUsageAllowed: "true"` and both bucket `resetsAt` values. The bucket that
  had reached 100% in an earlier read of a different account was reported as a
  *level*, which is the point: only the server's own flags produce `reached`.
- **`codex_ask`** — a throwaway thread, `gpt-6-astra` at `effort: max`, answered in
  18.9s from `notification:item/completed`, with `overrideHonoured: true` (the
  model Codex reported back was the model asked for). A failing run with
  `effort: minimal` produced the provider's own words —
  `Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model.
  Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.` — which are
  now quoted in the tool's `reason` and `detail` instead of being retried silently.
- **Ephemeral threads** — both read paths refuse: `thread/items/list is not supported
  yet`, `ephemeral threads do not support thread/turns/list`. The answer can only
  come from the notification stream there, so that is what the tool waits on, with
  the turn poll kept for non-ephemeral threads.
- **`codex_handoff`** — built live from a real goal-driven thread: 3511 characters,
  all six sections, the goal quoted verbatim, the instruction quoted verbatim, the
  two files it had touched, the item-type rollup (commandExecution 13, reasoning 22,
  agentMessage 4, fileChange 1) across the newest 5 turns, and the quota at handoff.
- **The board** — `npm test` 160/160, `node scripts/smoke.mjs` green against the live
  app-server including the three new reads (`thread/turns/list`, `thread/goal/get`,
  `thread/read`), with every card landing in exactly one state column and the quota
  verdict present in the snapshot.

Still unverified, and stated as such in the README: the panel's **pixels** (its
spacing, colours and the sidebar row as the shell draws them) need a human eye on a
real window; the tests render the tree, not the CSS.
