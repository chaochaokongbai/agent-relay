# agent-relay
[![Test](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml/badge.svg)](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml)

> Switch session or client and your AI forgets everything? Hand it a baton.

A zero-dependency Node CLI (Node.js >= 18) that gives any AI agent session a durable work record:
a task board, timestamped signed handoff notes, and a decisions log under `.relay/`.
Paste `relay brief` into any new session or client (DSH, Qoder, WorkBuddy, OpenClaw)
to resume instead of restart; `relay paste` covers chat-only clients (e.g. Doubao).
`relay connect --client <name>` prints ready-to-use config for a shared-memory MCP
server so multiple clients read and write one memory graph.

## Commands (17 checks via `npm test`)

| Command | Effect |
|---|---|
| `relay init [dir]` | Create `.relay/` working directory |
| `relay note <text...> [--who name]` | Append a timestamped signed handoff note |
| `relay decision <text...>` | Append a timestamped signed decision record |
| `relay board add <text...>` | Add a todo entry |
| `relay board done <keyword>` | Move matched task to done (exact match preferred; multi-hit errors) |
| `relay board done --index <n>` | Complete the nth todo by order (1-based) |
| `relay brief [--tail N]` | Output pasteable context brief (default N=15) |
| `relay paste` | Paste template for chat-only clients |
| `relay verify <receipt.json>` | Verify a write-back receipt: liveness check + apply artifacts to a temp copy + run tests; exit code = pass/fail |
| `relay connect --client <name>` | Print shared-memory MCP config for the named client |

See README.md (Chinese) for the full guide, pitfall table, and pain-point sources.

MIT
