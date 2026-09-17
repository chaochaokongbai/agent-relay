#!/usr/bin/env node
// 本地模型回执能力预检：不经过 OpenClaw/relay，直接问 Ollama 的 OpenAI 兼容接口，
// 看模型能否按回执协议产出一个合格回执（用 dispatch-openclaw 的 extractReceipt 判定）。
// 用法：node examples/probe-local.mjs [provider 模型 id]   默认 qwen2.5-coder:7b
//       OLLAMA_BASE_URL 可覆盖，默认 http://127.0.0.1:11434/v1
import { extractReceipt } from './dispatch-openclaw.mjs';

const model = process.argv[2] || 'qwen2.5-coder:7b';
const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';

const prompt = [
  '你是多模型接力系统的回执生成器。请只输出一个用 ```json 围栏包裹的回执对象，不要输出任何其他文字。',
  '回执字段：task_id("probe"), client("Ollama"), model("' + model + '"), transport("mcp"),',
  'tool_call_count(大于 0 的整数), files_read(字符串数组), changes(数组，至少一条 {path, content}，content 为任意非空字符串)。',
].join('\n');

const r = await fetch(base + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  }),
});

if (!r.ok) {
  console.error('probe-local: HTTP ' + r.status + ' ' + (await r.text()));
  process.exit(1);
}

const j = await r.json();
const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
console.log('--- 模型原始输出 ---');
console.log(text);
const got = extractReceipt(text);
console.log('--- 判定 ---');
if (got) {
  console.log('PASS：' + model + ' 能产出合格回执，可考虑接入 relay profile');
  process.exit(0);
} else {
  console.log('FAIL：' + model + ' 未产出合格回执，本地落点不可行');
  process.exit(1);
}
