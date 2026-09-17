# 接力协议（所有 AI 客户端必读）

本项目使用 agent-relay（接力棒）维护跨会话/跨客户端的工作记录。
你是被派来干活的模型之一。开始任何工作前：

1. 读 `.relay/board.md`，了解任务状态和别人的进展
2. 认领任务：把条目从「待办」移到「进行中」（`relay board` 或手动编辑），署名 `[客户端/模型]`
3. 干活过程中，关键节点用 `relay note 做了什么/发现了什么` 留痕
4. 完工后：`relay board done <关键词>`，并在 `.relay/handoff.md` 末尾补一条交接备注：
   做了什么 / 踩了什么坑 / 下一步建议
5. 规则：
   - 不删除、不改写别人的条目；只追加或移动
   - 每条记录带署名和日期，便于追责
   - 意见分歧写进 `.relay/decisions.md`「待裁决」，交给用户，不要互相覆盖
   - 跨会话需要的事实（偏好、约定、环境信息）写进共享记忆 MCP（若已接入），不要只留在自己的会话里

## 写回回执（可验证，别只回「干完了」）

口头声称干了活不算数——本项目用 `relay verify` 把"信任"换成"验证"。被派来干活的模型，完工时除了移板/留痕，还应产出一份**回执 JSON**（写到 `.relay/` 或共享记忆里），格式：

```json
{
  "task_id": "relay-task-N-...",
  "client": "OpenClaw",
  "model": "MiniMax-M2.7",
  "transport": "mcp",
  "tool_call_count": 7,
  "files_read": ["bin/relay.mjs"],
  "changes": [
    { "path": "bin/relay.mjs", "content": "……修改后的完整文件内容……" }
  ]
}
```

- `transport`：`mcp`（能自己调工具）或 `paste`（豆包/ChatGPT 这类人肉传话、无工具能力）
- `tool_call_count`：本次真实发起的工具调用次数
- `changes`：你产出的文件改动，每条是 `{path, content}`，`content` 为修改后的完整文件内容

然后任何人（或编排器）跑：

```bash
relay verify <receipt.json>          # 默认对项目根、用 npm test
relay verify <receipt.json> --test "npm test"   # 覆盖测试命令
```

`relay verify` 会做三件事，全过才 PASS（退出码 0），否则 FAIL（退出码 1）并在 `handoff.md` 留一条带署名的验证记录：

1. **存活检查**：非 `paste` 回执必须 `tool_call_count > 0`——挡掉只回「OK」却零工具调用的空跑/静默失败
2. **应用产物**：把 `changes` 写进项目的一个**临时副本**（拒绝 `..` 越界路径），不碰你的工作树
3. **跑测试**：在副本里执行测试命令（默认 `npm test`，可用 `relay.json` 的 `verify.test` 或 `--test` 覆盖）

要点：**信代码不信嘴**——产物必须能让测试变绿才算数，而不是"我改好了"。

## 新会话开场白（复制即用）

> 读 `.relay/PROTOCOL.md` 并按协议工作。当前简报：
> （粘贴 `relay brief` 的输出）
