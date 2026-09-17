#!/usr/bin/env node
// 示例派发器（无需真模型）：用来本地试跑 relay auto 的闭环。
// 它不调用任何 LLM，只是读任务、产出一份「制造一个新文件」的回执，便于观察
// auto → verify → 应用 → 移板 的完整流程。真接入请改用 dispatch-openclaw.mjs。
//   relay auto --dispatch "node examples/dispatch-echo.mjs" --test "node -e \"process.exit(0)\""
import fs from 'node:fs';

const promptFile = process.argv[2];
const out = process.env.RELAY_RECEIPT_OUT;
const task = process.env.RELAY_TASK_TEXT || '(未知任务)';
const prompt = fs.readFileSync(promptFile, 'utf8');

const receipt = {
  task_id: process.env.RELAY_TASK_ID || 'echo',
  client: 'EchoDispatcher',
  model: 'none',
  transport: 'mcp',
  tool_call_count: 1,
  files_read: [promptFile],
  changes: [
    { path: 'AUTO-NOTE.md', content: `# relay auto 试跑\n\n任务：${task}\n\n提示词长度：${prompt.length} 字符。\n` },
  ],
};

const json = JSON.stringify(receipt, null, 2);
if (out) fs.writeFileSync(out, json);
else process.stdout.write(json);
