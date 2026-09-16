# agent-relay 接力棒

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
| `relay board add <text>` | 任务板加待办 |
| `relay board done <关键词>` | 匹配的任务移到已完成 |
| `relay brief [--tail N]` | 输出可粘贴的上下文简报 |
| `relay paste` | 纯聊天客户端粘贴模板 |
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

## 新手常见坑 → 接力棒怎么防

| 坑 | 防法 |
|---|---|
| 会话爆了重开，前功尽弃 | 关键节点 `relay note`，重开先 `relay brief` |
| 多客户端各说各话、互相覆盖 | 协议规定只追加/移动，署名追责 |
| 给 Agent 塞太多上下文 | brief 只输出任务板 + 最近 N 条记录，默认 15 |
| 分歧没人裁决，模型自作主张 | decisions.md「待裁决」区，用户拍板 |

## 调研来源（痛点出处）

- [为什么你的 AI 编程助手会突然变傻？7 个坑一次讲透](https://m.toutiao.com/article/7670716914649350708/)
- [新手开发 AI Agent，全都踩过的 8 个致命大坑](https://www.toutiao.com/a7669692472716706327/)
- [为什么你的 AI 编程总卡在半路](https://post.smzdm.com/p/a95d5w85/)
- [Agent 的记忆：从无状态模型到持久心智](https://justin3go.com/posts/2026/06/04/agent-memory-architecture-guide)
- [什么是 Agent 的上下文窗口](https://www.qiqicto.com/infor/7817.html)

## 许可

MIT
