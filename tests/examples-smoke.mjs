#!/usr/bin/env node
// examples/ 工具功能冒烟测试（独立可执行）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractReceipt } from '../examples/dispatch-openclaw.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // tests/smoke.mjs → tests/ → 仓库根

const run = (argv, env) =>
  spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

let passed = 0;
const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

// (1) auto-multi --help → 退出码 0
{
  const r = run(['examples/auto-multi.mjs', '--help']);
  if (r.status !== 0) fail(`auto-multi --help 应退出 0，实际 ${r.status}`);
  passed++;
}

// (2) auto-multi 无参数 → 退出码 2
{
  const r = run(['examples/auto-multi.mjs']);
  if (r.status !== 2) fail(`auto-multi 无参数应退出 2，实际 ${r.status}`);
  passed++;
}

// (3) auto-multi --models a/b（缺 --dispatch） → 退出码 2
{
  const r = run(['examples/auto-multi.mjs', '--models', 'a/b']);
  if (r.status !== 2) fail(`auto-multi --models a/b（缺 --dispatch）应退出 2，实际 ${r.status}`);
  passed++;
}

// (4) dispatch-echo.mjs → 写合法回执文件
{
  const tmpFile = path.join(os.tmpdir(), 'relay-echo-smoke-' + Date.now() + '.json');
  const r = run(['examples/dispatch-echo.mjs', 'examples/dispatch-echo.mjs'], {
    RELAY_RECEIPT_OUT: tmpFile,
  });

  if (!fs.existsSync(tmpFile)) fail(`dispatch-echo.mjs 未写出回执文件: ${tmpFile}`);
  if (r.status !== 0) fail(`dispatch-echo.mjs 应退出 0，实际 ${r.status}`);

  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  } catch {
    fail('回执文件无法 JSON.parse');
  }

  if (!rec.tool_call_count || rec.tool_call_count <= 0)
    fail(`tool_call_count 应 > 0，实际 ${rec.tool_call_count}`);
  if (!rec.changes || !rec.changes[0] || !rec.changes[0].path || rec.changes[0].path.trim() === '')
    fail(`changes[0].path 应为非空字符串，实际 ${JSON.stringify(rec.changes[0]?.path)}`);

  fs.unlinkSync(tmpFile);
  passed++;
}

// (5) extractReceipt：正文自带示例 json 块时仍应取到真回执，而非第一个围栏
{
  const real = JSON.stringify({ task_id: 't', client: 'c', model: 'm', transport: 'mcp', tool_call_count: 3, files_read: [], changes: [{ path: 'a.md', content: 'x' }] });
  const decoy = JSON.stringify({ example: 'not a receipt', models: ['ollama/qwen2.5:7b'] });

  const withDecoyFirst = '说明如下：\n```json\n' + decoy + '\n```\n回执：\n```json\n' + real + '\n```\n';
  const got = extractReceipt(withDecoyFirst);
  if (!got || JSON.parse(got).tool_call_count !== 3)
    fail('extractReceipt 应跳过示例 json 块、取到真回执');
  passed++;

  if (extractReceipt('只有示例：\n```json\n' + decoy + '\n```\n') !== null)
    fail('extractReceipt 对无合格回执的文本应返回 null');
  passed++;

  const loose = extractReceipt('无围栏回执 ' + real + ' 结束');
  if (!loose || JSON.parse(loose).tool_call_count !== 3)
    fail('extractReceipt 应支持无围栏的松散回执');
  passed++;
}

console.log('all ' + passed + ' checks passed');
process.exit(0);
