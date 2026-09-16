import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'relay.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL ' + name + ': ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

check('init', () => {
  run('init');
  assert(fs.existsSync(path.join(tmp, '.relay', 'board.md')), 'board.md missing');
  assert(fs.existsSync(path.join(tmp, '.relay', 'PROTOCOL.md')), 'PROTOCOL.md missing');
});
check('board add + note', () => {
  run('board', 'add', '实现登录页');
  run('note', '调研完毕');
  const board = fs.readFileSync(path.join(tmp, '.relay', 'board.md'), 'utf8');
  const handoff = fs.readFileSync(path.join(tmp, '.relay', 'handoff.md'), 'utf8');
  assert(board.includes('- [ ] 实现登录页'), 'board entry missing');
  assert(handoff.includes('[tester] 调研完毕'), 'note missing');
});
check('board done', () => {
  run('board', 'done', '登录页');
  const board = fs.readFileSync(path.join(tmp, '.relay', 'board.md'), 'utf8');
  assert(board.includes('- [x] 实现登录页'), 'done move failed');
});
check('decision', () => {
  const text = '采用 JSON 配置驱动';
  run('decision', text);
  const decisions = fs.readFileSync(path.join(tmp, '.relay', 'decisions.md'), 'utf8');
  assert(decisions.includes(text), 'decision entry missing');
  assert(decisions.includes('[tester]'), 'decision missing author');
  const out = run('brief');
  assert(out.includes(text), 'brief missing decision');
});
check('brief', () => {
  const out = run('brief');
  assert(out.includes('接力简报'), 'brief header missing');
  assert(out.includes('实现登录页'), 'brief missing board');
});
check('paste', () => {
  const out = run('paste');
  assert(out.includes('交接备注'), 'paste template missing');
});
check('connect', () => {
  for (const c of ['qoder', 'workbuddy', 'openclaw', 'dsh', 'doubao']) {
    const out = run('connect', '--client', c);
    assert(out.length > 0, 'empty connect output for ' + c);
  }
});

// 回归测试：覆盖 DSH 审查（relay-task-1）发现的 board done 缺陷
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test2-'));
const run2 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp2, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe2 = (...args) => { try { return { ok: true, out: run2(...args) }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; } };
const board2 = () => fs.readFileSync(path.join(tmp2, '.relay', 'board.md'), 'utf8');

check('done: 重名多命中 → 报错且不误删', () => {
  run2('init');
  run2('board', 'add', '修 login 超时');
  run2('board', 'add', '修 login 日志');
  const r = runSafe2('board', 'done', 'login');
  assert(!r.ok, '多命中时应当报错退出，而非静默完成');
  assert(/--index/.test(r.out) && /2 条/.test(r.out), '应提示用 --index 并报告命中条数');
  const b = board2();
  assert(b.includes('- [ ] 修 login 超时') && b.includes('- [ ] 修 login 日志'), '多命中时不应移动任何条目');
});
check('done: --index 精确定位第二条', () => {
  // 待办顺序为前插：[修 login 日志(1), 修 login 超时(2)]
  run2('board', 'done', '--index', '2');
  const b = board2();
  assert(b.includes('- [x] 修 login 超时'), '--index 2 应完成第二条（修 login 超时）');
  assert(b.includes('- [ ] 修 login 日志'), '第一条（修 login 日志）应保留在待办');
});
check('done: 精确匹配优先于子串', () => {
  run2('board', 'add', '登录超时');
  run2('board', 'add', '超时');
  run2('board', 'done', '超时');
  const b = board2();
  assert(b.includes('- [x] 超时'), '应精确完成「超时」这条');
  assert(b.includes('- [ ] 登录超时'), '含同子串的「登录超时」应保留（精确优先于子串）');
});
check('done: 成功日志回显被完成条目原文', () => {
  run2('board', 'add', '回显校验任务');
  const out = run2('board', 'done', '回显校验任务');
  assert(out.includes('回显校验任务'), '完成日志应回显条目原文');
});
check('done: 缺「## 已完成」节也能正确追加（不落文件头）', () => {
  const bp = path.join(tmp2, '.relay', 'board.md');
  fs.writeFileSync(bp, board2().replace('## 已完成', ''));
  run2('board', 'add', '临时任务');
  const r = runSafe2('board', 'done', '临时任务');
  assert(r.ok, '应成功完成: ' + r.out);
  const nb = board2();
  const firstLine = nb.split('\n').find((l) => l.trim() !== '');
  assert(!firstLine.startsWith('- [x]'), '完成项不应落到文件头');
  assert(nb.includes('## 已完成'), '应重新补上「## 已完成」节');
  assert(/- \[x\] 临时任务/.test(nb), '临时任务应被标记完成');
});
check('done: 缩进子任务也能识别', () => {
  const bp = path.join(tmp2, '.relay', 'board.md');
  const lines = board2().split('\n');
  const i = lines.findIndex((l) => l.trimEnd() === '## 待办');
  lines.splice(i + 1, 0, '  - [ ] 缩进的子任务');
  fs.writeFileSync(bp, lines.join('\n'));
  const r = runSafe2('board', 'done', '缩进的子任务');
  assert(r.ok, '应能完成缩进子任务: ' + r.out);
  assert(board2().includes('- [x] 缩进的子任务'), '缩进子任务应被标记完成');
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('all tests passed');
