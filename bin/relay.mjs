#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = '.relay';

// 敏感路径前缀（归一化为正斜杠，用 startsWith 匹配）
const SENSITIVE_PATTERNS = [
  '.github/',
  '.relay/',
  'tests/',
  'package.json',
];

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function isSensitivePath(p) {
  const np = normalizePath(p);
  return SENSITIVE_PATTERNS.some((pat) => np.startsWith(pat) || np === pat);
}

function isCodeFile(p) {
  const ext = path.extname(p).toLowerCase();
  return ['.mjs', '.js', '.cjs', '.ts'].includes(ext);
}

// 判定非代码文件是否有破坏性行删除（return reason string if destructive, null if ok）
function checkNonCodeDestructive(origContent, newContent) {
  const origLines = origContent.split('\n');
  const newLines = newContent.split('\n');
  // 归一化：trim 后的非空行集合
  const origSet = new Set(origLines.map((l) => l.trim()).filter((l) => l.length > 0));
  const newSet = new Set(newLines.map((l) => l.trim()).filter((l) => l.length > 0));
  let deleted = 0;
  for (const line of origSet) {
    if (!newSet.has(line)) deleted++;
  }
  if (deleted > 0) {
    return `非代码文件 ${deleted} 行原有内容被删除，如确需删改请人工执行`;
  }
  return null;
}

const HELP = `relay — 接力棒：给 AI Agent 会话一份持久工作记录

用法:
  relay init [dir]              在 dir（默认当前目录）创建 .relay/ 工作记录
  relay note <text...>          追加一条带时间戳的交接记录（--who 署名）
  relay decision <text...>      追加一条带时间戳的决策记录（--who 署名）
  relay board add <text...>     任务板「待办」加一条
  relay board done <keyword>    把含 keyword 的任务移到「已完成」
                                精确匹配优先；命中多条会列出候选并报错（不静默删第一条）
  relay board done --index <n>  按待办顺序（1 基）精确完成第 n 条
  relay brief [--tail N]        输出可粘贴进新会话/新客户端的上下文简报（默认 N=15）
  relay paste                   输出纯聊天客户端（豆包等）用的粘贴模板
  relay verify <receipt.json>   验证一份写回回执：存活检查 + 把产物应用到项目临时副本 + 跑测试
                                [--project <dir>] [--test <cmd>] [--no-record]
                                退出码 0=PASS，1=FAIL，并在 handoff.md 留一条带署名的验证记录
                                manual 模式允许改敏感路径但写审计日志
  relay auto --dispatch <cmd>   无人值守闭环：取一条待办 → 派发给 <cmd>（headless 模型）→ 收回执
                                → relay verify → 通过才应用到工作树并移入已完成，否则退回待办
                                [--task <关键词>] [--model <m>] [--test <cmd>] [--timeout <秒>] [--dry-run]
                                [--allow-sensitive]  本轮放行敏感路径（auto 默认严格，敏感路径：.github/** .relay/** tests/** package.json）
  relay connect --client <name> 输出该客户端接入共享记忆 MCP 的配置
                                name: qoder | workbuddy | openclaw | dsh | doubao
  relay help                    本帮助

验证门守卫说明：
  auto 模式（默认）          严格守卫：任何 changes 命中敏感路径（.github/** .relay/** tests/** package.json）直接 FAIL
  auto --allow-sensitive     本轮放行敏感路径，但写审计日志
  manual 模式（verify）      放宽：允许改敏感路径，写审计日志
  非代码文件                按行判破坏：已存在文件若删除了原有非空行 → FAIL（纯增量放行）
  代码文件（.mjs/.js/.cjs）   维持 50% 字节阈值
  工作树守卫                 auto 派发前对项目树快照、派发后无条件还原：agent 的直写与新增文件一律还原，
                             只有过门 changes 才落地（排除 .git/node_modules/.relay）

环境变量:
  RELAY_WHO    默认署名（如 "Qoder/claude"），等价于 --who
  RELAY_MODEL  relay auto 的默认模型（等价于 --model）
`;

function fail(msg) {
  console.error('relay: ' + msg);
  process.exit(1);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, RELAY_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function rootOrFail() {
  const root = findRoot(process.cwd());
  if (!root) fail('未找到 .relay/，先运行 relay init');
  return root;
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 16);
}

