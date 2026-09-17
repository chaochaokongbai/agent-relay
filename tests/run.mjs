import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeVerify, isSensitivePath, checkNonCodeDestructive, isCodeFile } from '../bin/relay.mjs';

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

// --- 守卫函数单元测试 ---

check('isSensitivePath: 命中 tests/', () => {
  assert(isSensitivePath('tests/some.mjs') === true, 'tests/ 应命中');
});
check('isSensitivePath: 命中 .github/', () => {
  assert(isSensitivePath('.github/workflows/evil.yml') === true, '.github/ 应命中');
});
check('isSensitivePath: 命中 .relay/', () => {
  assert(isSensitivePath('.relay/evil.md') === true, '.relay/ 应命中');
});
check('isSensitivePath: 命中 package.json', () => {
  assert(isSensitivePath('package.json') === true, 'package.json 应命中');
});
check('isSensitivePath: 非敏感路径不命中', () => {
  assert(isSensitivePath('bin/relay.mjs') === false, 'bin/relay.mjs 不应命中');
  assert(isSensitivePath('README.md') === false, 'README.md 不应命中');
  assert(isSensitivePath('examples/dispatch-openclaw.mjs') === false, 'examples/ 下非敏感不命中');
});

check('isCodeFile: 正确识别代码文件', () => {
  assert(isCodeFile('a.mjs') === true, '.mjs 应为代码文件');
  assert(isCodeFile('a.js') === true, '.js 应为代码文件');
  assert(isCodeFile('a.cjs') === true, '.cjs 应为代码文件');
  assert(isCodeFile('a.ts') === true, '.ts 应为代码文件');
  assert(isCodeFile('a.MJS') === true, '.MJS 大写按小写归一，应视为代码文件');
});
check('isCodeFile: 非代码文件', () => {
  assert(isCodeFile('a.md') === false, '.md 非代码文件');
  assert(isCodeFile('a.json') === false, '.json 非代码文件');
  assert(isCodeFile('a.yml') === false, '.yml 非代码文件');
});

check('checkNonCodeDestructive: 删非空行 → 有破坏', () => {
  const orig = '## 标题\n\n这是内容。\n\n- 列项1\n- 列项2\n';
  const neo = '## 标题\n\n这是内容。\n';
  assert(checkNonCodeDestructive(orig, neo) !== null, '删除非空行应有破坏报告');
});
check('checkNonCodeDestructive: 纯增量（只加行）→ 无破坏', () => {
  const orig = '## 标题\n\n原有内容。\n';
  const neo = '## 标题\n\n原有内容。\n\n新增段落。\n';
  assert(checkNonCodeDestructive(orig, neo) === null, '纯增量应无破坏');
});
check('checkNonCodeDestructive: 只删空行 → 无破坏', () => {
  const orig = '## 标题\n\n内容A\n\n内容B\n';
  const neo = '## 标题\n内容A\n内容B\n';
  assert(checkNonCodeDestructive(orig, neo) === null, '删空行应无破坏');
});
check('checkNonCodeDestructive: 空白 trim 后相同不算删除', () => {
  const orig = '## 标题  \n内容  \n';
  const neo = '## 标题\n内容\n';
  assert(checkNonCodeDestructive(orig, neo) === null, 'trim后相同不算删除');
});

// --- executeVerify 直接调用（严格模式）---
function makeReceipt(changes) {
  return { task_id: 'test', client: 'Test', model: 'm', transport: 'mcp', tool_call_count: 2, changes };
}
function runVerifyStrict(receipt, projectDir) {
  return executeVerify(receipt, projectDir, 'node -e process.exit(0)', { strict: true });
}
function runVerifyManual(receipt, projectDir, onSensitive) {
  return executeVerify(receipt, projectDir, 'node -e process.exit(0)', { strict: false, onSensitive });
}

