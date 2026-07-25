// === JSON lines protocol (Lua ↔ Sidecar) ===

export interface Request {
  id: number;
  method: RequestMethod;
  params: Record<string, unknown>;
}

export type RequestMethod =
  | "list_chats"
  | "read_messages"
  | "send_message"
  | "search_messages"
  | "get_status"
  | "close_chat";

export interface Response {
  id: number;
  result?: unknown;
  error?: { message: string };
}

export interface Notification {
  id: null;
  method: NotificationMethod;
  params: Record<string, unknown>;
}

export type NotificationMethod =
  | "resource_updated"
  | "connected"
  | "disconnected"
  | "error";

export type OutgoingMessage = Response | Notification;

// === Simplified types emitted to Lua (sidecar transforms MCP output) ===

export interface Chat {
  id: string;
  name: string;
  platform: string;
  last_message_time?: number;
}

export interface Message {
  id: string;
  chat_id: string;
  sender_name: string;
  text: string;
  timestamp: number;
  is_self: boolean;
  /** Non-null once edited in place; Lua compares it to detect a changed message. */
  edited_at: number | null;
  /** Non-null once retracted. Text is already replaced with a placeholder. */
  retracted_at: number | null;
}

// === MCP tool input params ===

export interface ListChatsParams {
  platform?: string;
  query?: string;
  limit?: number;
  cursor?: number;
}

export interface ReadMessagesParams {
  chat_id: string;
  limit?: number;
  before?: number;
  after?: number;
}

export interface SendMessageParams {
  chat_id: string;
  text: string;
}

export interface SearchMessagesParams {
  query: string;
  platform?: string;
  chat_id?: string;
  limit?: number;
}

export interface CloseChatParams {
  chat_id: string;
}

// === MCP raw output (daemon returns, sidecar transforms) ===

export interface McpChatRaw {
  id: string;
  type: string;
  name: string;
  platform: string;
  last_message?: {
    text: string;
    timestamp: number;
    sender: string;
  };
  message_count: number;
}

export interface McpMessageRaw {
  id: string;
  chat_id: string;
  sender: {
    id: string;
    display_name: string;
  };
  timestamp: number;
  content: {
    type: string;
    text?: string;
  };
  edited_at?: number | null;
  retracted_at?: number | null;
}

export interface McpSendResult {
  success: boolean;
  message_id?: string;
  timestamp?: number;
  error?: string;
  detail?: string;
}

export interface McpSearchResultItem {
  message: McpMessageRaw;
  snippet: string;
  chat_name: string;
}