function who(args) {
  return flag(args, '--who') || process.env.RELAY_WHO || 'anonymous';
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const BOARD_SECTIONS = ['待办', '进行中', '已完成'];

function boardTemplate() {
  return `# 任务板\n\n${BOARD_SECTIONS.map((s) => `## ${s}\n`).join('\n')}`;
}

function cmdInit(dirArg) {
  const dir = path.resolve(dirArg || '.');
  const relay = path.join(dir, RELAY_DIR);
  if (fs.existsSync(relay)) fail(`${dir} 已存在 .relay/`);
  fs.mkdirSync(relay, { recursive: true });
  fs.writeFileSync(path.join(relay, 'relay.json'), JSON.stringify({ project: path.basename(dir), createdAt: stamp() }, null, 2) + '\n');
  fs.writeFileSync(path.join(relay, 'board.md'), boardTemplate());
  fs.writeFileSync(path.join(relay, 'handoff.md'), '# 交接记录\n\n');
  fs.writeFileSync(path.join(relay, 'decisions.md'), '# 决策记录\n\n');
  const proto = path.join(HERE, '..', 'templates', 'PROTOCOL.md');
  fs.copyFileSync(proto, path.join(relay, 'PROTOCOL.md'));
  console.log(`relay: 已在 ${dir} 初始化 .relay/`);
  console.log('relay: 下一步 —— 把这句话发给你的 Agent：');
  console.log(`       读 ${path.join(relay, 'PROTOCOL.md')} 并按协议工作，任务：……`);
}

function cmdNote(args) {
  const root = rootOrFail();
  const author = who(args);
  const text = args.join(' ').trim();
  if (!text) fail('note 需要内容');
  const p = path.join(root, RELAY_DIR, 'handoff.md');
  fs.appendFileSync(p, `- [${stamp()}] [${author}] ${text}\n`);
  console.log('relay: 已记录');
}

function cmdDecision(args) {
  const root = rootOrFail();
  const author = who(args);
  const text = args.join(' ').trim();
  if (!text) fail('decision 需要内容');
  const p = path.join(root, RELAY_DIR, 'decisions.md');
  fs.appendFileSync(p, `- [${stamp()}] [${author}] ${text}\n`);
  console.log('relay: 已记录决策');
}

function todoText(line) {
  return line.replace(/^\s*- \[ \]\s*/, '').trim();
}

function cmdBoard(args) {
  const root = rootOrFail();
  const sub = args.shift();
  const p = path.join(root, RELAY_DIR, 'board.md');
  let content = (read(p) || boardTemplate()).replace(/\r/g, '');
  if (sub === 'add') {
    const text = args.join(' ').trim();
    if (!text) fail('board add 需要内容');
    const lines = content.split('\n');
    const i = lines.findIndex((l) => l.trimEnd() === '## 待办');
    if (i === -1) fail('任务板缺少「## 待办」节');
    lines.splice(i + 1, 0, `- [ ] ${text}`);
    fs.writeFileSync(p, lines.join('\n'));
    console.log(`relay: 已加入待办：${text}`);
  } else if (sub === 'done') {
    const indexArg = flag(args, '--index');
    const kw = args.join(' ').trim();
    const lines = content.split('\n');
    const todoIdx = [];
    lines.forEach((l, i) => { if (/^\s*- \[ \]/.test(l)) todoIdx.push(i); });
    if (!todoIdx.length) fail('待办里没有可完成的条目');
    const listTodos = (idxs) => idxs.map((i) => `  ${todoIdx.indexOf(i) + 1}. ${todoText(lines[i])}`).join('\n');
    let ti;
    if (indexArg !== null) {
      const n = parseInt(indexArg, 10);
      if (!Number.isInteger(n) || n < 1 || n > todoIdx.length) fail(`--index 超出范围（1..${todoIdx.length}）`);
      ti = todoIdx[n - 1];
    } else {
      if (!kw) fail('board done 需要关键词或 --index <n>');
      const exact = todoIdx.filter((i) => todoText(lines[i]) === kw);
      const partial = todoIdx.filter((i) => todoText(lines[i]).includes(kw));
      const pool = exact.length ? exact : partial;
      if (!pool.length) fail(`待办里找不到「${kw}」。当前待办：\n${listTodos(todoIdx)}`);
      if (pool.length > 1) fail(`「${kw}」匹配到 ${pool.length} 条，请用 --index 指定其一，避免误删：\n${listTodos(pool)}`);
      ti = pool[0];
    }
    const [line] = lines.splice(ti, 1);
    const doneLine = line.replace(/^(\s*- )\[ \]/, '$1[x]') + `（${stamp()} 完成）`;
    let di = lines.findIndex((l) => l.trimEnd() === '## 已完成');
    if (di === -1) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', '## 已完成');
      di = lines.length - 1;
    }
    lines.splice(di + 1, 0, doneLine);
    fs.writeFileSync(p, lines.join('\n'));
    console.log(`relay: 已移入已完成：${todoText(line)}`);
  } else {
    fail('board 子命令: add | done');
  }
}