const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-verify-unit-'));
fs.mkdirSync(path.join(tmpS, '.relay'), { recursive: true });
fs.writeFileSync(path.join(tmpS, '.relay', 'relay.json'), '{}');
fs.writeFileSync(path.join(tmpS, '.relay', 'board.md'), boardTemplate());
fs.writeFileSync(path.join(tmpS, '.relay', 'handoff.md'), '# 交接记录\n');

function boardTemplate() {
  return '# 任务板\n\n## 待办\n\n## 进行中\n\n## 已完成\n';
}

check('executeVerify: 严格模式拒绝敏感路径 tests/', () => {
  const r = runVerifyStrict(makeReceipt([{ path: 'tests/some.mjs', content: '// hi' }]), tmpS);
  assert(r.ok === false && /敏感路径/.test(r.reason), '严格模式应拒绝 tests/：' + r.reason);
});
check('executeVerify: 严格模式拒绝 package.json', () => {
  const r = runVerifyStrict(makeReceipt([{ path: 'package.json', content: '{}' }]), tmpS);
  assert(r.ok === false && /敏感路径/.test(r.reason), '严格模式应拒绝 package.json：' + r.reason);
});
check('executeVerify: 严格模式拒绝 .github/', () => {
  const r = runVerifyStrict(makeReceipt([{ path: '.github/workflows/evil.yml', content: 'runs: []' }]), tmpS);
  assert(r.ok === false && /敏感路径/.test(r.reason), '严格模式应拒绝 .github/：' + r.reason);
});
check('executeVerify: 严格模式拒绝 .relay/', () => {
  const r = runVerifyStrict(makeReceipt([{ path: '.relay/evil.md', content: 'pwn' }]), tmpS);
  assert(r.ok === false && /敏感路径/.test(r.reason), '严格模式应拒绝 .relay/：' + r.reason);
});
check('executeVerify: 严格模式放行非敏感路径', () => {
  const r = runVerifyStrict(makeReceipt([{ path: 'brand-new.md', content: '# 新文档\n\n内容。\n' }]), tmpS);
  assert(r.ok === true, '非敏感路径应 PASS：' + (r.reason || ''));
});

const auditPaths = [];
check('executeVerify: manual 模式放行敏感路径 + 审计回调', () => {
  const r = runVerifyManual(makeReceipt([{ path: 'tests/manual-test.mjs', content: '// manual mode' }]), tmpS, (paths) => auditPaths.push(...paths));
  assert(r.ok === true, 'manual 模式应放行：' + (r.reason || ''));
  assert(auditPaths.length > 0 && auditPaths[0].includes('tests/'), '应触发审计回调：' + JSON.stringify(auditPaths));
});

check('executeVerify: 非代码文件删非空行 → FAIL', () => {
  const docPath = path.join(tmpS, 'doc.md');
  fs.writeFileSync(docPath, '## 标题\n\n这是内容。\n\n- 列项1\n- 列项2\n');
  const r = runVerifyStrict(makeReceipt([{ path: 'doc.md', content: '## 标题\n\n这是内容。\n' }]), tmpS);
  assert(r.ok === false && /非代码文件/.test(r.reason), '删非空行应 FAIL：' + r.reason);
});
check('executeVerify: 非代码文件纯增量 → PASS', () => {
  const docPath = path.join(tmpS, 'doc2.md');
  fs.writeFileSync(docPath, '## 标题\n\n原有内容。\n');
  const r = runVerifyStrict(makeReceipt([{ path: 'doc2.md', content: '## 标题\n\n原有内容。\n\n新增段落。\n' }]), tmpS);
  assert(r.ok === true, '纯增量应 PASS：' + (r.reason || ''));
});
check('executeVerify: 非代码文件新建 → PASS（无原文件可比较）', () => {
  const r = runVerifyStrict(makeReceipt([{ path: 'brand-new.md', content: '# 新文档\n\n内容。\n' }]), tmpS);
  assert(r.ok === true, '新建非代码文件应 PASS：' + (r.reason || ''));
});
check('executeVerify: 代码文件字节数 >50% → PASS', () => {
  const bigPath = path.join(tmpS, 'big.mjs');
  const lines = Array.from({ length: 55 }, (_, i) => `// line ${i + 1} content here`);
  fs.writeFileSync(bigPath, lines.join('\n') + '\n');
  const r = runVerifyStrict(makeReceipt([{ path: 'big.mjs', content: lines.slice(0, 30).join('\n') + '\n' }]), tmpS);
  assert(r.ok === true, '代码文件>50%字节应 PASS：' + (r.reason || ''));
});

