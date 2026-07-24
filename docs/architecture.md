# Architecture

chat.nvim is a three-layer system: **Lua plugin** (UI + state) ↔ **Bun sidecar** (MCP client + IPC bridge) ↔ **chatmux daemon** (data layer).

## Three-layer topology

```
┌──────────────────────────┐
│     Neovim (Lua plugin)  │
│                          │
│  ┌──────────┐ ┌────────┐ │
│  │ State    │ │ UI     │ │
│  │ chats,   │ │ 3-panel│ │
│  │ messages,│ │ chat   │ │
│  │ last_read│ │ list + │ │
│  │          │ │ msgs + │ │
│  └──────────┘ │composer│ │
│               └────────┘ │
│  ┌──────────────────────┐│
│  │ Sidecar lifecycle    ││
│  │ jobstart + on_stdout ││
│  └──────────────────────┘│
└────────────┬─────────────┘
             │ stdin/stdout JSON lines
             │ (one JSON object per \n)
┌────────────┴─────────────┐
│     Bun sidecar (TS)     │
│                          │
│  ┌──────────┐ ┌────────┐ │
│  │ MCP      │ │ Sub-   │ │
│  │ Client   │ │ scribe │ │
│  │ 5 tools  │ │ mgr    │ │
│  └──────────┘ └────────┘ │
└────────────┬─────────────┘
             │ MCP Streamable HTTP
             │ (HTTP/1.1 + SSE)
             │ unix socket
┌────────────┴─────────────┐
│    chatmux daemon        │
│    (Storage + Adapters)  │
└──────────────────────────┘
```

## Component responsibilities

| Component | Responsibility | Does NOT do |
|-----------|---------------|-------------|
| **Lua plugin** | UI rendering, keymaps, state management, sidecar lifecycle, client-side unread tracking | MCP protocol, HTTP, socket I/O |
| **Bun sidecar** | MCP client (connect, tool calls, subscription), JSON lines IPC with Lua, SSE stream parsing | UI, nvim API, state persistence |
| **chatmux daemon** | Message storage (JSONL+SQLite), adapter management, MCP server, safety rail | UI, consumer-side logic |

## Data flow

### Sending a message (user → recipient)

```
User types in composer → <CR>
  → Lua: composer.lua sends text to sidecar.send("send_message", {chat_id, text})
  → stdin JSON line: {"id": N, "method": "send_message", "params": {...}}
  → Sidecar: MCP tools/call → daemon → adapter → LINE API → recipient
  → Sidecar: stdout JSON line: {"id": N, "result": {"success": true}}
  → Lua: callback fires, composer closes
```

### Receiving a message (sender → user's Neovim)

```
Sender sends via LINE app
  → LINE Messaging API webhook → LINE adapter → chatmux daemon stores message
  → Daemon emits notifications/resources/updated for chat://chats/{id}/messages
  → Sidecar SSE stream receives notification
  → Sidecar fetches updated resource via MCP
  → stdout JSON line: {"id": null, "method": "resource_updated", "params": {"uri": "...", "messages": [...]}}
  → Lua: on_stdout parses → state.update_messages() → ui.messages.append()
  → Buffer updated without flicker (cursor save/restore + at_bottom check)
```

## Sidecar lifecycle

1. **Start**: Lua calls `vim.fn.jobstart({'bun', 'run', sidecar_path})` on first `:ChatList`
2. **Initialize**: Sidecar connects to daemon via unix socket, performs MCP handshake
3. **Subscribe**: Subscribes to `chat://chats` and `chat://status` resources
4. **Run**: Reads stdin for requests, dispatches to MCP, writes responses to stdout. SSE stream delivers push notifications to stdout.
5. **Dynamic subscribe**: On `read_messages` request, auto-subscribes to that chat's messages resource
6. **Crash recovery**: Lua `on_exit` callback auto-restarts sidecar (max 3 times, increasing delay)
7. **Stop**: `:ChatClose` or Neovim exit → `vim.fn.jobstop(job_id)`

## Why not MCPHub.nvim

MCPHub.nvim was evaluated in E2 spike and rejected for two reasons:
1. No unix socket transport support (only TCP/HTTP)
2. No per-resource subscription support (only handles `list-changed`, not `content-updated`)

The custom Bun sidecar fills this gap with direct unix socket MCP client + full subscription management.
