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
  | "close_chat"
  | "fetch_media";

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
  /**
   * F35: core's own `content.type`, passed through unchanged.
   *
   * Lua needs it to size an inline image (a sticker gets fewer rows than a photo). The
   * alternative — inferring the type from `text` — would make the placeholder wording
   * load-bearing, and wording changes silently.
   */
  content_type: string;
  /**
   * F35: where this message's image stands. Absent on non-media messages.
   *
   * `ready` carries a local path core has already fetched and cached — Lua renders it
   * and never touches a URL, a header or a key. `pending` and `gone` carry no path, and
   * the matching wording is already in `text`: Lua renders what it is given rather than
   * deciding what "missing" reads like.
   */
  media?: MediaState;
}

/** F35: the three states an image can be in by the time Lua sees it. */
export type MediaState =
  | { state: "ready"; path: string }
  | { state: "pending" }
  | { state: "gone" };

/** What core's `get_media` answers with, as the sidecar sees it. */
export type MediaResult =
  | { path: string; mime: string }
  | { unavailable: string };

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

/**
 * `readMessages` 的回傳形狀。具名（而非跟其他 method 一樣內聯）是因為它有 4 個欄位、
 * 且 `has_more` / `oldest_timestamp` 是 Lua 往回分頁的唯一依據——分頁能不能往上走由
 * 這裡的欄位決定，值得一個能被引用的名字。
 *
 * `has_more` 的語意是「**本機 DB** 裡還有更舊的」，不是「這間聊天室就這麼多」。
 * 後者只有 history.state 的 complete/exhausted 有資格宣稱，見 chatmux
 * docs/storage-schema.md:105-121。
 */
export interface ReadMessagesResult {
  messages: Message[];
  banner: string | null;
  has_more: boolean;
  /** 本頁最舊的 timestamp（毫秒）。空聊天室是 null，不是 undefined。 */
  oldest_timestamp: number | null;
  /** 頂端狀態行。文案在 sidecar 決定（見 olderHint），Lua 只負責印。 */
  older_hint: string | null;
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
  offset?: number;
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

/**
 * The event tail (F9). `cursor` is opaque: pass it back verbatim, never parse, compare
 * or do arithmetic on it. Progress is judged by `has_more` and by equality, not by size.
 */
export interface ChatmuxEvent {
  cursor: string;
  /** Derived by core from current state: `unsend` beats `edit` beats `message`. */
  type: string;
  message: McpMessageRaw;
}

export interface ReadEventsResult {
  events: ChatmuxEvent[];
  next_cursor: string;
  head_cursor: string;
  has_more: boolean;
}

export interface ReadEventsError {
  error: string;
  detail: string;
}

/** Errors arrive as data, not as throws — the caller resyncs from head on `invalid_cursor`. */
export type ReadEventsResponse = ReadEventsResult | ReadEventsError;

export interface McpHistoryRaw {
  state: string;
  reason?: string;
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
  // core reads this from `chats.name`, which is nullable — a chat the platform never
  // named comes back with no name at all.
  chat_name: string | null;
}

/**
 * One search hit as the UI needs it: the translated message, plus the two fields that
 * only exist in a search result. `snippet` is what the panel shows instead of the body,
 * and `chat_name` is what tells the reader which conversation it came from.
 */
export interface SearchResultOut {
  message: Message;
  snippet: string;
  chat_name: string | null;
}
