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

// 验证门：relay verify（存活检查 + 应用产物到临时副本 + 跑测试）
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test3-'));
const run3 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp3, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe3 = (...args) => { try { return { ok: true, status: 0, out: run3(...args) }; } catch (e) { return { ok: false, status: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
const writeReceipt = (name, obj) => { const p = path.join(tmp3, name); fs.writeFileSync(p, JSON.stringify(obj)); return name; };
const existsTest = `node -e "process.exit(require('fs').existsSync('probe.txt')?0:1)"`;

check('verify: PASS — 产物应用且测试通过', () => {
  run3('init');
  const rec = writeReceipt('ok.json', {
    task_id: 'relay-task-x', client: 'TestClient', model: 'test-model',
    tool_call_count: 3, changes: [{ path: 'probe.txt', content: 'hi' }],
  });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest);
  assert(r.status === 0, 'PASS 时退出码应为 0，实际 ' + r.status + ' 输出: ' + r.out);
  assert(/PASS/.test(r.out), '应打印 PASS');
  const handoff = fs.readFileSync(path.join(tmp3, '.relay', 'handoff.md'), 'utf8');
  assert(/verify:PASS/.test(handoff) && /TestClient\/test-model/.test(handoff), '应在 handoff.md 留带署名的 PASS 记录');
});
check('verify: FAIL — 存活检查拦截 tool_call_count=0（空跑）', () => {
  const rec = writeReceipt('dead.json', {
    task_id: 'relay-task-x', client: 'MiniMax', model: 'M2.7',
    tool_call_count: 0, changes: [{ path: 'probe.txt', content: 'hi' }],
  });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest, '--no-record');
  assert(r.status === 1, '空跑应判 FAIL（退出码 1）');
  assert(/存活检查/.test(r.out), '应报告存活检查未通过');
});
check('verify: FAIL — 测试命令退出非 0', () => {
  const rec = writeReceipt('bad.json', {
    task_id: 'relay-task-x', client: 'TestClient', model: 'test-model',
    tool_call_count: 2, changes: [{ path: 'probe.txt', content: 'hi' }],
  });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', 'node -e "process.exit(1)"', '--no-record');
  assert(r.status === 1, '测试失败应判 FAIL');
  assert(/验证失败/.test(r.out), '应报告验证失败');
});
check('verify: FAIL — 拒绝越界写入', () => {
  const rec = writeReceipt('evil.json', {
    task_id: 'relay-task-x', client: 'TestClient', model: 'test-model',
    tool_call_count: 2, changes: [{ path: '../evil.txt', content: 'pwn' }],
  });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest, '--no-record');
  assert(r.status === 1, '越界写入应判 FAIL');
  assert(/越界/.test(r.out), '应报告拒绝越界写入');
  assert(!fs.existsSync(path.join(path.dirname(tmp3), 'evil.txt')), '不应真的写出越界文件');
});
check('verify: FAIL — 破坏性写入守卫（新内容不足原文件一半）', () => {
  const big = path.join(tmp3, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(2000));
  const rec = writeReceipt('shrink.json', {
    task_id: 'relay-task-x', client: 'TestClient', model: 'test-model',
    tool_call_count: 2, changes: [{ path: 'big.md', content: 'tiny' }],
  });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest, '--no-record');
  assert(r.status === 1, '破坏性写入应判 FAIL');
  assert(/破坏性/.test(r.out), '应报告疑似破坏性写入');
});

// 编排器：relay auto（取任务 → 派发 → verify → 通过才应用并移板）
const ECHO = path.join(path.dirname(BIN), '..', 'examples', 'dispatch-echo.mjs');
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test4-'));
const run4 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp4, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe4 = (...args) => { try { return { ok: true, status: 0, out: run4(...args) }; } catch (e) { return { ok: false, status: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
const board4 = () => fs.readFileSync(path.join(tmp4, '.relay', 'board.md'), 'utf8');
const handoff4 = () => fs.readFileSync(path.join(tmp4, '.relay', 'handoff.md'), 'utf8');
const noteTest = `node -e "process.exit(require('fs').existsSync('AUTO-NOTE.md')?0:1)"`;

check('auto: 闭环成功 — 派发→验证→应用→移入已完成', () => {
  run4('init');
  run4('board', 'add', '生成自动笔记');
  const r = runSafe4('auto', '--dispatch', `node ${ECHO}`, '--test', noteTest, '--model', 'none');
  assert(r.status === 0, 'PASS 时退出码应为 0，实际 ' + r.status + '：' + r.out);
  assert(/PASS/.test(r.out), '应打印 PASS');
  assert(fs.existsSync(path.join(tmp4, 'AUTO-NOTE.md')), '验证通过后应把产物应用到真工作树');
  assert(board4().includes('- [x] 生成自动笔记'), '任务应移入已完成');
  assert(/auto:APPLIED/.test(handoff4()), 'handoff 应留 auto:APPLIED 记录');
});
check('auto: 空跑回执被拒 — 不应用、退回待办', () => {
  const bad = path.join(tmp4, 'bad-dispatch.mjs');
  fs.writeFileSync(bad, `import fs from 'node:fs';
const rec = { task_id:'x', client:'Bad', model:'noop', transport:'mcp', tool_call_count:0, changes:[{path:'AUTO-NOTE2.md',content:'nope'}] };
fs.writeFileSync(process.env.RELAY_RECEIPT_OUT, JSON.stringify(rec));
`);
  run4('board', 'add', '空跑任务');
  const r = runSafe4('auto', '--task', '空跑任务', '--dispatch', `node ${bad}`, '--test', noteTest, '--model', 'noop');
  assert(r.status === 1, '空跑应判 FAIL（退出码 1）：' + r.out);
  assert(/存活检查|FAIL/.test(r.out), '应报告存活检查失败');
  assert(!fs.existsSync(path.join(tmp4, 'AUTO-NOTE2.md')), '失败时绝不能应用产物');
  assert(board4().includes('- [ ] 空跑任务'), '任务应退回待办');
  assert(/auto:REJECTED/.test(handoff4()), 'handoff 应留 auto:REJECTED 记录');
});
check('auto: 待办为空时报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test4e-'));
  const re = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: empty, encoding: 'utf8' });
  re('init');
  const r = (() => { try { re('auto', '--dispatch', `node ${ECHO}`); return { ok: true, out: '' }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; } })();
  assert(!r.ok && /待办为空/.test(r.out), '待办为空应报错');
  fs.rmSync(empty, { recursive: true, force: true });
});
check('auto: 缺 --dispatch 时报错', () => {
  run4('board', 'add', '无派发器任务');
  const r = runSafe4('auto', '--task', '无派发器任务');
  assert(r.status === 1 && /--dispatch/.test(r.out), '缺 --dispatch 应报错并提示');
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp3, { recursive: true, force: true });
fs.rmSync(tmp4, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('all tests passed');