fs.rmSync(tmpS, { recursive: true, force: true });

// --- CLI 集成测试 ---
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

// 回归测试：board done 缺陷
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test2-'));
const run2 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp2, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe2 = (...args) => { try { return { ok: true, out: run2(...args) }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; } };
const board2 = () => fs.readFileSync(path.join(tmp2, '.relay', 'board.md'), 'utf8');

check('done: 重名多命中 → 报错且不误删', () => {
  run2('init');
  run2('board', 'add', '修 login 超时');
  run2('board', 'add', '修 login 日志');
  const r = runSafe2('board', 'done', 'login');
  assert(!r.ok, '多命中时应报错');
  assert(/--index/.test(r.out) && /2 条/.test(r.out), '应提示 --index');
  const b = board2();
  assert(b.includes('- [ ] 修 login 超时') && b.includes('- [ ] 修 login 日志'), '不应移动');
});
check('done: --index 精确定位第二条', () => {
  run2('board', 'done', '--index', '2');
  const b = board2();
  assert(b.includes('- [x] 修 login 超时'), '--index 2 应完成第二条');
  assert(b.includes('- [ ] 修 login 日志'), '第一条应保留');
});
check('done: 精确匹配优先于子串', () => {
  run2('board', 'add', '登录超时');
  run2('board', 'add', '超时');
  run2('board', 'done', '超时');
  const b = board2();
  assert(b.includes('- [x] 超时'), '应完成精确匹配的「超时」');
  assert(b.includes('- [ ] 登录超时'), '「登录超时」应保留');
});
check('done: 成功日志回显条目原文', () => {
  run2('board', 'add', '回显校验任务');
  const out = run2('board', 'done', '回显校验任务');
  assert(out.includes('回显校验任务'), '应回显原文');
});
check('done: 缺「## 已完成」节也能正确追加', () => {
  const bp = path.join(tmp2, '.relay', 'board.md');
  fs.writeFileSync(bp, board2().replace('## 已完成', ''));
  run2('board', 'add', '临时任务');
  const r = runSafe2('board', 'done', '临时任务');
  assert(r.ok, '应成功完成: ' + r.out);
  const nb = board2();
  assert(!nb.startsWith('- [x]'), '不应落到文件头');
  assert(nb.includes('## 已完成'), '应补上「## 已完成」');
});
check('done: 缩进子任务也能识别', () => {
  const bp = path.join(tmp2, '.relay', 'board.md');
  const lines = board2().split('\n');
  const i = lines.findIndex((l) => l.trimEnd() === '## 待办');
  lines.splice(i + 1, 0, '  - [ ] 缩进的子任务');
  fs.writeFileSync(bp, lines.join('\n'));
  const r = runSafe2('board', 'done', '缩进的子任务');
  assert(r.ok, '应能完成缩进子任务: ' + r.out);
  assert(board2().includes('- [x] 缩进的子任务'), '应标记完成');
});

