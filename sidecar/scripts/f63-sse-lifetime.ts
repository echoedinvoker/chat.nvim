/**
 * F63 diagnostic: how long does an SSE stream actually live?
 *
 * The symptom (chat-nvim.log, 2026-08-02): every SSE stream dies of a DOMException
 * TimeoutError after 7-13 minutes, at BOTH call sites (index.ts:112 initial,
 * subscription.ts:322 post-reconnect). Nobody in this repo sets that timeout, and
 * chatmux core has no SSE handler of its own — so the layer that owns it is unknown.
 *
 * This script isolates one stream with no subscriptions, so what it measures is the
 * lifetime of an *idle* GET, not of the whole sidecar.
 *
 * Usage:
 *   bun scripts/f63-sse-lifetime.ts                 # 2.2 — idle, default fetch options
 *   F63_TRAFFIC_MS=60000 bun scripts/...            # 2.3 — periodic POST traffic
 *   F63_VARIANT=signal bun scripts/...              # 2.4 — AbortSignal.timeout(1h)
 *   F63_VARIANT=notimeout bun scripts/...           # 2.4 — Bun's { timeout: false }
 *   F63_MAX_MS=1200000 bun scripts/...              # give up after N ms (default 20 min)
 */
import { McpClient } from "../src/mcp-client.ts";
import { describeError } from "../src/describe-error.ts";

const VARIANT = process.env.F63_VARIANT ?? "default";
const TRAFFIC_MS = Number(process.env.F63_TRAFFIC_MS ?? 0);
const MAX_MS = Number(process.env.F63_MAX_MS ?? 20 * 60 * 1000);
const SOCKET =
  process.env.CHATMUX_SOCKET ?? `${process.env.HOME}/.local/share/chatmux/chatmux.sock`;

/**
 * openSseStream() takes no options, so the variants have to be applied here rather than
 * through the client. Printing the options object is the evidence that a variant was
 * really applied — "no output" would otherwise be indistinguishable from "not tried"
 * (step 2.4's verification requires this).
 */
function fetchInitFor(variant: string): RequestInit {
  if (variant === "signal") {
    return { signal: AbortSignal.timeout(3_600_000) } as RequestInit;
  }
  if (variant === "notimeout") {
    // bun-types' RequestInit does not declare `timeout`; whether Bun honours it is
    // exactly what 2.4 has to find out.
    return { timeout: false } as unknown as RequestInit;
  }
  return {};
}

function describeInit(init: RequestInit): string {
  const keys = Object.keys(init);
  if (keys.length === 0) return "{} (no options)";
  return keys
    .map((k) => `${k}=${String((init as Record<string, unknown>)[k])}`)
    .join(", ");
}

async function main(): Promise<void> {
  const extra = fetchInitFor(VARIANT);
  console.log(
    `[f63] variant=${VARIANT} traffic_ms=${TRAFFIC_MS} max_ms=${MAX_MS} extra_fetch_init=${describeInit(extra)}`,
  );

  const client = new McpClient(SOCKET);
  await client.connect();
  console.log(`[f63] connected to ${SOCKET}`);

  // Same request openSseStream() makes, plus the variant under test.
  const res = await fetch("http://localhost/mcp", {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...((client as unknown as { sessionId: string | null }).sessionId
        ? {
            "mcp-session-id": (client as unknown as { sessionId: string }).sessionId,
          }
        : {}),
    },
    unix: SOCKET,
    ...extra,
  } as RequestInit);

  if (!res.body) throw new Error("SSE stream: no response body");
  const reader = res.body.getReader();
  const started = Date.now();
  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[f63] stream open, status=${res.status}, waiting...`);

  let traffic: ReturnType<typeof setInterval> | undefined;
  if (TRAFFIC_MS > 0) {
    traffic = setInterval(() => {
      client
        .readEvents({ limit: 1 })
        .then(() => console.log(`[f63] traffic ping ok at ${elapsed()}s`))
        .catch((err) => console.log(`[f63] traffic ping failed at ${elapsed()}s: ${describeError(err)}`));
    }, TRAFFIC_MS);
  }

  const giveUp = setTimeout(() => {
    console.log(`[f63] stream STILL ALIVE after ${elapsed()}s: gave up waiting`);
    process.exit(0);
  }, MAX_MS);

  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        console.log(`[f63] stream ended after ${elapsed()}s: done`);
        break;
      }
      // Bytes on an unsubscribed stream would themselves be a finding.
      console.log(`[f63] unexpected data at ${elapsed()}s`);
    }
  } catch (err) {
    console.log(`[f63] stream ended after ${elapsed()}s: ${describeError(err)}`);
  } finally {
    clearTimeout(giveUp);
    if (traffic) clearInterval(traffic);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[f63] script failed: ${describeError(err)}`);
  process.exit(1);
});
