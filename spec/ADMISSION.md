# agent-relay 准入协议（ADMISSION）· v1

> **一句话**：任何模型都能交产物，但只有过了门、留了证据的才准落地——给 AI agent 的 branch protection。
>
> **边界**：本协议**不做编排**。不调度模型、不管并发、不做 UI、不存向量记忆。它只回答一个问题：
> **「这一份产物，允不允许进项目工作树？」** 编排器（batty / vibe-kanban / 自建 CI）可以随便换，裁判不必换。

## 0. 三条设计原则

1. **零依赖、纯文本、可进 git**：裁决与证据都是项目里的一行行文本（`.relay/evidence.jsonl`），`git log` 就能追溯，不依赖任何服务端。
2. **客户端无关**：协议里没有厂商、框架、语言字段。谁产出的产物都走同一道门，所以它可以当**跨模型协作的中立裁判**。
3. **裁决可复验，而不是「信我说的」**：门输出结构化裁决 + 哈希（回执、每条变更、测试输出）+ 哈希链，第三方可以自己复算。

## 1. 能力分级（tiers）——本协议的特点之一

传统门禁只会「一刀切拒绝」没有文件工具/没有工具调用的产出方，等于把纯聊天客户端（豆包这类）排除在协作之外。
本协议用**能力分级**把它们合法纳进来：

| 级别 | 判定依据 | 存活检查 | 说明 |
|---|---|---|---|
| **L0** | `transport: "paste"` | **豁免** `tool_call_count` | 人工粘贴通道，产物只能靠人搬运；不假装它有工具 |
| **L1** | `capabilities: ["files", ...]` 或未声明 exec | 必须 `tool_call_count` 为正整数 | 有文件工具但不可声明可执行命令 |
| **L2** | `capabilities` 含 `"exec"` | 必须 `tool_call_count` 为正整数 | 能跑命令；门对它更该假定「它会写工作树」，故工作树守卫是必需的 |

> 分级**不降低**安全要求：无论哪级，产物都必须过敏感路径、破坏性写入、路径围栏、测试门。分级只决定「存活检查怎么判」和「审计里怎么标注」。

## 2. 回执（receipt）

见 [`receipt.schema.json`](./receipt.schema.json)。要点：
- `changes[].content` 必须是**完整文件内容**，不是 diff（round 9 的事故：模型只回新小节，apply 把 README 清空）。
- 非 paste 通道必须报 `tool_call_count`（正整数）；0 或缺失一律判空跑。
- 路径接受正/反斜杠，比较前统一归一化为正斜杠。

## 3. 裁决顺序与 checks 枚举

门按固定顺序裁决，**判定短路**（先失败先返回），已执行到的项才出现在 `checks[]`：

| # | check id | 严重度 | 判据 |
|---|---|---|---|
| 1 | `receipt-parse` | high | 回执文件能解析成 JSON |
| 2 | `liveness` | high | 非 paste：`tool_call_count` 为 >0 整数；paste：按 L0 豁免 |
| 3 | `changes-present` | high | `changes` 为非空数组 |
| 4 | `sensitive-path` | high / medium | 严格模式命中 `.github/** .relay/** tests/** package.json` → FAIL；manual 模式放行但留审计 |
| 5 | `destructive-write` | high | 代码文件：新内容 < 原文件 50% 字节；非代码文件：删除了原有非空行 |
| 6 | `path-containment` | high | 应用产物时路径不得逃出项目目录（`..`/绝对路径/跨盘） |
| 7 | `test-gate` | high | 产物应用于**临时副本**后，测试命令退出码为 0 |
| — | `receipt-present` | high | 仅 `auto`：派发命令没产出合法回执 JSON |

`severity` 语义：`high` = 失败即拒；`medium` = 放行但需人工注意（写审计）；`info` = 仅留痕的通过项。

## 4. 证据链与复验

每条裁决追加一行到 `.relay/evidence.jsonl`：

```
{"schemaVersion":1,"gate":{"name":"agent-relay/executeVerify","version":"1","policy":"auto-strict"},
 "verdict":"PASS","receipt":{"sha256":"..."},"changes":[{"path":"...","sha256":"..."}],
 "checks":[...],"evidence":{"testCmd":"npm test","exitCode":0,"outputSha256":"..."},
 "chain":{"prev":"genesis","self":"..."},"timestamp":"..."}
```

链的算法（任意语言可实现）：

```
prev   = 文件中最后一条记录的 chain.self（文件为空或坏行 → "genesis"）
self   = sha256( stable_json( verdict_without_self ) )   // 即 chain 只含 prev 时的整个对象
```