// verify CLI 测试
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test3-'));
const run3 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp3, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe3 = (...args) => { try { return { ok: true, status: 0, out: run3(...args) }; } catch (e) { return { ok: false, status: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
const writeReceipt3 = (name, obj) => { const p = path.join(tmp3, name); fs.writeFileSync(p, JSON.stringify(obj)); return name; };
const existsTest3 = `node -e "process.exit(require('fs').existsSync('probe.txt')?0:1)"`;

check('verify: PASS — 产物应用且测试通过', () => {
  run3('init');
  const rec = writeReceipt3('ok.json', { task_id: 'x', client: 'C', model: 'm', tool_call_count: 3, changes: [{ path: 'probe.txt', content: 'hi' }] });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest3);
  assert(r.status === 0, 'PASS 时退出码应为 0，实际 ' + r.status + '：' + r.out);
  const handoff = fs.readFileSync(path.join(tmp3, '.relay', 'handoff.md'), 'utf8');
  assert(/verify:PASS/.test(handoff), '应留 verify:PASS 记录');
});
check('verify: FAIL — 存活检查拦截 tool_call_count=0', () => {
  const rec = writeReceipt3('dead.json', { task_id: 'x', client: 'C', model: 'm', tool_call_count: 0, changes: [{ path: 'p.txt', content: 'x' }] });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest3, '--no-record');
  assert(r.status === 1 && /存活检查/.test(r.out), '空跑应 FAIL：' + r.out);
});
check('verify: FAIL — 测试命令退出非 0', () => {
  const rec = writeReceipt3('bad.json', { task_id: 'x', client: 'C', model: 'm', tool_call_count: 2, changes: [{ path: 'p.txt', content: 'x' }] });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', 'node -e process.exit(1)', '--no-record');
  assert(r.status === 1 && /验证失败/.test(r.out), '测试失败应 FAIL');
});
check('verify: FAIL — 越界写入', () => {
  const rec = writeReceipt3('evil.json', { task_id: 'x', client: 'C', model: 'm', tool_call_count: 2, changes: [{ path: '../evil.txt', content: 'pwn' }] });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest3, '--no-record');
  assert(r.status === 1 && /越界/.test(r.out), '越界应 FAIL');
  assert(!fs.existsSync(path.join(path.dirname(tmp3), 'evil.txt')), '不应真的写出越界文件');
});
check('verify: FAIL — 代码文件破坏性写入（<50%）', () => {
  const big = path.join(tmp3, 'big.mjs');
  fs.writeFileSync(big, 'x'.repeat(2000));
  const rec = writeReceipt3('shrink.json', { task_id: 'x', client: 'C', model: 'm', tool_call_count: 2, changes: [{ path: 'big.mjs', content: 'tiny' }] });
  const r = runSafe3('verify', rec, '--project', tmp3, '--test', existsTest3, '--no-record');
  assert(r.status === 1 && /破坏性/.test(r.out), '代码文件<50%应 FAIL：' + r.out);
});

