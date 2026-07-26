import { McpClient, shouldUseListAll } from "./mcp-client.ts";
import { SubscriptionManager } from "./subscription.ts";
import type { ListChatsParams, Request, RequestMethod } from "./types.ts";

function emit(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

function emitResponse(id: number, result: unknown): void {
  emit({ id, result });
}

function emitError(id: number, message: string): void {
  emit({ id, error: { message } });
}

function emitNotification(method: string, params: Record<string, unknown>): void {
  emit({ id: null, method, params });
}

const METHODS: Set<RequestMethod> = new Set([
  "list_chats",
  "read_messages",
  "send_message",
  "search_messages",
  "get_status",
  "close_chat",
]);

export async function dispatch(
  client: McpClient,
  subMgr: SubscriptionManager,
  req: Request
): Promise<unknown> {
  switch (req.method) {
    case "list_chats": {
      const params = req.params as ListChatsParams;
      return shouldUseListAll(params)
        ? client.listAllChats()
        : client.listChats(params);
    }
    case "read_messages": {
      const params = req.params as { chat_id: string; limit?: number; before?: number; after?: number };
      await subMgr.subscribeChat(params.chat_id);
      return client.readMessages(params);
    }
    case "send_message":
      return client.sendMessage(req.params as any);
    case "search_messages":
      return client.searchMessages(req.params as any);
    case "get_status":
      return client.getStatus();
    case "close_chat": {
      const params = req.params as { chat_id: string };
      await subMgr.unsubscribeChat(params.chat_id);
      return {};
    }
    default:
      throw new Error(`Unknown method: ${req.method}`);
  }
}

function parseRequest(line: string): Request | null {
  const obj = JSON.parse(line);
  if (typeof obj.id !== "number" || typeof obj.method !== "string") return null;
  if (!METHODS.has(obj.method as RequestMethod)) return null;
  return obj as Request;
}

async function main(): Promise<void> {
  const client = new McpClient();

  console.error("[sidecar] connecting to chatmux daemon...");
  await client.connect();
  console.error("[sidecar] connected");

  const subMgr = new SubscriptionManager(client, (method, params) => {
    emitNotification(method, params);
  });

  emitNotification("connected", {});

  await subMgr.subscribeDefaults();

  subMgr.startSseLoop().catch((err) => {
    console.error("[sidecar] SSE error:", err);
    emitNotification("disconnected", { reason: String(err) });
  });

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let req: Request | null;
      try {
        req = parseRequest(trimmed);
      } catch (err) {
        console.error("[sidecar] JSON parse error:", err);
        continue;
      }

      if (!req) {
        console.error("[sidecar] invalid request:", trimmed);
        continue;
      }

      try {
        const result = await dispatch(client, subMgr, req);
        emitResponse(req.id, result);
      } catch (err) {
        emitError(req.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  console.error("[sidecar] stdin closed, exiting");
  process.exit(0);
}

// Only run when launched as the sidecar process; importing this module (tests reaching
// for `dispatch`) must not open a daemon connection or start reading stdin.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[sidecar] fatal:", err);
    process.exit(1);
  });
}
