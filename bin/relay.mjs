#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
                                [--project <dir>] [--test <cmd>] [--no-record] [--json]
                                退出码 0=PASS，1=FAIL，并在 handoff.md 留一条带署名的验证记录
                                manual 模式允许改敏感路径但写审计日志
                                --json 额外产出可复验的准入裁决（见文末「准入裁决」）
  relay auto --dispatch <cmd>   无人值守闭环：取一条待办 → 派发给 <cmd>（headless 模型）→ 收回执
                                → relay verify → 通过才应用到工作树并移入已完成，否则退回待办
                                [--task <关键词>] [--model <m>] [--test <cmd>] [--timeout <秒>] [--dry-run]
                                [--allow-sensitive]  本轮放行敏感路径（auto 默认严格，敏感路径：.github/** .relay/** tests/** package.json）
                                [--json]             产出可复验的准入裁决 JSON（见文末「准入裁决」）
  relay connect --client <name> 输出该客户端接入共享记忆 MCP 的配置
                                name: qoder | workbuddy | openclaw | dsh | doubao
  relay help                    本帮助

验证门守卫说明：
  auto 模式（默认）          严格守卫：任何 changes 命中敏感路径（.github/** .relay/** tests/** package.json）直接 FAIL
  auto --allow-sensitive     本轮放行敏感路径，但写审计日志
  manual 模式（verify）      放宽：允许改敏感路径，写审计日志
  非代码文件                按行判破坏：已存在文件若删除了原有非空行 → FAIL（纯增量放行）
  代码文件（.mjs/.js/.cjs）   维持 50% 字节阈值
  工作树守卫                 auto 派发前对项目树快照、派发后无条件还原：agent 的直写、新增文件/符号链接、
                              新建的空目录一律还原，只有过门 changes 才落地（排除 .git/node_modules/.relay）

准入裁决（--json）:
  relay verify <receipt.json> --json    不打印人话，输出结构化裁决 JSON，并追加一行到 .relay/evidence.jsonl
  relay auto --dispatch <cmd> --json    同上（auto 跑完打印裁决）
  裁决内容                              gate{name,version,policy} + verdict + receipt.sha256 + changes[].sha256
                                       + checks[]（liveness / sensitive-path / destructive-write / path-containment / test-gate）
                                       + evidence{testCmd,exitCode,outputSha256,durationMs} + chain{prev,self} 哈希链
  能力分级                              L0 paste（纯聊天客户端，豁免存活检查）/ L1 tool / L2 exec

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

// 遍历项目树，分别收集普通文件、目录、符号链接的绝对路径。
// 符号链接单独识别（ent.isSymbolicLink）且不跟随：不递归进链接目录、不当普通文件读内容。
function walkFiles(dir, base, out) {
  out = out || { files: [], dirs: [], symlinks: [] };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (GUARD_EXCLUDE.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) { out.symlinks.push(abs); continue; }
    if (ent.isDirectory()) { out.dirs.push(abs); walkFiles(abs, base, out); }
    else if (ent.isFile()) { out.files.push(abs); }
  }
  return out;
}

const relOf = (root, abs) => normalizePath(path.relative(root, abs));

// 返回 { files: Map<相对路径, utf8 全文>, dirs: Set<相对路径>, symlinks: Map<相对路径, readlink 目标> }
// 目录集合用于区分「本来就有的空目录」与「agent 新建的目录」，避免误删有意保留的空目录。
function snapshotTree(dir) {
  const root = path.resolve(dir);
  const files = new Map();
  const dirs = new Set();
  const symlinks = new Map();
  const cur = walkFiles(root, root);
  for (const abs of cur.files) {
    const rel = relOf(root, abs);
    try { files.set(rel, fs.readFileSync(abs, 'utf8')); } catch { /* 读不到则不纳入快照 */ }
  }
  for (const abs of cur.dirs) dirs.add(relOf(root, abs));
  for (const abs of cur.symlinks) {
    const rel = relOf(root, abs);
    try { symlinks.set(rel, fs.readlinkSync(abs)); } catch { /* 读不到链接目标则不纳入快照 */ }
  }
  return { files, dirs, symlinks };
}