复验步骤（不需要 agent-relay）：
1. 逐行读 `evidence.jsonl`，重算每条 `self`，校验它与下一条的 `prev` 相连；
2. 用 `receipt.sha256` 对应的回执原文重算哈希，确认产物未被掉包；
3. 用 `changes[].sha256` 对比当前工作树文件，确认「落地的就是过门的那份」；
4. 重跑 `evidence.testCmd`，比对 `exitCode` 与 `outputSha256`。

> 这一步是从「记忆」升级到「信任」的关键：记忆可以被替换，**可复验的证据链不行**。

## 5. CLI 契约

```
relay verify <receipt.json> [--project <dir>] [--test <cmd>] [--no-record] [--json]
relay auto --dispatch <cmd> [--task <kw>] [--model <m>] [--test <cmd>] [--timeout <s>]
                           [--dry-run] [--allow-sensitive] [--json]
```

- `--json`：**不打印人话**，stdout 输出一份完整裁决 JSON；同时（除非 `--no-record`）追加一行到 `.relay/evidence.jsonl`。
- 退出码语义不变：0 = PASS，1 = FAIL。CI 里直接可用。
- 不给 `--json` 时，行为与 v0.1 完全一致（人类可读输出 + `handoff.md` 记录）。**只增不改。**

### 5.1 独立复验：`relay recheck`

```
relay recheck [evidence.jsonl] [--project <dir>] [--rerun] [--allow-drift] [--json]
```

默认读 `.relay/evidence.jsonl`，做三件事，**不需要信任 agent-relay 本身**：

1. **验链**：逐条重算 `chain.self`（稳定序列化 + SHA-256），并校验每条 `chain.prev` 与前一条 `self` 相连——改过任何一条都会报 `tamper` / `chain-break`；
2. **查漂移**：每个路径只与「最新一条提到它的裁决」里的 `changes[].sha256` 比对，确认**落地的就是过门的那份**（文件被改过 → 报漂移，`--allow-drift` 可只报告不判失败）；
3. **重跑**：`--rerun` 在当前工作树上重跑最后一条证据里的 `testCmd`，连同 `exitCode` / `outputSha256` 一起回报。

链断 / 被篡改 / 漂移 / 重跑失败 → 退出码 1；`--json` 输出结构化报告（`{ok, entries, problems[], drift[], rerun}`）供 CI 消费。

## 6. 门策略版本（`gate.version`）

- `gate.version` 是**策略版本**，不是包版本：裁决口径（阈值、检查集合、短路顺序）变了就 +1。
- 审计时能回答两个问题：这份产物是哪一版门放行的；换了新门之后，老产物要不要重审。

## 7. 非 Node 实现指引

要让别的语言/编排器也能实现同一道门，只需三件事：
1. **稳定序列化**：对象键按字典序排序、数组保持顺序、`undefined → null`、UTF-8 编码，然后哈希（本仓用 SHA-256）。JSON Schema 见本目录。
2. **文件布局**：项目根 `.relay/`（`board.md` / `handoff.md` / `decisions.md` / `relay.json` / `evidence.jsonl`）；证据只追加，不重写。
3. **临时副本**：产物必须先应用到**副本**再跑测试；原工作树只接受过门产物（`relay` 另配工作树守卫，见下）。

## 8. 已知边界（诚实清单）

- **防「老实但会出错」的模型，不防恶意**：模型可以自己改测试来骗过 `test-gate`（自证式验证）。缓解方向：门只允许非测试路径的改动进副本，或对 `tests/**` 强制人工。
- **非代码文件仍是弱项**：README/配置/CI 被「注释掉但不减字节」可以过 50% 阈值，测试门对它们也盲。
- **`test-gate` 的能力上限就是 `--test` 命令**：带依赖的项目在临时副本里可能跑不起来（`.git`/`node_modules` 被过滤）。
- **工作树守卫只覆盖 auto 派发窗口**：`relay verify` 单独跑不会碰工作树。

## 9. 路线图

1. **本协议 v1**（已完成）：receipt / verdict schema + `relay verify|auto --json` + 证据链。
2. **门抽成库**（已完成）：`agent-relay/gate`（`lib/gate.mjs`，零依赖、**无副作用**，可被任意编排器 / CI 嵌入）。
   CLI 与库共用同一份实现（`bin/relay.mjs` 从 `lib/gate.mjs` 导入），不会再出现「两套门」。

   ```js
   import { executeVerify, buildVerdict, snapshotTree, restoreTree, recheckEvidence } from 'agent-relay/gate';
   ```

3. **独立复验器**（已完成）：`relay recheck`——重算哈希链、比对工作树漂移、`--rerun` 重跑证据里的测试命令。
4. **下一步**：把 `recheck` 做成 GitHub Action（每次 agent 产物提交时自动验链 + 重跑证据），
   以及 `gate.version` 升级时的「老产物重审」流程。
