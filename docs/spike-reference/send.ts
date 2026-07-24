// chatmux send_message — one-shot MCP tool call over unix socket
// Usage: bun run chatmux-send.ts <chat_id> <text>
const SOCKET = "/home/matt/.local/share/chatmux/chatmux.sock";
const URL = "http://localhost/mcp";

async function main() {
  const chatId = process.argv[2];
  const text = process.argv.slice(3).join(" ");
  if (!chatId || !text) {
    console.error("Usage: bun run chatmux-send.ts <chat_id> <text>");
    process.exit(1);
  }

  // Initialize
  const initRes = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "chatmux-send", version: "0.1" },
      },
    }),
    unix: SOCKET,
  } as any);

  const sessionId = initRes.headers.get("mcp-session-id");
  await initRes.text();

  // Initialized notification
  await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    unix: SOCKET,
  } as any);

  // Send message
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "send_message", arguments: { chat_id: chatId, text } },
    }),
    unix: SOCKET,
  } as any);

  const body = await res.text();
  const dataMatch = body.match(/^data: (.+)$/m);
  const result = dataMatch ? JSON.parse(dataMatch[1]) : JSON.parse(body);
  const content = result?.result?.content?.[0]?.text;
  if (content) {
    const parsed = JSON.parse(content);
    if (parsed.success) {
      console.log(JSON.stringify({ ok: true }));
    } else {
      console.error(JSON.stringify({ ok: false, error: parsed.error, detail: parsed.detail }));
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("send failed:", err.message);
  process.exit(1);
});
