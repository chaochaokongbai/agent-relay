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

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('all tests passed');