// 兼容 round 13 的旧式 Map 快照：视作 files，dirs 由 files 键的祖先目录推导，symlinks 为空。
function normalizeSnapshot(snapshot) {
  if (snapshot instanceof Map) {
    const dirs = new Set();
    for (const rel of snapshot.keys()) {
      const parts = normalizePath(rel).split('/');
      parts.pop();
      let acc = '';
      for (const seg of parts) { acc = acc ? `${acc}/${seg}` : seg; dirs.add(acc); }
    }
    return { files: snapshot, dirs, symlinks: new Map() };
  }
  return {
    files: (snapshot && snapshot.files) || new Map(),
    dirs: (snapshot && snapshot.dirs) || new Set(),
    symlinks: (snapshot && snapshot.symlinks) || new Map(),
  };
}

// 还原到快照：快照有而磁盘缺失/被改的 → 重写；磁盘有而快照没有的（agent 新建）→ 删除。
// 符号链接按 readlink 目标比对/重建；agent 新建的空目录自底向上剪枝，快照记录过的目录即使空也保留。
// 返回 { restored, deleted, failed }（相对路径数组），调用方按需记录/告警。
function restoreTree(dir, snapshot) {
  const root = path.resolve(dir);
  const { files, dirs, symlinks } = normalizeSnapshot(snapshot);
  const restored = [];
  const deleted = [];
  const failed = [];

  // 1) 先清掉 agent 新建的符号链接与文件（先删链接，避免随后的还原顺着链接写到树外）
  const before = walkFiles(root, root);
  for (const abs of before.symlinks) {
    const rel = relOf(root, abs);
    if (symlinks.has(rel)) continue;
    try { fs.rmSync(abs, { recursive: true, force: true }); deleted.push(rel); }
    catch (e) { failed.push(`${rel}（符号链接删除失败：${e.message}）`); }
  }
  for (const abs of before.files) {
    const rel = relOf(root, abs);
    if (files.has(rel)) continue;
    try { fs.rmSync(abs, { force: true }); deleted.push(rel); }
    catch (e) { failed.push(`${rel}（删除失败：${e.message}）`); }
  }

  // 2) 重建 agent 删掉的快照目录（快照记录过的目录即使空也保留）
  for (const rel of dirs) {
    const abs = path.resolve(root, rel);
    if (fs.existsSync(abs)) continue;
    try { fs.mkdirSync(abs, { recursive: true }); restored.push(rel); }
    catch (e) { failed.push(`${rel}（目录重建失败：${e.message}）`); }
  }

  // 3) 还原快照里的普通文件；该路径若被换成符号链接，先摘链再写，避免写到链接指向的树外
  for (const [rel, content] of files) {
    const abs = path.resolve(root, rel);
    let isLink = false;
    let now = null;
    try {
      isLink = fs.lstatSync(abs).isSymbolicLink();
      now = isLink ? null : fs.readFileSync(abs, 'utf8');
    } catch { now = null; }
    if (!isLink && now === content) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (isLink) fs.rmSync(abs, { force: true });
      fs.writeFileSync(abs, content);
      restored.push(rel);
    } catch (e) { failed.push(`${rel}（还原失败：${e.message}）`); }
  }

  // 4) 还原快照里的符号链接：缺失或目标变了 → 重建
  for (const [rel, target] of symlinks) {
    const abs = path.resolve(root, rel);
    let now = null;
    try { now = fs.readlinkSync(abs); } catch { now = null; }
    if (now === target) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.rmSync(abs, { recursive: true, force: true });
      fs.symlinkSync(target, abs);
      restored.push(rel);
    } catch (e) { failed.push(`${rel}（符号链接还原失败：${e.message}）`); }
  }

  // 5) 自底向上剪掉「不在快照目录集合里、且此刻已空」的目录；快照记录过的目录不误删
  const extraDirs = walkFiles(root, root).dirs.map((abs) => relOf(root, abs)).filter((rel) => !dirs.has(rel));
  extraDirs.sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of extraDirs) {
    try { fs.rmdirSync(path.resolve(root, rel)); deleted.push(rel); }
    catch { /* 非空或不可删：保留，不算失败 */ }
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

// ---- 准入裁决（admission verdict）：结构化、可复验、带版本 ----
// 这是 agent-relay 的差异化定位：门不只回答「过/不过」，而是产出一份第三方可复验的裁决记录
// （gate 版本 + 回执/变更哈希 + 逐项 checks + 测试证据 + 哈希链），并追加进 .relay/evidence.jsonl。
const GATE_NAME = 'agent-relay/executeVerify';
const GATE_VERSION = '1'; // 门策略版本：裁决口径变了就 +1，审计时能回答「哪一版门放行的」
const VERDICT_SCHEMA_VERSION = 1;
const EVIDENCE_FILE = 'evidence.jsonl';

// 能力分级：让「没有文件能力的纯聊天客户端」也能合法参与，而不是被一刀切拒绝——这是本门的特点之一。
const CAPABILITY_TIERS = {
  L0: 'paste：无文件/无工具能力（纯聊天客户端），豁免 tool_call_count 存活检查',
  L1: 'tool：有工具但未声明 exec，需 tool_call_count 为正整数',
  L2: 'exec：声明可执行命令，仍需 tool_call_count 为正整数',
};

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// 稳定序列化（对象键排序）——保证同一份回执在任意语言实现下算出同一个哈希
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function capabilityTier(receipt) {
  if (receipt && receipt.transport === 'paste') return 'L0';
  const caps = Array.isArray(receipt && receipt.capabilities) ? receipt.capabilities.map(String) : [];
  return caps.includes('exec') ? 'L2' : 'L1';
}

// 用哈希链封口：prev 指向上一条裁决的 self，形成可复验的证据链
function sealVerdict(verdict, prev) {
  verdict.chain = { prev: prev || 'genesis' };
  verdict.chain.self = sha256(stableJson({ ...verdict, chain: { prev: verdict.chain.prev } }));
  return verdict;
}

// 组装裁决对象（不含落盘）；checks 为 executeVerify 收集的逐项裁决
function buildVerdict({ receipt, checks, res, testCmd, policy, evidence }) {
  const rec = receipt && typeof receipt === 'object' ? receipt : {};
  const changes = Array.isArray(rec.changes) ? rec.changes : [];
  return sealVerdict({
    schemaVersion: VERDICT_SCHEMA_VERSION,
    gate: { name: GATE_NAME, version: GATE_VERSION, policy },
    verdict: res.ok ? 'PASS' : 'FAIL',
    reason: res.reason || '',
    receipt: {
      sha256: sha256(stableJson(rec)),
      taskId: rec.task_id || null,
      producer: {
        client: rec.client || null,
        model: rec.model || null,
        transport: rec.transport || null,
        tier: capabilityTier(rec),
        toolCallCount: typeof rec.tool_call_count === 'number' ? rec.tool_call_count : null,
      },
    },
    changes: changes.filter((c) => c && typeof c.path === 'string').map((c) => ({
      path: normalizePath(c.path),
      sha256: sha256(typeof c.content === 'string' ? c.content : ''),
      bytes: Buffer.byteLength(typeof c.content === 'string' ? c.content : ''),
    })),
    checks: Array.isArray(checks) ? checks : [],
    evidence: evidence || null,
    timestamp: new Date().toISOString(),
  }, 'genesis');
}

// 追加进 .relay/evidence.jsonl，并把 prev 接到上一条的 self 上（坏行/首次则从 genesis 起链）
function appendEvidence(relayDir, verdict) {
  const file = path.join(relayDir, EVIDENCE_FILE);
  let prev = 'genesis';
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      if (last && last.chain && last.chain.self) prev = last.chain.self;
    }
  } catch { /* 首次写入或坏文件：从 genesis 起链 */ }
  sealVerdict(verdict, prev);
  fs.appendFileSync(file, JSON.stringify(verdict) + '\n');
  return verdict;
}

