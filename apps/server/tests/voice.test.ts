import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { VoiceSessions } from "../src/voice.js";
import { VoiceStartSchema } from "@palmagent/shared";

function fixture(mode = "success", leaseMs = 45_000) {
  const requests: any[] = []; const directories: string[] = []; const children: any[] = [];
  const sessions = new VoiceSessions((_home, cwd) => {
    directories.push(cwd);
    const child = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null as string | null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as unknown as Writable,
      kill: (_signal: string) => { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; } });
    const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const msg = JSON.parse(String(chunk)); requests.push(msg); done();
      queueMicrotask(() => {
        if (msg.id === 1) emit({ id: 1, result: {} });
        if (msg.id === 2) emit({ id: 2, result: { thread: { id: "voice-thread" } } });
        if (msg.id === 3) {
          emit({ id: 3, result: {} });
          if (mode === "error") emit({ method: "thread/realtime/error", params: { message: "private upstream detail" } });
          if (mode === "null") emit(null);
          if (mode === "success") emit({ method: "thread/realtime/sdp", params: { threadId: "voice-thread", sdp: "v=0\r\nanswer" } });
        }
      });
    } });
    children.push(child); return child as unknown as ChildProcessWithoutNullStreams;
  }, leaseMs, 1000);
  return { sessions, requests, directories, children };
}

test("voice negotiates an isolated read-only thread and closes on an unexpected agent turn", async () => {
  const f = fixture();
  try {
    const connection = await f.sessions.start("/agent-home", "v=0\r\noffer");
    const start = f.requests.find(x => x.method === "thread/start");
    assert.equal(start.params.ephemeral, true); assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.cwd, f.directories[0]);
    assert.equal(f.requests.find(x => x.method === "thread/realtime/start").params.transport.type, "webrtc");
    assert.equal(f.requests.some(x => x.method === "turn/start"), false);
    f.sessions.touch(connection.id);
    f.children[0].stdout.write(JSON.stringify({ method: "turn/started", params: { turn: { id: "unexpected" } } }) + "\n");
    assert.throws(() => f.sessions.touch(connection.id), /ended/);
    await delay(0); assert.equal(existsSync(f.directories[0]), false);
  } finally { f.sessions.close(); }
});

test("realtime acknowledgements are not success; errors and malformed frames fail closed without leaking upstream text", async () => {
  for (const mode of ["error", "null"]) {
    const f = fixture(mode);
    await assert.rejects(f.sessions.start("/agent-home", "v=0"), error => error instanceof Error && /unavailable/.test(error.message) && !/private/.test(error.message));
    await delay(0); assert.equal(existsSync(f.directories[0]), false); f.sessions.close();
  }
});

test("cancelled negotiation, expired leases and shutdown release the owned processes", async () => {
  const pending = fixture("pending"); const abort = new AbortController();
  const result = pending.sessions.start("/agent-home", "v=0", abort.signal);
  abort.abort(); await assert.rejects(result); pending.sessions.close();
  const f = fixture("success", 60);
  const connection = await f.sessions.start("/agent-home", "v=0");
  await delay(100); assert.throws(() => f.sessions.touch(connection.id), /ended/);
  f.sessions.close(); await assert.rejects(f.sessions.start("/agent-home", "v=0"));
  assert.ok([...pending.directories, ...f.directories].every(path => !existsSync(path)));
});

test("voice startup is bounded and validates browser signaling and environment references", async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 4 }, () => f.sessions.start("/agent-home", "v=0")));
    await assert.rejects(f.sessions.start("/agent-home", "v=0"), /Too many/);
    assert.equal(VoiceStartSchema.safeParse({ context: { repoId: "repo", agent: "codex" }, sdp: "v=0" }).success, true);
    for (const value of [{ context: {}, sdp: "v=0" }, { context: { taskId: "t", repoId: "r" }, sdp: "v=0" },
      { context: { taskId: "t" }, sdp: "bad" }, { context: { taskId: "t" }, sdp: "v=0" + "x".repeat(65_536) }]) {
      assert.equal(VoiceStartSchema.safeParse(value).success, false);
    }
  } finally { f.sessions.close(); }
});
