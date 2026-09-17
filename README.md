# agent-relay 接力棒
[![Test](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml/badge.svg)](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml)

> 换个会话、换个客户端，AI 就失忆？给它一根接力棒。

**痛点**（社区高频抱怨，见文末调研来源）：
- 会话一关/上下文一爆，Agent 忘了之前所有约定，任务卡在半路重头再来
- 同一个项目在 DSH、Qoder、WorkBuddy、OpenClaw、豆包之间来回切换，每个客户端都是从零开始
- 新手不知道"该给 Agent 留什么"，于是要么全留（上下文爆炸）要么全不留（失忆）

**接力棒的解法**：把"该留什么"固化成三个小文件 + 一个零依赖 CLI：
- `.relay/board.md` 任务板（待办/进行中/已完成）
- `.relay/handoff.md` 交接记录（带时间戳和署名的一条条笔记）
- `.relay/decisions.md` 决策与分歧（交给用户裁决的地方）

任何新会话/新客户端，粘贴 `relay brief` 的输出就能**续上**，而不是重头开始。

## 五分钟上手

```bash
git clone https://github.com/chaochaokongbai/agent-relay.git
cd agent-relay && npm link        # 注册 relay 命令；不想 link 就用 node bin/relay.mjs

cd 你的项目
relay init                        # 创建 .relay/
relay board add "实现登录页"
relay note "调研完毕：用 sessionStorage 存临时态"
relay brief                       # 输出简报 → 粘进下一个会话/另一个客户端
```

把这句话发给任何 Agent 客户端（DSH / Qoder / WorkBuddy / OpenClaw）：

> 读 `.relay/PROTOCOL.md` 并按协议工作。当前简报：（粘贴 relay brief 输出）

纯聊天客户端（豆包等）没有文件能力？

```bash
relay paste    # 生成整段粘贴模板，贴进对话即可，模型按固定格式回交接备注
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `relay init [dir]` | 创建 `.relay/` 工作记录 |
| `relay note <text> [--who 名字]` | 追加交接记录（`RELAY_WHO` 环境变量可设默认署名） |
| `relay decision <text...>` | 追加一条带时间戳的决策记录（`--who` 署名） |
| `relay board add <text...>` | 任务板「待办」加一条 |
| `relay board done <关键词>` | 匹配的任务移到已完成（精确优先；多条命中报错） |
| `relay board done --index <n>` | 按待办顺序（1 基）精确完成第 n 条 |
| `relay brief [--tail N]` | 输出可粘贴的上下文简报 |
| `relay paste` | 纯聊天客户端粘贴模板 |
| `relay verify <receipt.json>` | 验证写回回执：存活检查 + 把产物应用到临时副本 + 跑测试，过/不过给退出码 |
| `relay auto --dispatch <cmd>` | 无人值守闭环：取待办→派发给 headless 模型→收回执→verify→通过才应用并移板 |
| `relay connect --client <name>` | 输出该客户端接入共享记忆 MCP 的配置 |

## 进阶：多客户端共享记忆（可选）

任务板/交接文件解决"续上"；共享记忆 MCP 解决"长期事实"（偏好、约定、环境）。
`relay connect --client qoder|workbuddy|openclaw|dsh|doubao` 会输出对应客户端的配置，
全部指向同一个 `memory.jsonl` —— 五个客户端、任意不同模型，读写同一份记忆图谱。

```
        ┌────────────┐   文件层(.relay/)   ┌────────────┐
        │    DSH     │◄──────────────────►│   Qoder    │
        └────────────┘                    └────────────┘
        ┌────────────┐   记忆层(MCP)      ┌────────────┐
        │ WorkBuddy  │◄──────────────────►│  OpenClaw  │
        └────────────┘                    └────────────┘
                    ┌──────────────────────────┐
                    │ 豆包（粘贴 relay paste） │
                    └──────────────────────────┘
```

## 本地模型落点（离线兜底）

`examples/auto-multi.mjs` 的 `--models` 列表支持把本地 Ollama 模型放在第一位、云端模型作兜底。例如：

```bash
node examples/auto-multi.mjs \
  --models "ollama/qwen2.5:7b,minimax/MiniMax-M2.7" \
  --dispatch "node examples/dispatch-openclaw.mjs"
```

`relay profile` 已内置 `ollama` provider，指向 `127.0.0.1:11434`。本地模型无需网络、不消耗云端配额，离线可用；云端模型作为兜底，认证恢复后自动接管。

**容灾与认证坑**：若某 provider 认证失效（如 MiniMax 报 `No API key`），验证门会拒绝该模型的回执，`auto-multi` 自动回退到列表下一个模型继续尝试。用户可用以下命令重认证：

```bash
openclaw --profile relay models auth paste-api-key --provider <name>
```

重认证完成后，下一轮 `auto-multi` 即可恢复正常。

### 预检

正式接入本地模型前，先用 probe 脚本验证该模型能否产出合格回执：

```bash
# 默认 model=qwen2.5-coder:7b，OLLAMA_BASE_URL 可覆盖
node examples/probe-local.mjs <model>
```

它不经过 OpenClaw，直接向 Ollama 的 OpenAI 兼容接口发一个最小任务，
用 `extractReceipt` 判定响应是否包含 `changes` 数组和非零 `tool_call_count`。

- **PASS** → 该模型能产出合格回执，建议接入 `relay profile` 跑 `relay auto`
- **FAIL** → 该本地模型不适合工具调用轮，不必浪费下载与显存

## 进阶：无人值守 + 写回可验证

多模型协作最大的风险是「模型嘴上说干完了，其实空跑」。`relay verify` + `relay auto` 把"信任"换成"验证"。

**`relay verify <receipt.json>`** —— 验证门，做三件事，全过才 PASS（退出码 0）：

1. **存活检查**：非 `paste` 回执必须 `tool_call_count > 0`，挡掉只回「OK」却零工具调用的静默失败
2. **应用产物**：把回执 `changes` 写进项目的**临时副本**（拒绝 `..` 越界），不碰工作树
3. **跑测试**：副本里执行测试命令（默认 `npm test`），绿了才算数

回执 JSON 契约见 `.relay/PROTOCOL.md`。核心字段：`tool_call_count`、`transport`（`mcp`/`paste`）、`changes:[{path,content}]`。

**`relay auto --dispatch <cmd>`** —— 在验证门之上串成无人值守闭环：

```
取一条待办 → 移「进行中」→ 渲染任务提示词 → 调用 <cmd>（headless 模型）
   → 收回执 JSON → relay verify → PASS 才应用到工作树 + 移「已完成」
                                  → FAIL 则不应用 + 退回「待办」 + 记录原因
