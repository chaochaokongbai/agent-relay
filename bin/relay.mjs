#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = '.relay';

const HELP = `relay — 接力棒：给 AI Agent 会话一份持久工作记录

用法:
  relay init [dir]              在 dir（默认当前目录）创建 .relay/ 工作记录
  relay note <text...>          追加一条带时间戳的交接记录（--who 署名）
  relay board add <text...>     任务板「待办」加一条
  relay board done <keyword>    把含 keyword 的任务移到「已完成」
  relay brief [--tail N]        输出可粘贴进新会话/新客户端的上下文简报（默认 N=15）
  relay paste                   输出纯聊天客户端（豆包等）用的粘贴模板
  relay connect --client <name> 输出该客户端接入共享记忆 MCP 的配置
                                name: qoder | workbuddy | openclaw | dsh | doubao
  relay help                    本帮助

环境变量:
  RELAY_WHO    默认署名（如 "Qoder/claude"），等价于 --who
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

function cmdBoard(args) {
  const root = rootOrFail();
  const sub = args.shift();
  const p = path.join(root, RELAY_DIR, 'board.md');
  let content = read(p) || boardTemplate();
  if (sub === 'add') {
    const text = args.join(' ').trim();
    if (!text) fail('board add 需要内容');
    const lines = content.split('\n');
    const i = lines.indexOf('## 待办');
    if (i === -1) fail('任务板缺少「## 待办」节');
    lines.splice(i + 1, 0, `- [ ] ${text}`);
    fs.writeFileSync(p, lines.join('\n'));
    console.log('relay: 已加入待办');
  } else if (sub === 'done') {
    const kw = args.join(' ').trim();
    if (!kw) fail('board done 需要关键词');
    const lines = content.split('\n');
    const ti = lines.findIndex((l) => l.startsWith('- [ ]') && l.includes(kw));
    if (ti === -1) fail(`待办里找不到含「${kw}」的条目`);
    const [line] = lines.splice(ti, 1);
    const di = lines.indexOf('## 已完成');
    lines.splice(di + 1, 0, line.replace('- [ ]', '- [x]') + `（${stamp()} 完成）`);
    fs.writeFileSync(p, lines.join('\n'));
    console.log('relay: 已移到已完成');
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
  case 'board': cmdBoard(rest); break;
  case 'brief': cmdBrief(rest); break;
  case 'paste': cmdPaste(rest); break;
  case 'connect': cmdConnect(rest); break;
  case 'help': case undefined: case '--help': case '-h': console.log(HELP); break;
  default: fail(`未知命令 ${cmd}，运行 relay help`);
}