function tailLines(file, n) {
  const lines = read(file).split('\n').filter((l) => l.startsWith('- ['));
  return lines.slice(-n).join('\n') || '（暂无）';
}

function cmdBrief(args) {
  const root = rootOrFail();
  const tail = parseInt(flag(args, '--tail') || '15', 10);
  const relay = path.join(root, RELAY_DIR);
  const meta = JSON.parse(read(path.join(relay, 'relay.json')) || '{}');
  console.log(`## 接力简报 · 项目 ${meta.project || path.basename(root)}（粘贴进新会话即可续上）`);
  console.log('');
  console.log('### 任务板');
  console.log(read(path.join(relay, 'board.md')).trim());
  console.log('');
  console.log(`### 最近 ${tail} 条交接记录`);
  console.log(tailLines(path.join(relay, 'handoff.md'), tail));
  console.log('');
  console.log('### 决策记录');
  console.log(read(path.join(relay, 'decisions.md')).replace('# 决策记录', '').trim() || '（暂无）');
  console.log('');
  console.log('### 给下一个模型的指令');
  console.log(`先读 ${path.join(relay, 'PROTOCOL.md')}；认领任务用 relay board，过程记录用 relay note，完工移板用 relay board done。`);
}

function cmdPaste(args) {
  const root = rootOrFail();
  const tpl = read(path.join(HERE, '..', 'templates', 'CHAT-PASTE.md'));
  const brief = [];
  const origLog = console.log;
  console.log = (...a) => brief.push(a.join(' '));
  cmdBrief(args);
  console.log = origLog;
  console.log(tpl.replace('{{BRIEF}}', brief.join('\n')));
}

// ---- 工作树守卫：auto 派发前后对项目树做快照/还原 ----
// headless agent 带文件工具时会直接写真工作树（cwd=root），绕过验证门；且门 FAIL 时直写仍留存。
// 快照 → 派发 → 无条件还原，保证 executeVerify 在干净基线上验证回执，只有过门 changes 能落地。
const GUARD_EXCLUDE = new Set(['.git', 'node_modules', RELAY_DIR]);

function walkFiles(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (GUARD_EXCLUDE.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, base, out);
    else if (ent.isFile()) out.push(abs); // 符号链接 isFile() 为 false：不纳入快照，也不删
  }
  return out;
}

// 返回 Map：{相对路径（正斜杠）-> utf8 全文}
function snapshotTree(dir) {
  const root = path.resolve(dir);
  const snap = new Map();
  for (const abs of walkFiles(root, root, [])) {
    const rel = normalizePath(path.relative(root, abs));
    try { snap.set(rel, fs.readFileSync(abs, 'utf8')); } catch { /* 读不到则不纳入快照 */ }
  }
  return snap;
}

// 还原到快照：快照有而磁盘缺失/被改的 → 重写；磁盘有而快照没有的（agent 新建）→ 删除。
// 返回 { restored, deleted, failed }（相对路径数组），调用方按需记录/告警。
function restoreTree(dir, snapshot) {
  const root = path.resolve(dir);
  const restored = [];
  const deleted = [];
  const failed = [];
  for (const [rel, content] of snapshot) {
    const abs = path.resolve(root, rel);
    let now = null;
    try { now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; } catch { now = null; }
    if (now === content) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      restored.push(rel);
    } catch (e) { failed.push(`${rel}（还原失败：${e.message}）`); }
  }
  for (const abs of walkFiles(root, root, [])) {
    const rel = normalizePath(path.relative(root, abs));
    if (snapshot.has(rel)) continue;
    try { fs.rmSync(abs, { force: true }); deleted.push(rel); } catch (e) { failed.push(`${rel}（删除失败：${e.message}）`); }
  }
  return { restored, deleted, failed };
}