// opts: { strict: bool, onSensitive: (paths[]) => void, checks: [] | null }
function executeVerify(receipt, project, testCmd, opts) {
  const { strict = false, onSensitive = null, checks = null } = opts || {};
  const mark = (id, ok, reason, severity = 'high') => { if (checks) checks.push({ id, ok, reason, severity }); };
  const isPaste = receipt.transport === 'paste';
  if (!isPaste) {
    const tcc = receipt.tool_call_count;
    if (!Number.isInteger(tcc) || tcc <= 0) {
      mark('liveness', false, `tool_call_count=${JSON.stringify(tcc)}`, 'high');
      return { ok: false, reason: `存活检查未通过：tool_call_count=${JSON.stringify(tcc)}（疑似空跑/静默失败，比如只回「OK」）`, detail: '' };
    }
    mark('liveness', true, `tool_call_count=${tcc}`, 'info');
  } else {
    mark('liveness', true, 'transport=paste：无文件客户端按 L0 受理，豁免 tool_call_count', 'info');
  }
  const changes = Array.isArray(receipt.changes) ? receipt.changes : null;
  if (!changes || !changes.length) {
    mark('changes-present', false, '回执里没有非空 changes 数组', 'high');
    return { ok: false, reason: '回执里没有 changes 数组，无产物可验证', detail: '' };
  }
  mark('changes-present', true, `${changes.length} 条变更`, 'info');

  // 裁决一：敏感路径守卫（严格模式在复制 temp 之前拦截）
  const sensitiveHits = changes.filter((c) => c && typeof c.path === 'string' && isSensitivePath(c.path));
  if (strict && sensitiveHits.length > 0) {
    const paths = sensitiveHits.map((c) => c.path).join(', ');
    mark('sensitive-path', false, `严格模式命中敏感路径：${paths}`, 'high');
    return { ok: false, reason: `敏感路径守卫：auto 模式禁止修改 ${paths}，如确需改请人工执行`, detail: '' };
  }
  if (!strict && onSensitive && sensitiveHits.length > 0) {
    onSensitive(sensitiveHits.map((c) => c.path));
    mark('sensitive-path', true, `manual 模式放行敏感路径（已写审计日志）：${sensitiveHits.map((c) => c.path).join(', ')}`, 'medium');
  } else {
    mark('sensitive-path', true, '未命中敏感路径', 'info');
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
        mark('destructive-write', false, `${c.path} 新内容仅原文件 ${pct}%（<50% 字节阈值）`, 'high');
        return { ok: false, reason: `疑似破坏性写入：${c.path} 新内容仅原文件的 ${pct}%（<50%），已拒绝；如确需大幅删改请人工执行`, detail: '' };
      }
    } else {
      // 非代码文件：按行判定
      const origContent = fs.readFileSync(orig, 'utf8');
      const destructiveReason = checkNonCodeDestructive(origContent, c.content);
      if (destructiveReason) {
        mark('destructive-write', false, destructiveReason, 'high');
        return { ok: false, reason: `疑似破坏性写入：${destructiveReason}`, detail: '' };
      }
    }
  }
  mark('destructive-write', true, '未触发破坏性写入守卫（代码文件 ≥50% 字节 / 非代码文件未删原有非空行）', 'info');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-verify-'));
  try {
    fs.cpSync(project, temp, {
      recursive: true,
      filter: (src) => { const b = path.basename(src); return b !== '.git' && b !== 'node_modules'; },
    });
    const applied = applyChanges(temp, changes);
    if (!applied.ok) {
      mark('path-containment', false, applied.reason, 'high');
      return { ok: false, reason: applied.reason, detail: '' };
    }
    mark('path-containment', true, '全部变更路径都在项目目录内', 'info');
    const r = spawnSync(testCmd, { shell: true, cwd: temp, encoding: 'utf8' });
    const detail = ((r.stdout || '') + (r.stderr || '')).trim();
    const ok = r.status === 0;
    mark('test-gate', ok, `\`${testCmd}\` 退出码 ${r.status}`, 'high');
    return {
      ok,
      reason: ok ? `验证通过：产物已应用到临时副本，测试命令 \`${testCmd}\` 退出码 0` : `验证失败：测试命令 \`${testCmd}\` 退出码 ${r.status}`,
      detail,
      exitCode: typeof r.status === 'number' ? r.status : null,
      outputSha256: sha256(detail),
    };
  } catch (e) {
    mark('verify-error', false, e.message, 'high');
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
  if (!receiptPath) fail('verify 需要回执文件：relay verify <receipt.json> [--project <dir>] [--test <cmd>] [--no-record] [--json]');
  const projectArg = flag(args, '--project');
  const testArg = flag(args, '--test');
  const noRecord = args.includes('--no-record');
  const jsonOut = args.includes('--json');
  const project = path.resolve(projectArg || root);
  const meta = JSON.parse(read(path.join(relay, 'relay.json')) || '{}');
  const testCmd = testArg || (meta.verify && meta.verify.test) || 'npm test';
  const startedAt = Date.now();
  const checks = [];

  let receipt = null;
  let parseError = '';
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), 'utf8'));
  } catch (e) {
    parseError = '回执读取/解析失败：' + e.message;
  }

  let res;
  if (parseError) {
    checks.push({ id: 'receipt-parse', ok: false, reason: parseError, severity: 'high' });
    res = { ok: false, reason: parseError, detail: '' };
  } else {
    // manual 模式：strict=false，记审计日志
    const auditLines = [];
    const onSensitive = (paths) => {
      auditLines.push(`- [${stamp()}] [verify:manual] 放行敏感路径：${paths.join(', ')}`);
    };
    res = executeVerify(receipt, project, testCmd, { strict: false, onSensitive, checks });
    if (auditLines.length > 0) {
      fs.appendFileSync(path.join(relay, 'handoff.md'), auditLines.join('\n') + '\n');
    }
  }

  if (jsonOut) {
    const verdict = buildVerdict({
      receipt: receipt || {},
      checks,
      res,
      testCmd,
      policy: 'manual',
      evidence: {
        testCmd,
        exitCode: typeof res.exitCode === 'number' ? res.exitCode : null,
        outputSha256: res.outputSha256 || null,
        durationMs: Date.now() - startedAt,
        tempApplied: typeof res.exitCode === 'number',
      },
    });
    if (!noRecord) appendEvidence(relay, verdict);
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  conclude(relay, receipt || {}, res, noRecord);
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
  const jsonOut = args.includes('--json');
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
  const checks = [];
  const startedAt = Date.now();

  if (!dryRun) {
    content = relocateTodo(content, ti, '进行中', false);
    fs.writeFileSync(bp, content);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auto-'));
  let res;
  let receipt = null;
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
    try { receipt = JSON.parse(receiptRaw); } catch { receipt = null; }
    if (!receipt) {
      const why = d.error ? `派发命令执行失败：${d.error.message}` : `派发未产出合法回执 JSON（退出码 ${d.status}）`;
      checks.push({ id: 'receipt-present', ok: false, reason: why, severity: 'high' });
      res = { ok: false, reason: why, detail: ((d.stdout || '') + (d.stderr || '')).trim() };
    } else {
      console.log(`relay auto: 收到回执 model=${receipt.model || '?'} client=${receipt.client || '?'} tool_call_count=${JSON.stringify(receipt.tool_call_count)}`);
      // auto 模式：默认 strict=true，--allow-sensitive 时 strict=false（但仍写审计日志）
      const strict = !allowSensitive;
      const auditLines = [];
      const onSensitive = (paths) => {
        auditLines.push(`- [${stamp()}] [auto:allow-sensitive] 放行敏感路径：${paths.join(', ')}`);
      };
      res = executeVerify(receipt, root, testCmd, { strict, onSensitive, checks });
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
  if (jsonOut) {
    const verdict = buildVerdict({
      receipt: receipt || {},
      checks,
      res,
      testCmd,
      policy: allowSensitive ? 'auto-allow-sensitive' : 'auto-strict',
      evidence: {
        testCmd,
        exitCode: typeof res.exitCode === 'number' ? res.exitCode : null,
        outputSha256: res.outputSha256 || null,
        durationMs: Date.now() - startedAt,
        tempApplied: typeof res.exitCode === 'number',
      },
    });
    appendEvidence(relay, verdict);
    console.log(JSON.stringify(verdict, null, 2));
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

export { executeVerify, applyChanges, isSensitivePath, checkNonCodeDestructive, SENSITIVE_PATTERNS, isCodeFile, snapshotTree, restoreTree, buildVerdict, appendEvidence, capabilityTier, stableJson, sha256, GATE_NAME, GATE_VERSION, VERDICT_SCHEMA_VERSION, EVIDENCE_FILE, CAPABILITY_TIERS };