// --allow-sensitive: auto 本轮放行敏感路径但写审计日志
const tmp4as = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test4as-'));
const run4as = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp4as, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe4as = (...args) => { try { return { ok: true, status: 0, out: run4as(...args) }; } catch (e) { return { ok: false, status: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
const ECHO = path.join(path.dirname(BIN), '..', 'examples', 'dispatch-echo.mjs');
const noteTest4as = `node -e "process.exit(require('fs').existsSync('tests/allow-sens-probe.txt')?0:1)"`;

check('auto --allow-sensitive: 放行敏感路径且写审计日志', () => {
  run4as('init');
  run4as('board', 'add', 'allow-sensitive 测试');
  const dispatcher = path.join(tmp4as, 'dispatch-as.mjs');
  fs.writeFileSync(dispatcher, `import fs from 'node:fs';\nconst rec = { task_id:'x', client:'AllowSens', model:'test', transport:'mcp', tool_call_count:1, changes:[{path:'tests/allow-sens-probe.txt',content:'allowed'}] };\nfs.writeFileSync(process.env.RELAY_RECEIPT_OUT, JSON.stringify(rec));\n`);
  const r = runSafe4as('auto', '--dispatch', `node "${dispatcher}"`, '--test', noteTest4as, '--model', 'test', '--allow-sensitive');
  assert(r.status === 0, '--allow-sensitive 应放行，实际 ' + r.status + '：' + r.out);
  const handoff = fs.readFileSync(path.join(tmp4as, '.relay', 'handoff.md'), 'utf8');
  assert(/allow-sensitive/.test(handoff) && /放行敏感路径/.test(handoff), '应写审计日志：' + handoff);
});

// auto CLI 闭环测试
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test4-'));
const run4 = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: tmp4, encoding: 'utf8', env: { ...process.env, RELAY_WHO: 'tester' } });
const runSafe4 = (...args) => { try { return { ok: true, status: 0, out: run4(...args) }; } catch (e) { return { ok: false, status: e.status, out: (e.stdout || '') + (e.stderr || '') }; } };
const board4 = () => fs.readFileSync(path.join(tmp4, '.relay', 'board.md'), 'utf8');
const handoff4 = () => fs.readFileSync(path.join(tmp4, '.relay', 'handoff.md'), 'utf8');
const noteTest = `node -e "process.exit(require('fs').existsSync('AUTO-NOTE.md')?0:1)"`;

check('auto: 闭环成功 — 派发→验证→应用→移入已完成', () => {
  run4('init');
  run4('board', 'add', '生成自动笔记');
  const r = runSafe4('auto', '--dispatch', `node "${ECHO}"`, '--test', noteTest, '--model', 'none');
  assert(r.status === 0, 'PASS 时退出码应为 0，实际 ' + r.status + '：' + r.out);
  assert(fs.existsSync(path.join(tmp4, 'AUTO-NOTE.md')), '验证通过后应把产物应用到真工作树');
  assert(board4().includes('- [x] 生成自动笔记'), '任务应移入已完成');
  assert(/auto:APPLIED/.test(handoff4()), 'handoff 应留 auto:APPLIED 记录');
});
check('auto: 空跑回执被拒 — 不应用、退回待办', () => {
  const bad = path.join(tmp4, 'bad-dispatch.mjs');
  fs.writeFileSync(bad, `import fs from 'node:fs';\nconst rec = { task_id:'x', client:'Bad', model:'noop', transport:'mcp', tool_call_count:0, changes:[{path:'AUTO-NOTE2.md',content:'nope'}] };\nfs.writeFileSync(process.env.RELAY_RECEIPT_OUT, JSON.stringify(rec));\n`);
  run4('board', 'add', '空跑任务');
  const r = runSafe4('auto', '--task', '空跑任务', '--dispatch', `node "${bad}"`, '--test', noteTest, '--model', 'noop');
  assert(r.status === 1, '空跑应判 FAIL：' + r.out);
  assert(/存活检查|FAIL/.test(r.out), '应报告存活检查失败');
  assert(!fs.existsSync(path.join(tmp4, 'AUTO-NOTE2.md')), '失败时绝不能应用产物');
  assert(board4().includes('- [ ] 空跑任务'), '任务应退回待办');
  assert(/auto:REJECTED/.test(handoff4()), 'handoff 应留 auto:REJECTED 记录');
});
check('auto: 待办为空时报错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test4e-'));
  const re = (...a) => execFileSync(process.execPath, [BIN, ...a], { cwd: empty, encoding: 'utf8' });
  re('init');
  const r = (() => { try { re('auto', '--dispatch', `node "${ECHO}"`); return { ok: true, out: '' }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; } })();
  assert(!r.ok && /待办为空/.test(r.out), '待办为空应报错');
  fs.rmSync(empty, { recursive: true, force: true });
});
check('auto: 缺 --dispatch 时报错', () => {
  run4('board', 'add', '无派发器任务');
  const r = runSafe4('auto', '--task', '无派发器任务');
  assert(r.status === 1 && /--dispatch/.test(r.out), '缺 --dispatch 应报错');
});

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp3, { recursive: true, force: true });
fs.rmSync(tmp4, { recursive: true, force: true });
fs.rmSync(tmp4as, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('all tests passed');
