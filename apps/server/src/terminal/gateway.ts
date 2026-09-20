import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { TerminalClientFrame, TerminalId, TERMINAL_PROTOCOL } from "@palmagent/shared/terminals";
import type { AuthService } from "../auth.js";
import type { TerminalService } from "./service.js";
import type { LocalTransport, LocalChannel } from "./platform.js";

export class TerminalTickets {
  private tickets = new Map<string, { token: string; id: string; expires: number }>();
  issue(token: string, id: string) {
    for (const [key, entry] of this.tickets) if (entry.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 128) throw new Error("Too many terminal connection requests");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { token, id, expires: Date.now() + 30_000 });
    return { ticket, protocol: TERMINAL_PROTOCOL };
  }
  consume(ticket: string, token: string, id: string): boolean {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!entry && entry.token === token && entry.id === id && entry.expires >= Date.now();
  }
}
export function installTerminalGateway(server: Server, deps: {
  service: TerminalService; auth: AuthService; tickets: TerminalTickets; transport: LocalTransport;
  origin: string; cookieName: string;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70_000, perMessageDeflate: false });
  // Explicitly validate upgrade requests; they do not pass through Hono middleware.
  const onUpgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    const match = /^\/api\/terminals\/([^/]+)\/stream$/.exec(request.url ?? "");
    const token = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(deps.cookieName + "="))?.slice(deps.cookieName.length + 1);
    if (!match || !TerminalId.safeParse(match[1]).success || !deps.auth.enabled || request.headers.origin !== deps.origin ||
        !token || !deps.auth.sessionValid(token) || !deps.service.capabilities().available || wss.clients.size >= 32) { reject(); return; }
    const id = match[1];
    try { deps.service.get(id); } catch { reject(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      let channel: LocalChannel | undefined;
      let attached = false;
      let connecting = false;
      let pong = true;
      let inputBytes = 0;
      const timeout = setTimeout(() => { if (!attached) ws.close(1008, "Attach timed out"); }, 5000);
      const heartbeat = setInterval(() => {
        inputBytes = 0;
        if (!deps.auth.sessionValid(token) || !pong) { ws.terminate(); return; }
        pong = false; ws.ping();
      }, 10_000);
      ws.on("pong", () => { pong = true; });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => { clearTimeout(timeout); clearInterval(heartbeat); channel?.close(); });
      ws.on("message", async (raw, binary) => {
        try {
          if (binary || !deps.auth.sessionValid(token)) { ws.close(1008, "Authentication required"); return; }
          inputBytes += raw.toString().length;
          if (inputBytes > 512_000) { ws.close(1008, "Input limit exceeded"); return; }
          const frame = TerminalClientFrame.parse(JSON.parse(raw.toString()));
          if (!attached) {
            if (connecting || frame.type !== "attach" || !deps.tickets.consume(frame.ticket, token, id)) { ws.close(1008, "Invalid attach"); return; }
            connecting = true;
            const record = deps.service.get(id);
            if (record.state !== "running") { ws.close(1013, "Terminal is not running"); return; }
            channel = await deps.transport.connect(record.directory, id);
            if (ws.readyState !== WebSocket.OPEN) { channel.close(); return; }
            attached = true; clearTimeout(timeout);
            channel.onMessage(value => {
              if (!deps.auth.sessionValid(token) || ws.bufferedAmount > 2_000_000) { ws.close(1013, "Reconnect to synchronize"); return; }
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
            });
            channel.onClose(() => ws.close(1000, "Terminal disconnected"));
          } else {
            if (frame.type === "attach") { ws.close(1008, "Already attached"); return; }
            channel?.send(frame);
          }
        } catch { ws.close(1008, "Invalid terminal request"); }
      });
    });
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) {
      ws.close(1012, "Application restarting");
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref(); ws.once("close", () => clearTimeout(timer));
    }
    wss.close();
  };
}
