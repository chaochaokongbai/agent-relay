#!/usr/bin/env node
// 模型容灾编排器：依次用多个模型跑 relay auto，第一个 PASS 就停止；全 FAIL 则退出 1。
// 用法：
//   node examples/auto-multi.mjs --models "minimax/MiniMax-M2.7,deepseek/deepseek-v4" --dispatch "node examples/dispatch-openclaw.mjs"
//   node examples/auto-multi.mjs --models "a/b,c/d" --dispatch "..." --task "关键词" --test "npm test"
//   node examples/auto-multi.mjs --help
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_BIN = path.join(__dirname, '..', 'bin', 'relay.mjs');

const USAGE = `auto-multi — 模型容灾编排器：依次尝试多个模型跑 relay auto

用法:
  auto-multi --models "p/m1,p/m2,..." --dispatch <cmd> [--task <关键词>] [--test <cmd>]
  auto-multi --help | -h

选项:
  --models <列表>   逗号分隔的 provider/model 列表（必需）
  --dispatch <cmd>   relay auto 的派发命令（必需）
  --task <关键词>    可选，原样透传给每次 relay auto
  --test <cmd>      可选，原样透传给每次 relay auto
  --help, -h        打印本帮助（在校验必选参数之前处理）

退出码:
  0   至少一个模型通过验证门
  1   所有模型都失败
  2   缺少必选参数
`;

const args = process.argv.slice(2);

// --help / -h 先处理（不校验必选参数）
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

// 解析选项
let modelsOpt = null;
let dispatch = null;
let task = null;
let testCmd = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--models' && i + 1 < args.length) {
    modelsOpt = args[++i];
  } else if (a === '--dispatch' && i + 1 < args.length) {
    dispatch = args[++i];
  } else if (a === '--task' && i + 1 < args.length) {
    task = args[++i];
  } else if (a === '--test' && i + 1 < args.length) {
    testCmd = args[++i];
  }
}

if (!modelsOpt || !dispatch) {
  console.error('auto-multi: 缺少必选参数：--models 和 --dispatch 均必需');
  console.error(USAGE);
  process.exit(2);
}

const models = modelsOpt.split(',').map((m) => m.trim()).filter(Boolean);
if (models.length === 0) {
  console.error('auto-multi: --models 列表为空');
  process.exit(2);
}

for (const model of models) {
  const relayArgs = [
    'auto',
    '--dispatch', dispatch,
    '--model', model,
  ];
  if (task)    { relayArgs.push('--task', task); }
  if (testCmd) { relayArgs.push('--test', testCmd); }

  console.error(`\n[auto-multi] 尝试模型: ${model}`);

  // 不用 shell：process.execPath 可能含空格（如 D:\Program Files\nodejs\node.exe），
  // shell:true 在 Windows 下不会给它加引号会被空格截断。argv 数组直传即可；
  // 真正需要 shell 的是最内层调 openclaw 的 .cmd shim，那由 relay auto 自己处理。
  const r = spawnSync(process.execPath, [RELAY_BIN, ...relayArgs], {
    stdio: 'inherit',
  });

  const code = r.status;
  if (code === 0) {
    console.error(`[auto-multi] ✓ 模型 ${model} 通过验证门，退出 0`);
    process.exit(0);
  } else {
    console.error(`[auto-multi] ✗ 模型 ${model} 失败（退出码 ${code}），尝试下一个...`);
  }
}

console.error('[auto-multi] 所有模型均失败，退出 1');
process.exit(1);
