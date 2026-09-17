#!/usr/bin/env node
// 示例派发器：把一个任务交给 OpenClaw（headless）跑，从模型回复里抽出回执 JSON，写到 RELAY_RECEIPT_OUT。
// 用法：
//   relay auto --dispatch "node examples/dispatch-openclaw.mjs" --model minimax/MiniMax-M2.7
// 约定（relay auto 会注入这些环境变量）：
//   argv[2]            任务提示词文件路径
//   RELAY_RECEIPT_OUT  回执 JSON 应写到这里（或直接把回执 JSON 打到 stdout）
//   RELAY_MODEL        目标模型（provider/model）
//   RELAY_TIMEOUT      超时秒数
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const promptFile = process.argv[2];
const out = process.env.RELAY_RECEIPT_OUT;
const model = process.env.RELAY_MODEL || 'minimax/MiniMax-M2.7';
const timeout = process.env.RELAY_TIMEOUT || '600';

// MiniMax-M2.7 必须 --thinking off 才会发起 tool call；隔离 profile 避开正在运行的 Gateway。
// shell:true 是 Windows 必需——openclaw 是 npm 的 .cmd shim，不加 shell 无法被 spawn 解析。
const r = spawnSync('openclaw', [
  '--profile', 'relay', 'agent', '--local',
  '--model', model, '--thinking', 'off',
  '--message-file', promptFile, '--json', '--timeout', timeout,
], { encoding: 'utf8', shell: true });

if (r.status !== 0) {
  const why = r.error ? r.error.message : '退出码 ' + r.status;
  console.error('dispatch-openclaw: openclaw 失败（' + why + '）\n' + (r.stderr || ''));
  process.exit(1);
}

// openclaw --json 是个信封：{payloads:[{text}], meta:{...}}；模型回执应在文本里以 ```json 围栏包裹。
let text = '';
try {
  const env = JSON.parse(r.stdout);
  if (Array.isArray(env.payloads)) text = env.payloads.map((p) => (p && p.text) || '').join('\n');
  else text = env.reply || env.message || env.text || '';
  if (!text) text = r.stdout;
} catch { text = r.stdout || ''; }

const fenced = String(text).match(/```json\s*([\s\S]*?)```/);
const loose = String(text).match(/\{[\s\S]*"changes"[\s\S]*\}/);
const json = fenced ? fenced[1] : (loose ? loose[0] : null);
if (!json) {
  console.error('dispatch-openclaw: 模型输出里找不到回执 JSON。原始回复：\n' + text);
  process.exit(2);
}

if (out) fs.writeFileSync(out, json);
else process.stdout.write(json);
console.error('dispatch-openclaw: 回执已交付' + (out ? ' → ' + out : '（stdout）'));