function applyChanges(destDir, changes) {
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || typeof c.content !== 'string') {
      return { ok: false, reason: 'changes 条目非法（每条需要 {path, content} 两个字符串字段）' };
    }
    const dest = path.resolve(destDir, c.path);
    const rel = path.relative(destDir, dest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: `拒绝越界写入（path 逃出项目目录）：${c.path}` };
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, c.content);
  }
  return { ok: true };
}

// opts: { strict: bool, onSensitive: (paths[]) => void }
function executeVerify(receipt, project, testCmd, opts) {
  const { strict = false, onSensitive = null } = opts || {};
  const isPaste = receipt.transport === 'paste';
  if (!isPaste) {
    const tcc = receipt.tool_call_count;
    if (!Number.isInteger(tcc) || tcc <= 0) {
      return { ok: false, reason: `存活检查未通过：tool_call_count=${JSON.stringify(tcc)}（疑似空跑/静默失败，比如只回「OK」）`, detail: '' };
    }
  }
  const changes = Array.isArray(receipt.changes) ? receipt.changes : null;
  if (!changes || !changes.length) {
    return { ok: false, reason: '回执里没有 changes 数组，无产物可验证', detail: '' };
  }

  // 裁决一：敏感路径守卫（严格模式在复制 temp 之前拦截）
  const sensitiveHits = changes.filter((c) => c && typeof c.path === 'string' && isSensitivePath(c.path));
  if (strict && sensitiveHits.length > 0) {
    const paths = sensitiveHits.map((c) => c.path).join(', ');
    return { ok: false, reason: `敏感路径守卫：auto 模式禁止修改 ${paths}，如确需改请人工执行`, detail: '' };
  }
  if (!strict && onSensitive && sensitiveHits.length > 0) {
    onSensitive(sensitiveHits.map((c) => c.path));
  }

  // 裁决二：非代码文件按行防破坏守卫
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || typeof c.content !== 'string') continue;
    const orig = path.resolve(project, c.path);
    const rel = path.relative(project, orig);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!fs.existsSync(orig)) continue; // 新建文件不守卫

    if (isCodeFile(c.path)) {
      // 代码文件：50% 字节阈值
      const before = fs.statSync(orig).size;
      const after = Buffer.byteLength(c.content);
      if (before > 0 && after < before * 0.5) {
        const pct = Math.round((after / before) * 100);
        return { ok: false, reason: `疑似破坏性写入：${c.path} 新内容仅原文件的 ${pct}%（<50%），已拒绝；如确需大幅删改请人工执行`, detail: '' };
      }
    } else {
      // 非代码文件：按行判定
      const origContent = fs.readFileSync(orig, 'utf8');
      const destructiveReason = checkNonCodeDestructive(origContent, c.content);
      if (destructiveReason) {
        return { ok: false, reason: `疑似破坏性写入：${destructiveReason}`, detail: '' };
      }
    }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-verify-'));
  try {
    fs.cpSync(project, temp, {
      recursive: true,
      filter: (src) => { const b = path.basename(src); return b !== '.git' && b !== 'node_modules'; },
    });
    const applied = applyChanges(temp, changes);
    if (!applied.ok) return { ok: false, reason: applied.reason, detail: '' };
    const r = spawnSync(testCmd, { shell: true, cwd: temp, encoding: 'utf8' });
    const detail = ((r.stdout || '') + (r.stderr || '')).trim();
    const ok = r.status === 0;
    return {
      ok,
      reason: ok ? `验证通过：产物已应用到临时副本，测试命令 \`${testCmd}\` 退出码 0` : `验证失败：测试命令 \`${testCmd}\` 退出码 ${r.status}`,
      detail,
    };
  } catch (e) {
    return { ok: false, reason: '验证过程异常：' + e.message, detail: '' };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function conclude(relay, receipt, res, noRecord) {
  const tag = res.ok ? 'PASS' : 'FAIL';
  console.log(`relay verify: ${tag} — ${res.reason}`);
  if (res.detail) {
    const shown = res.detail.split('\n').slice(-20).join('\n');
    console.log('---- 测试输出（末尾 20 行）----\n' + shown);
  }
  if (!noRecord) {
    const author = `${receipt.client || '?'}/${receipt.model || '?'}`;
    const task = receipt.task_id || '?';
    fs.appendFileSync(path.join(relay, 'handoff.md'), `- [${stamp()}] [verify:${tag}] task=${task} by=${author} ${res.reason}\n`);
  }
  process.exit(res.ok ? 0 : 1);
}

function cmdVerify(args) {
  const root = rootOrFail();
  const relay = path.join(root, RELAY_DIR);
  const receiptPath = args.shift();
  if (!receiptPath) fail('verify 需要回执文件：relay verify <receipt.json> [--project <dir>] [--test <cmd>] [--no-record]');
  const projectArg = flag(args, '--project');
  const testArg = flag(args, '--test');
  const noRecord = args.includes('--no-record');
  const project = path.resolve(projectArg || root);

  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), 'utf8'));
  } catch (e) {
    return conclude(relay, {}, { ok: false, reason: '回执读取/解析失败：' + e.message, detail: '' }, noRecord);
  }
  const meta = JSON.parse(read(path.join(relay, 'relay.json')) || '{}');
  const testCmd = testArg || (meta.verify && meta.verify.test) || 'npm test';

  // manual 模式：strict=false，记审计日志
  const auditLines = [];
  const onSensitive = (paths) => {
    auditLines.push(`- [${stamp()}] [verify:manual] 放行敏感路径：${paths.join(', ')}`);
  };
  const res = executeVerify(receipt, project, testCmd, { strict: false, onSensitive });
  if (auditLines.length > 0) {
    fs.appendFileSync(path.join(relay, 'handoff.md'), auditLines.join('\n') + '\n');
  }
  conclude(relay, receipt, res, noRecord);
}

