# 交接记录示例（examples/handoff-sample.md）

一个真实的交接长什么样 —— 好记性不如烂笔头：

```markdown
- [2026-09-16 14:20] [Qoder/claude] 调研完成：新手最高频痛点是跨会话上下文丢失（见 decisions.md 第 1 条）
- [2026-09-16 14:35] [Qoder/claude] 踩坑：openclaw mcp set 的 JSON 参数里 Windows 反斜杠会被 shell 吞一层，改用正斜杠路径解决
- [2026-09-16 14:50] [DSH/deepseek] 接手审查：CLI 的 board done 用关键词匹配，重名任务会移错第一条 —— 建议后续加 --id
- [2026-09-16 15:02] [豆包/doubao]（用户抄回）建议 README 增加"五分钟上手"视频脚本大纲，已写在 decisions.md 待裁决
```

要点：
- 一条记录只说一件事
- 「踩坑」类比「做了什么」更值钱 —— 下一个模型能直接绕开
- 聊天端客户端的输出由用户抄回，注明来源即可
