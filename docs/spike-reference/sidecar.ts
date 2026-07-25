// chatmux SSE sidecar — connects to chatmux MCP server, streams notifications to stdout as JSON lines
// Usage: bun run chatmux-sidecar.ts [chat_id]
// Output: one JSON line per event to stdout. Logs to stderr.

const SOCKET = process.env.CHATMUX_SOCKET ?? `${process.env.HOME}/.local/share/chatmux/chatmux.sock`;
const URL = "http://localhost/mcp";

let sessionId: string | null = null;

async function mcpRequest(method: string, params: any, id?: number) {
  const body: any = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;

  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    unix: SOCKET,
  } as any);

  if (!sessionId) {
    sessionId = res.headers.get("mcp-session-id");
  }

  if (id !== undefined) {
    const text = await res.text();
    // Parse SSE format: "event: message\ndata: {...}"
    const dataMatch = text.match(/^data: (.+)$/m);
    if (dataMatch) return JSON.parse(dataMatch[1]);
    return JSON.parse(text);
  }

  return null;
}

async function fetchMessages(chatId: string, limit = 20) {
  const result = await mcpRequest("tools/call", {
    name: "read_messages",
    arguments: { chat_id: chatId, limit },
  }, Math.floor(Math.random() * 100000));
  const content = result?.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : null;
}

async function main() {
  const chatId = process.argv[2];

  // 1. Initialize
  console.error("[sidecar] initializing MCP connection...");
  await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "chatmux-nvim-sidecar", version: "0.1" },
  }, 1);
  console.error(`[sidecar] session: ${sessionId}`);

  // 2. Send initialized notification
  await mcpRequest("notifications/initialized", {});

  // 3. If chat_id given, fetch initial messages
  if (chatId) {
    console.error(`[sidecar] fetching initial messages for ${chatId}...`);
    const data = await fetchMessages(chatId, 50);
    if (data) {
      // Reverse to chronological order (API returns newest-first)
      if (data.messages) data.messages.reverse();
      console.log(JSON.stringify({ type: "init", chat_id: chatId, data }));
    }
  }

  // 4. Open SSE stream
  console.error("[sidecar] opening SSE stream...");
  const sseRes = await fetch(URL, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "mcp-session-id": sessionId!,
    },
    unix: SOCKET,
  } as any);

  if (!sseRes.body) {
    console.error("[sidecar] ERROR: no SSE body");
    process.exit(1);
  }

  console.error("[sidecar] SSE connected, waiting for notifications...");

  // 5. Parse SSE events
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const json = line.slice(6);
        try {
          const msg = JSON.parse(json);
          if (msg.method === "notifications/resources/updated") {
            const uri = msg.params?.uri ?? "";
            const ts = Date.now();
            console.error(`[sidecar] resource updated: ${uri} at ${ts}`);

            // If it's a messages resource and matches our chat, fetch new messages
            if (chatId && uri.includes(chatId) && uri.includes("/messages")) {
              const data = await fetchMessages(chatId, 5);
              if (data) {
                console.log(JSON.stringify({ type: "update", chat_id: chatId, ts, data }));
              }
            } else {
              // Generic notification
              console.log(JSON.stringify({ type: "notification", uri, ts }));
            }
          }
        } catch {}
      }
    }
  }
}

main().catch((err) => {
  console.error("[sidecar] fatal:", err);
  process.exit(1);
});