function findTodoIdx(lines) {
  const idx = [];
  lines.forEach((l, i) => { if (/^\s*- \[ \]/.test(l)) idx.push(i); });
  return idx;
}

function relocateTodo(content, ti, targetSection, done) {
  const lines = content.split('\n');
  const [line] = lines.splice(ti, 1);
  const newLine = done ? line.replace(/^(\s*- )\[ \]/, '$1[x]') + `（${stamp()} 完成）` : line;
  let di = lines.findIndex((l) => l.trimEnd() === `## ${targetSection}`);
  if (di === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${targetSection}`);
    di = lines.length - 1;
  }
  lines.splice(di + 1, 0, newLine);
  return lines.join('\n');
}

function moveByText(content, text, targetSection, done) {
  const lines = content.split('\n');
  const ti = lines.findIndex((l) => /^\s*- \[ \]/.test(l) && todoText(l) === text);
  if (ti === -1) return content;
  return relocateTodo(content, ti, targetSection, done);
}

function renderPrompt(taskId, taskText, model) {
  return `你是被 relay auto 派来干活的模型（${model || '未指定'}）。

任务 ID: ${taskId}
任务: ${taskText}

按 .relay/PROTOCOL.md 工作。完成后，把你的改动整理成一份「回执 JSON」，用 \`\`\`json 围栏包裹，作为回复的最后一段输出。回执格式：

{
  "task_id": "${taskId}",
  "client": "<你的客户端名>",
  "model": "<你的模型名>",
  "transport": "mcp",
  "tool_call_count": <你本次真实发起的工具调用次数>,
  "files_read": ["<读过的文件>"],
  "changes": [
    { "path": "<相对项目根的路径>", "content": "<修改后的完整文件内容>" }
  ]
}

硬性要求：
- 不要直接改项目工作树——编排器会在 relay verify 跑通测试后替你应用 changes。
- content 必须是修改后的「完整文件内容」，不是 diff 片段。
- 只提交确有把握的改动；宁可少而正确。orchestrator 会用 npm test 验证，红了一律打回。
`;
}

function cmdAuto(args) {
  const root = rootOrFail();
  const relay = path.join(root, RELAY_DIR);
  const dispatch = flag(args, '--dispatch');
  const model = flag(args, '--model') || process.env.RELAY_MODEL || '';
  const taskKw = flag(args, '--task');
  const testArg = flag(args, '--test');
  const timeout = parseInt(flag(args, '--timeout') || '600', 10);
  const dryRun = args.includes('--dry-run');
  const allowSensitive = args.includes('--allow-sensitive');
  if (!dispatch) fail('auto 需要 --dispatch <cmd>：一个接收任务、产出回执 JSON 的命令（示例见 examples/dispatch-openclaw.mjs）');

  const bp = path.join(root, RELAY_DIR, 'board.md');
  let content = (read(bp) || boardTemplate()).replace(/\r/g, '');
  let lines = content.split('\n');
  const todoIdx = findTodoIdx(lines);
  if (!todoIdx.length) fail('待办为空，没有可自动派发的任务');

  let ti;
  if (taskKw) {
    const exact = todoIdx.filter((i) => todoText(lines[i]) === taskKw);
    const partial = todoIdx.filter((i) => todoText(lines[i]).includes(taskKw));
    const pool = exact.length ? exact : partial;
    if (!pool.length) fail(`待办里找不到「${taskKw}」`);
    if (pool.length > 1) fail(`「${taskKw}」匹配到 ${pool.length} 条，请用更精确的关键词`);
    ti = pool[0];
  } else {
    ti = todoIdx[0];
  }
  const taskText = todoText(lines[ti]);
  const taskId = `auto-${Date.now()}`;
  const meta = JSON.parse(read(path.join(relay, 'relay.json')) || '{}');
  const testCmd = testArg || (meta.verify && meta.verify.test) || 'npm test';
  const handoff = path.join(relay, 'handoff.md');
  const record = (line) => fs.appendFileSync(handoff, `- [${stamp()}] ${line}\n`);

  if (!dryRun) {
    content = relocateTodo(content, ti, '进行中', false);
    fs.writeFileSync(bp, content);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auto-'));
  let res;
  try {
    const promptFile = path.join(work, 'task.md');
    const receiptOut = path.join(work, 'receipt.json');
    fs.writeFileSync(promptFile, renderPrompt(taskId, taskText, model));
    console.log(`relay auto: 派发任务「${taskText}」→ ${model || '默认模型'}（dispatch: ${dispatch}）`);
    // 工作树守卫：派发前快照，派发后（无论成败/是否 dryRun）立即还原 agent 的直写与新增，
    // 使 executeVerify 在干净基线上验证回执——只有过门的 changes 能落地。
    const snap = snapshotTree(root);
    let d;
    try {
      d = spawnSync(dispatch, [promptFile], {
        shell: true, cwd: root, encoding: 'utf8', timeout: timeout * 1000,
        env: { ...process.env, RELAY_TASK_ID: taskId, RELAY_TASK_TEXT: taskText, RELAY_MODEL: model, RELAY_RECEIPT_OUT: receiptOut, RELAY_TIMEOUT: String(timeout) },
      });
    } finally {
      const guard = restoreTree(root, snap);
      if (guard.restored.length || guard.deleted.length) {
        console.log(`relay auto: 工作树守卫还原 ${guard.restored.length} 个直写、删除 ${guard.deleted.length} 个新增文件`);
        record(`[auto:GUARD] 还原直写 ${guard.restored.length} 个、删除新增 ${guard.deleted.length} 个`
          + (guard.restored.length ? `；还原：${guard.restored.join(', ')}` : '')
          + (guard.deleted.length ? `；删除：${guard.deleted.join(', ')}` : ''));
      }
      if (guard.failed.length) {
        console.error('relay auto: 工作树守卫未完全还原 — ' + guard.failed.join('；'));
        record(`[auto:GUARD-WARN] 守卫未完全还原：${guard.failed.join('；')}`);
      }
    }
    let receiptRaw = fs.existsSync(receiptOut) ? fs.readFileSync(receiptOut, 'utf8').trim() : '';
    if (!receiptRaw) receiptRaw = (d.stdout || '').trim();
    let receipt = null;
    try { receipt = JSON.parse(receiptRaw); } catch { receipt = null; }
    if (!receipt) {
      const why = d.error ? `派发命令执行失败：${d.error.message}` : `派发未产出合法回执 JSON（退出码 ${d.status}）`;
      res = { ok: false, reason: why, detail: ((d.stdout || '') + (d.stderr || '')).trim() };
    } else {
      console.log(`relay auto: 收到回执 model=${receipt.model || '?'} client=${receipt.client || '?'} tool_call_count=${JSON.stringify(receipt.tool_call_count)}`);
      // auto 模式：默认 strict=true，--allow-sensitive 时 strict=false（但仍写审计日志）
      const strict = !allowSensitive;
      const auditLines = [];
      const onSensitive = (paths) => {
        auditLines.push(`- [${stamp()}] [auto:allow-sensitive] 放行敏感路径：${paths.join(', ')}`);
      };
      res = executeVerify(receipt, root, testCmd, { strict, onSensitive });
      if (auditLines.length > 0) record(auditLines.join('\n'));
      if (res.ok && !dryRun) {
        const applied = applyChanges(root, receipt.changes);
        if (!applied.ok) {
          res = { ok: false, reason: '验证通过但应用到工作树失败：' + applied.reason, detail: res.detail };
        }
      }
    }
  } catch (e) {
    res = { ok: false, reason: 'auto 过程异常：' + e.message, detail: '' };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`relay auto: ${res.ok ? 'PASS' : 'FAIL'} — ${res.reason}`);
  if (res.detail) console.log('---- 测试输出（末尾 20 行）----\n' + res.detail.split('\n').slice(-20).join('\n'));

  if (!dryRun) {
    let board = read(bp).replace(/\r/g, '');
    if (res.ok) {
      board = moveByText(board, taskText, '已完成', true);
      record(`[auto:APPLIED] task=${taskId}「${taskText}」model=${model || '?'} verify=PASS → 已应用到工作树并移入已完成`);
    } else {
      board = moveByText(board, taskText, '待办', false);
      record(`[auto:REJECTED] task=${taskId}「${taskText}」model=${model || '?'} reason=${res.reason} → 未应用，退回待办`);
    }
    fs.writeFileSync(bp, board);
  }
  process.exit(res.ok ? 0 : 1);
}

function memServerSnippet(root) {
  const memFile = path.join(root, RELAY_DIR, 'memory.jsonl').replace(/\\/g, '/');
  return { memFile, npx: ['npx', '-y', '@modelcontextprotocol/server-memory'] };
}

function cmdConnect(args) {
  const client = flag(args, '--client') || fail('connect 需要 --client <qoder|workbuddy|openclaw|dsh|doubao>');
  const root = rootOrFail();
  const { memFile, npx } = memServerSnippet(root);
  const env = `MEMORY_FILE_PATH=${memFile}`;
  switch (client) {
    case 'qoder':
      console.log(`# 合并进 ~/.qoder-cn/settings.json（或项目 .qoder/settings.json）的 mcpServers：`);
      console.log(JSON.stringify({ 'shared-memory': { command: npx[0], args: npx.slice(1), env: { MEMORY_FILE_PATH: memFile } } }, null, 2));
      console.log('# 生效后在会话里运行 /mcp reload');
      break;
    case 'workbuddy':
      console.log(`# 合并进 ~/.workbuddy/.mcp.json 的 mcpServers：`);
      console.log(JSON.stringify({ 'shared-memory': { command: npx[0], args: npx.slice(1), env: { MEMORY_FILE_PATH: memFile } } }, null, 2));
      break;
    case 'openclaw':
      console.log(`# 终端执行：`);
      console.log(`openclaw mcp set shared-memory '{"command":"${npx[0]}","args":${JSON.stringify(npx.slice(1))},"env":{"MEMORY_FILE_PATH":"${memFile}"}}'`);
      break;
    case 'dsh':
      console.log('# 追加到 profile 的 cordis.patch.yml：');
      console.log(`- insert:
    - id: mcp-shared-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shared_memory
        transport: stdio
        command: ${npx[0]}
        args: ${JSON.stringify(npx.slice(1))}
        env:
          MEMORY_FILE_PATH: '${memFile}'`);
      console.log('# 然后重启 dsh web');
      break;
    case 'doubao':
      console.log('# 豆包无 MCP/文件能力，走粘贴协议：');
      console.log('relay paste 的输出整段贴进对话即可。');
      break;
    default:
      fail('未知客户端: ' + client);
  }
  console.log(`# 注意: 环境变量 ${env} 指向本项目自己的记忆文件，多个项目想共享同一份记忆就把路径改成同一个文件。`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'init': cmdInit(rest[0]); break;
  case 'note': cmdNote(rest); break;
  case 'decision': cmdDecision(rest); break;
  case 'board': cmdBoard(rest); break;
  case 'brief': cmdBrief(rest); break;
  case 'paste': cmdPaste(rest); break;
  case 'verify': cmdVerify(rest); break;
  case 'auto': cmdAuto(rest); break;
  case 'connect': cmdConnect(rest); break;
  case 'help': case undefined: case '--help': case '-h': console.log(HELP); break;
  default: fail(`未知命令 ${cmd}，运行 relay help`);
}

export { executeVerify, applyChanges, isSensitivePath, checkNonCodeDestructive, SENSITIVE_PATTERNS, isCodeFile, snapshotTree, restoreTree };
