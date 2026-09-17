# agent-relay
[![Test](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml/badge.svg)](https://github.com/chaochaokongbai/agent-relay/actions/workflows/test.yml)

> Switch session or client and your AI forgets everything? Hand it a baton.

A zero-dependency Node CLI (Node.js >= 18) that gives any AI agent session a durable work record:
a task board, timestamped signed handoff notes, and a decisions log under `.relay/`.
Paste `relay brief` into any new session or client (DSH, Qoder, WorkBuddy, OpenClaw)
to resume instead of restart; `relay paste` covers chat-only clients (e.g. Doubao).
`relay connect --client <name>` prints ready-to-use config for a shared-memory MCP
server so multiple clients read and write one memory graph.

## Commands (21 checks via `npm test`)

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
| `relay auto --dispatch <cmd>` | Unattended loop: take a todo → dispatch to a headless model → verify the receipt → apply + move to done only on PASS, else revert |
| `relay connect --client <name>` | Print shared-memory MCP config for the named client |

## Local model fallback

`--models` in `examples/auto-multi.mjs` lets you put a local Ollama model first and a cloud model as fallback:

```bash
node examples/auto-multi.mjs \
  --models "ollama/qwen2.5:7b,minimax/MiniMax-M2.7" \
  --dispatch "node examples/dispatch-openclaw.mjs"
```

The `relay` profile ships with a built-in `ollama` provider pointing to `127.0.0.1:11434`. Local models work offline without consuming cloud quota; cloud models kick in when local capacity is unavailable.

**Failover & auth gotcha**: if a provider's credentials expire (e.g. MiniMax throws `No API key`), the verification gate rejects that model's receipt and `auto-multi` automatically falls through to the next model in the list. Re-authenticate with:

```bash
openclaw --profile relay models auth paste-api-key --provider <name>
```

Once re-authenticated, the next `auto-multi` run resumes normally.

See README.md (Chinese) for the full guide, pitfall table, and pain-point sources.

MIT
