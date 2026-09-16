# agent-relay

> Switch session or client and your AI forgets everything? Hand it a baton.

A zero-dependency Node CLI that gives any AI agent session a durable work record:
a task board, timestamped signed handoff notes, and a decisions log under `.relay/`.
Paste `relay brief` into any new session or client (DSH, Qoder, WorkBuddy, OpenClaw)
to resume instead of restart; `relay paste` covers chat-only clients (e.g. Doubao).
`relay connect --client <name>` prints ready-to-use config for a shared-memory MCP
server so multiple clients read and write one memory graph.

See README.md (Chinese) for the full guide, pitfall table, and pain-point sources.

MIT