```

派发器契约：`relay auto` 把任务提示词文件路径作为 argv 传给 `<cmd>`，并注入 `RELAY_RECEIPT_OUT`（回执写这里）、`RELAY_TASK_ID`、`RELAY_MODEL`、`RELAY_TIMEOUT`；`<cmd>` 产出回执 JSON 即可。

```bash
# 接真模型（OpenClaw headless，示例派发器已处理 --thinking off / 回执抽取）
relay auto --dispatch "node examples/dispatch-openclaw.mjs" --model minimax/MiniMax-M2.7

# 不接模型，先空跑看闭环（产出一个 AUTO-NOTE.md）
relay auto --dispatch "node examples/dispatch-echo.mjs" --test "node -e \"process.exit(0)\""
```

要点：**只有 verify 跑通测试，auto 才会动你的工作树**；任何失败都原样退回待办并留痕，不会把半成品糊上去。

## 新手常见坑 → 接力棒怎么防

| 坑 | 防法 |
|---|---|
| 会话爆了重开，前功尽弃 | 关键节点 `relay note`，重开先 `relay brief` |
| 多客户端各说各话、互相覆盖 | 协议规定只追加/移动，署名追责 |
| 给 Agent 塞太多上下文 | brief 只输出任务板 + 最近 N 条记录，默认 15 |
| 分歧没人裁决，模型自作主张 | decisions.md「待裁决」区，用户拍板 |
| 模型嘴上「干完了」其实空跑 | `relay verify` 信代码不信嘴：产物应用后跑测试，绿了才算 PASS |

## 进阶：准入裁决（给 AI agent 的 branch protection）

别的工具管「谁干什么」，接力棒管**「这份产物允不允许进工作树」**——编排器可以换，裁判不必换。

```bash
relay verify receipt.json --test "npm test" --json    # 输出可复验的准入裁决，并入 .relay/evidence.jsonl
relay auto --dispatch <cmd> --json                    # 无人值守闭环，同样产出裁决
```

裁决不是一句「过了」，而是一份第三方能自己复算的证据：

```
gate{name,version,policy} + verdict + receipt.sha256 + changes[].sha256
  + checks[]  liveness / sensitive-path / destructive-write / path-containment / test-gate
  + evidence{testCmd, exitCode, outputSha256, durationMs}
  + chain{prev, self}   哈希链：改任何一条历史记录都会断链
```

两个特点（见 [`spec/ADMISSION.md`](spec/ADMISSION.md)）：

- **能力分级**：`L0` 纯聊天客户端（粘贴通道，豁免工具调用计数）/ `L1` 有文件工具 / `L2` 可执行命令。
  没有文件能力的客户端也能合法参与协作，而不是被一刀切拒绝。
- **可复验**：回执、每条变更、测试输出全部有哈希；`evidence.jsonl` 首尾相连。不信任接力棒的人，
  也能自己验链、验哈希、重跑证据（spec 第 4 节给了复验步骤）。

> 门防的是「老实但会出错的模型」，不防恶意；已知边界诚实列在 spec 第 8 节。

**不信任接力棒也能验**——配了独立复验器：

```bash
relay recheck --rerun --json    # 重算哈希链 + 比对工作树漂移 + 重跑证据里的测试命令
```

**门同时是零依赖库**，编排器可以直接嵌（不做编排器，做编排器都要装的裁判）：

```js
import { executeVerify, buildVerdict, snapshotTree, recheckEvidence } from 'agent-relay/gate';
```

CLI 与库共用同一份实现（`bin/relay.mjs` 从 `lib/gate.mjs` 导入），不会有「两套门」。

## 调研来源（痛点出处）

- [为什么你的 AI 编程助手会突然变傻？7 个坑一次讲透](https://m.toutiao.com/article/7670716914649350708/)
- [新手开发 AI Agent，全都踩过的 8 个致命大坑](https://www.toutiao.com/a7669692472716706327/)
- [为什么你的 AI 编程总卡在半路](https://post.smzdm.com/p/a95d5w85/)
- [Agent 的记忆：从无状态模型到持久心智](https://justin3go.com/posts/2026/06/04/agent-memory-architecture-guide)
- [什么是 Agent 的上下文窗口](https://www.qiqicto.com/infor/7817.html)

## 许可

MIT
