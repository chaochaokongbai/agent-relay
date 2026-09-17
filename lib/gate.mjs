// agent-relay 准入网关（库入口）：零依赖、无副作用，可被任意编排器 / CI 直接调用
//   import { executeVerify, buildVerdict, recheckEvidence } from 'agent-relay/gate';
// 与 CLI 共用同一份实现（bin/relay.mjs 从这里导入）；门的策略版本见 GATE_VERSION。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

// ---- 独立复验（recheck）：不信任 agent-relay 的人也能自己验链、验哈希、重跑证据 ----
// 输入 evidence.jsonl 全文，返回结构化报告。除 --rerun 会跑一次测试命令外，无副作用。
function recheckEvidence(text, opts) {
  const { project = null, rerun = false, allowDrift = false } = opts || {};
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  const problems = [];
  const drift = [];
  const entries = [];
  let prev = 'genesis';

  for (let i = 0; i < lines.length; i++) {
    let v;
    try {
      v = JSON.parse(lines[i]);
    } catch (e) {
      problems.push({ kind: 'parse', line: i + 1, detail: e.message });
      continue;
    }
    entries.push(v);
    if (!v.chain || typeof v.chain.self !== 'string') {
      problems.push({ kind: 'chain-missing', line: i + 1, detail: '缺 chain.self' });
      continue;
    }
    if (v.chain.prev !== prev) {
      problems.push({ kind: 'chain-break', line: i + 1, detail: 'chain.prev=' + v.chain.prev + '，但上一条 self=' + prev });
    }
    const expect = sha256(stableJson({ ...v, chain: { prev: v.chain.prev } }));
    if (expect !== v.chain.self) {
      problems.push({ kind: 'tamper', line: i + 1, detail: 'chain.self 与记录内容不符（这条被改过）' });
    }
    prev = v.chain.self;
  }

  // 工作树漂移：每个路径只跟「最新一条提到它的裁决」比，确认落地的就是过门的那份
  if (project) {
    const latest = new Map();
    entries.forEach((v, i) => {
      for (const c of Array.isArray(v.changes) ? v.changes : []) {
        if (c && typeof c.path === 'string') latest.set(c.path, { sha256: c.sha256, line: i + 1 });
      }
    });
    for (const [p, exp] of latest) {
      const abs = path.resolve(project, p);
      let actual = null;
      try { actual = fs.existsSync(abs) ? sha256(fs.readFileSync(abs, 'utf8')) : null; } catch { actual = null; }
      if (actual !== exp.sha256) {
        drift.push({ path: p, expectedSha256: exp.sha256, actualSha256: actual, fromLine: exp.line });
      }
    }
  }

  let rerunResult = null;
  if (rerun && project) {
    const last = [...entries].reverse().find((v) => v.evidence && v.evidence.testCmd);
    if (last) {
      const r = spawnSync(last.evidence.testCmd, { shell: true, cwd: project, encoding: 'utf8' });
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      rerunResult = {
        testCmd: last.evidence.testCmd,
        exitCode: typeof r.status === 'number' ? r.status : null,
        outputSha256: sha256(out),
        expectedExitCode: last.evidence.exitCode === undefined ? null : last.evidence.exitCode,
        expectedOutputSha256: last.evidence.outputSha256 || null,
        sameExitCode: r.status === last.evidence.exitCode,
      };
    }
  }

  const driftFail = drift.length > 0 && !allowDrift;
  const rerunFail = !!(rerunResult && rerunResult.exitCode !== 0);
  const ok = problems.length === 0 && !driftFail && !rerunFail;
  const bits = [
    entries.length + ' 条裁决',
    problems.length ? '链问题 ' + problems.length : '链完整',
    drift.length ? '工作树漂移 ' + drift.length + (allowDrift ? '（已放行）' : '') : '无漂移',
  ];
  if (rerunResult) bits.push('重跑 ' + (rerunResult.exitCode === 0 ? 'PASS' : 'FAIL') + '（退出码 ' + rerunResult.exitCode + '）');
  return { schemaVersion: 1, ok, summary: bits.join(' / '), entries: entries.length, problems, drift, rerun: rerunResult };
}

export {
  RELAY_DIR, SENSITIVE_PATTERNS, normalizePath, isSensitivePath, isCodeFile, checkNonCodeDestructive,
  walkFiles, snapshotTree, restoreTree, applyChanges,
  GATE_NAME, GATE_VERSION, VERDICT_SCHEMA_VERSION, EVIDENCE_FILE, CAPABILITY_TIERS, sha256, stableJson,
  capabilityTier, sealVerdict, buildVerdict, appendEvidence, executeVerify, recheckEvidence,
};
