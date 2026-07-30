/**
 * Cursor persistence. The whole point of the cursor is surviving a restart, so this has
 * to be durable: write to a temp file and rename, never truncate-in-place. A half-written
 * cursor file is worse than no cursor file.
 *
 * Ported from chatmux's reference consumer (`examples/notifier/cursor-store.ts`) rather
 * than reinvented — the three properties below are the ones a hand-rolled version keeps
 * dropping: JSON (not a bare string), atomic rename, and corrupt-file tolerance.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class CursorStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  load(): string | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as { cursor?: unknown };
      return typeof parsed.cursor === "string" ? parsed.cursor : null;
    } catch {
      // Corrupt file: treat as "no cursor" rather than crash-looping. The caller resyncs
      // from head, which loses backlog but keeps the consumer alive.
      console.error(`[sidecar] cursor file unreadable, resyncing from head: ${this.filePath}`);
      return null;
    }
  }

  save(cursor: string): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cursor }) + "\n");
      renameSync(tmp, this.filePath);
    } catch (err) {
      // Losing the cursor costs a resync from head after a restart. Letting the write
      // failure escape would cost the whole push pipeline, which is worse.
      console.error("[sidecar] cursor save failed:", err);
    }
  }
}

/**
 * chat-nvim is its own consumer, so it gets its own cursor — sharing the notifier's
 * would make each one skip the other's events.
 */
export function defaultCursorPath(): string {
  const dataDir =
    process.env.CHATMUX_DATA_DIR ??
    join(process.env.HOME ?? ".", ".local/share/chatmux");
  return join(dataDir, "consumers/chat-nvim/cursor.json");
}
