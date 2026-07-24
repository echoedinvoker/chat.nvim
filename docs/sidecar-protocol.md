# Sidecar Protocol

JSON lines protocol between Neovim (Lua) and the Bun sidecar process. One JSON object per line, delimited by `\n`.

## Message types

### Request (Lua → Sidecar, via stdin)

```json
{"id": <integer>, "method": "<method_name>", "params": {<method_params>}}
```

- `id`: Non-null integer, used to correlate response. Lua maintains a monotonically increasing counter.
- `method`: One of the supported methods (see below).
- `params`: Method-specific parameters object.

### Response (Sidecar → Lua, via stdout)

```json
{"id": <integer>, "result": <result_data>}
```

or on error:

```json
{"id": <integer>, "error": {"message": "<error_description>"}}
```

- `id`: Matches the request `id`.
- `result`: Method-specific result data (see below).
- `error`: Present instead of `result` on failure.

### Notification (Sidecar → Lua, via stdout)

```json
{"id": null, "method": "<notification_type>", "params": {<notification_data>}}
```

- `id`: Always `null` — distinguishes notifications from responses.
- `method`: Notification type (see below).

## Supported methods (Lua → Sidecar)

| Method | Params | Result | Notes |
|--------|--------|--------|-------|
| `list_chats` | `{platform?, query?, limit?, cursor?}` | `{chats: Chat[]}` | Lists all chats. Optional filters. |
| `read_messages` | `{chat_id, limit?, before?, after?}` | `{messages: Message[]}` | Reads messages. `before`/`after` are epoch ms. **Side effect**: sidecar auto-subscribes to this chat's messages resource. |
| `send_message` | `{chat_id, text}` | `{success: boolean, error?}` | Sends a text message via chatmux daemon. |
| `search_messages` | `{query, platform?, chat_id?, limit?}` | `{messages: Message[]}` | FTS5 trigram search. |
| `get_status` | `{}` | `{daemon: StatusObj}` | Returns daemon + adapter connection status. |
| `close_chat` | `{chat_id}` | `{}` | Unsubscribes from chat's messages resource. Lua sends this when user navigates away from a chat. |

### Chat object

```typescript
{
  id: string            // e.g. "line:Uxxxxx"
  name: string          // Display name
  platform: string      // e.g. "line"
  last_message_time?: number  // Epoch ms of most recent message
}
```

### Message object

```typescript
{
  id: string            // Platform message ID
  chat_id: string
  sender_name: string
  text: string          // Message content (stickers: "[sticker:pkg/id]", images: "[image]")
  timestamp: number     // Epoch ms (LINE's createdTime)
  is_self: boolean      // true if sent by the user
}
```

## Notification types (Sidecar → Lua)

| Method | Params | When |
|--------|--------|------|
| `resource_updated` | `{uri: string}` | A subscribed MCP resource changed. Lua should re-fetch if relevant. |
| `connected` | `{}` | Sidecar successfully connected to chatmux daemon. |
| `disconnected` | `{reason: string}` | Connection to daemon lost. |
| `error` | `{message: string}` | Non-fatal error (e.g. subscription failure). |

## Sidecar as MCP client

The sidecar is a standard MCP Streamable HTTP client connecting over unix socket.

### Connection flow

1. HTTP POST to `http://localhost/mcp` with `unix` socket option (`$CHATMUX_SOCKET`)
2. MCP `initialize` request → receive session ID from `mcp-session-id` response header
3. Send `notifications/initialized`
4. Open SSE stream: HTTP GET with `Accept: text/event-stream` + session ID header
5. SSE stream delivers `notifications/resources/updated` events

### Subscription management

**Startup subscriptions**: After MCP handshake, sidecar subscribes to:
- `chat://chats` (chat list changes)
- `chat://status` (daemon/adapter status)

**Dynamic subscriptions**: When sidecar processes a `read_messages` request, it checks `subscribedUris: Set<string>`. If the chat's messages URI is not yet subscribed, it calls MCP `resources/subscribe` for `chat://chats/{chat_id}/messages`.

**Unsubscribe**: On `close_chat` from Lua, sidecar calls MCP `resources/unsubscribe` and removes from set.

**Fallback**: If daemon returns error on `resources/subscribe` (not supported), sidecar degrades to passive mode — receives all SSE notifications and filters client-side by URI string matching (E2 spike behavior).

### SSE event handling

```
SSE data line → JSON parse → check method
  → "notifications/resources/updated"
    → extract uri from params
    → if uri in subscribedUris: fetch resource, emit stdout notification
    → else: emit generic notification
```

## Error handling

- **JSON parse failure on stdin**: Log to stderr, skip the line, do not crash.
- **MCP request failure**: Return `{"id": N, "error": {"message": "..."}}` to Lua.
- **SSE stream disconnection**: Emit `disconnected` notification, attempt reconnect.
- **Socket not found**: Emit `error` notification with clear message, exit with non-zero code.
