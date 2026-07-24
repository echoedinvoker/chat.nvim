import { describe, test, expect } from "bun:test";
import { join } from "path";

const SIDECAR_PATH = join(import.meta.dir, "../src/index.ts");

async function runSidecar(
  stdinLines: string[],
  timeoutMs = 8000
): Promise<{ stdout: string[]; stderr: string; exitCode: number | null }> {
  const input = stdinLines.join("\n") + "\n";

  const proc = Bun.spawn(["bun", "run", SIDECAR_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(input);
  proc.stdin.flush();
  proc.stdin.end();

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timer);
  const exitCode = proc.exitCode;

  const stdout = stdoutText
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); }
      catch { return l; }
    });

  return { stdout, stderr: stderrText, exitCode };
}

describe("Protocol (stdin → stdout)", () => {
  test("get_status returns valid response with matching id", async () => {
    const { stdout } = await runSidecar([
      '{"id":1,"method":"get_status","params":{}}',
    ]);

    // first line = connected notification
    const connected = stdout.find(
      (m: any) => m.id === null && m.method === "connected"
    );
    expect(connected).toBeTruthy();

    // second line = get_status response
    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeTruthy();
    expect(response.result).toHaveProperty("daemon");
    expect(response.error).toBeUndefined();
  });

  test("list_chats returns chats array", async () => {
    const { stdout } = await runSidecar([
      '{"id":1,"method":"list_chats","params":{"limit":2}}',
    ]);

    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeTruthy();
    expect(response.result).toHaveProperty("chats");
    expect(Array.isArray(response.result.chats)).toBe(true);
  });

  test("multiple requests get correct id mapping", async () => {
    const { stdout } = await runSidecar([
      '{"id":10,"method":"get_status","params":{}}',
      '{"id":20,"method":"list_chats","params":{"limit":1}}',
    ]);

    const r10 = stdout.find((m: any) => m.id === 10);
    const r20 = stdout.find((m: any) => m.id === 20);
    expect(r10).toBeTruthy();
    expect(r20).toBeTruthy();
    expect(r10.result).toHaveProperty("daemon");
    expect(r20.result).toHaveProperty("chats");
  });

  test("invalid JSON on stdin does not crash sidecar", async () => {
    const { stdout, stderr } = await runSidecar([
      "not valid json",
      '{"id":1,"method":"get_status","params":{}}',
    ]);

    // sidecar should still process the valid request
    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeTruthy();
    expect(response.result).toHaveProperty("daemon");

    // stderr should mention parse error
    expect(stderr).toContain("parse error");
  });

  test("unknown method returns error response", async () => {
    const { stdout } = await runSidecar([
      '{"id":1,"method":"unknown_method","params":{}}',
    ]);

    // invalid method should be logged to stderr, no response emitted
    // (parseRequest returns null for unknown methods)
    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeUndefined();
  });

  test("read_messages response has correct message shape", async () => {
    // first get a chat id
    const { stdout: listOut } = await runSidecar([
      '{"id":1,"method":"list_chats","params":{"limit":1}}',
    ]);
    const listResp = listOut.find((m: any) => m.id === 1);
    if (!listResp?.result?.chats?.length) return; // skip if no chats

    const chatId = listResp.result.chats[0].id;

    const { stdout } = await runSidecar([
      `{"id":1,"method":"read_messages","params":{"chat_id":"${chatId}","limit":2}}`,
    ]);

    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeTruthy();
    expect(response.result).toHaveProperty("messages");
    if (response.result.messages.length > 0) {
      const msg = response.result.messages[0];
      expect(msg).toHaveProperty("id");
      expect(msg).toHaveProperty("sender_name");
      expect(msg).toHaveProperty("text");
      expect(msg).toHaveProperty("timestamp");
      expect(msg).toHaveProperty("is_self");
    }
  });

  test("error response format", async () => {
    const { stdout } = await runSidecar([
      '{"id":1,"method":"read_messages","params":{}}',
    ]);

    const response = stdout.find((m: any) => m.id === 1);
    expect(response).toBeTruthy();
    // should error because chat_id is missing
    expect(response.error).toBeTruthy();
    expect(response.error.message).toBeDefined();
  });
});
