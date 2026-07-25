import type { McpClient } from "./mcp-client.ts";
import { toChat, toMessage, historyBanner } from "./mcp-client.ts";
import type { McpChatRaw, McpHistoryRaw, McpMessageRaw } from "./types.ts";

export type NotificationHandler = (
  method: string,
  params: Record<string, unknown>
) => void;

export class SubscriptionManager {
  private client: McpClient;
  private subscribedUris = new Set<string>();
  private onNotify: NotificationHandler;
  private fallbackMode = false;

  constructor(client: McpClient, onNotify: NotificationHandler) {
    this.client = client;
    this.onNotify = onNotify;
  }

  async subscribeDefaults(): Promise<void> {
    await this.subscribe("chat://chats");
    await this.subscribe("chat://status");
  }

  async subscribeChat(chatId: string): Promise<void> {
    const uri = `chat://chats/${chatId}/messages`;
    await this.subscribe(uri);
  }

  async unsubscribeChat(chatId: string): Promise<void> {
    const uri = `chat://chats/${chatId}/messages`;
    if (!this.subscribedUris.has(uri)) return;

    try {
      await this.client.unsubscribe(uri);
    } catch {
      // best-effort
    }
    this.subscribedUris.delete(uri);
  }

  async startSseLoop(): Promise<void> {
    const stream = await this.client.openSseStream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6);
          try {
            const msg = JSON.parse(json);
            await this.handleSseMessage(msg);
          } catch {
            // skip unparseable SSE data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.onNotify("disconnected", { reason: "SSE stream ended" });
  }

  private async handleSseMessage(msg: any): Promise<void> {
    if (msg.method !== "notifications/resources/updated") return;

    const uri = msg.params?.uri;
    if (typeof uri !== "string") return;

    if (!this.subscribedUris.has(uri)) return;

    const sidecar_received_at = Date.now();

    try {
      const data = await this.client.readResource(uri);
      const transformed = this.transformResourceData(uri, data);
      this.onNotify("resource_updated", {
        uri,
        sidecar_received_at,
        ...transformed,
      });
    } catch {
      this.onNotify("resource_updated", { uri, sidecar_received_at });
    }
  }

  private transformResourceData(uri: string, data: unknown): Record<string, unknown> {
    if (typeof data !== "object" || data === null) return data as any;
    const obj = data as Record<string, unknown>;

    // chat://chats/{id}/messages → transform messages array
    const messagesMatch = uri.match(/^chat:\/\/chats\/([^/]+)\/messages/);
    if (messagesMatch && Array.isArray(obj.messages)) {
      const chatId = messagesMatch[1];
      const transformed = (obj.messages as McpMessageRaw[]).map((m) => toMessage(m, chatId));
      const latest = transformed.reduce(
        (max, m) => (m.timestamp > max ? m.timestamp : max),
        0
      );
      // Not guarded on `latest > 0` like msg_timestamp is: the banner matters most when
      // the chat is empty, which is exactly when that guard would drop it.
      return {
        messages: transformed,
        banner: historyBanner(obj.history as McpHistoryRaw | undefined),
        ...(latest > 0 && { msg_timestamp: latest }),
      };
    }

    // chat://chats → transform chats array
    if (uri === "chat://chats" && Array.isArray(obj.chats)) {
      return {
        chats: (obj.chats as McpChatRaw[]).map(toChat),
      };
    }

    return obj;
  }

  private async subscribe(uri: string): Promise<void> {
    if (this.subscribedUris.has(uri)) return;

    try {
      await this.client.subscribe(uri);
      this.subscribedUris.add(uri);
    } catch {
      if (!this.fallbackMode) {
        console.error(
          `[sidecar] subscribe failed for ${uri}, falling back to passive mode`
        );
        this.fallbackMode = true;
      }
      this.subscribedUris.add(uri);
    }
  }
}
