import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalFrame, TerminalInput } from "@palmagent/shared/terminals";
import { terminalInputChunks } from "@palmagent/shared/terminals";
import { api } from "../api";
import { Button } from "./ui/button";
import "@xterm/xterm/css/xterm.css";

export function TerminalScreen({ id }: { id: string }) {
  const container = useRef<HTMLDivElement>(null);
  const send = useRef<(value: TerminalInput) => void>(() => {});
  const input = useRef<(data: string) => void>(() => {});
  const termRef = useRef<Terminal | undefined>(undefined);
  const [state, setState] = useState("Connecting…");
  const [writable, setWritable] = useState(false);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let term: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let epoch = 0, controls = false, attempts = 0, ended = false, connection = 0;
    const transmit = (value: TerminalInput) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    send.current = transmit;
    const write = (data: string) => { if (controls) for (const chunk of terminalInputChunks(data)) transmit({ type: "input", epoch, data: chunk }); };
    input.current = write;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !container.current) return;
      term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 2000, disableStdin: true, allowProposedApi: true, screenReaderMode: true });
      termRef.current = term;
      const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current);
      const theme = () => {
        if (!term || !container.current) return;
        const style = getComputedStyle(container.current);
        // Canvas resolves CSS Color 4 tokens to the sRGB values xterm accepts.
        const canvas = document.createElement("canvas").getContext("2d")!;
        const color = (value: string) => {
          canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
          const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
          return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
        };
        term.options.theme = { background: color(style.backgroundColor), foreground: color(style.color), cursor: color(style.color) };
      };
      theme(); themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      // The host answers terminal queries, including when detached. Browser rendering
      // must not send duplicate query replies through the user input channel.
      for (const prefix of ["", "?", ">", "="]) {
        for (const final of ["c", "n"]) term.parser.registerCsiHandler({ prefix, final }, () => true);
      }
      term.parser.registerCsiHandler({ final: "t" }, () => true);
      term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true);
      for (const ident of [4, 10, 11, 12, 52]) term.parser.registerOscHandler(ident, () => true);
      term.onData(write);
      const resize = () => {
        if (!term || !controls || !container.current?.clientWidth || !container.current.clientHeight) return;
        fit.fit(); transmit({ type: "resize", epoch, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(200, term.rows)) });
      };
      observer = new ResizeObserver(resize); observer.observe(container.current);
      async function connect() {
        if (disposed || ended) return;
        const version = ++connection;
        controls = false; setConnected(false); setWritable(false); setState(attempts ? "Reconnecting… Input is paused." : "Connecting…");
        if (term) term.options.disableStdin = true;
        try {
          const ticket = await api.terminals.ticket(id);
          if (disposed) return;
          const url = new URL("/api/terminals/" + encodeURIComponent(id) + "/stream", location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(url);
          let frames = Promise.resolve();
          socket.onopen = () => socket?.send(JSON.stringify({ type: "attach", ...ticket }));
          socket.onmessage = event => {
            frames = frames.then(async () => {
              if (!term || disposed || version !== connection || socket?.readyState !== WebSocket.OPEN) return;
              const frame = JSON.parse(event.data) as TerminalFrame;
              if (frame.type === "snapshot") {
                attempts = 0; term.reset(); term.resize(frame.cols, frame.rows);
                await new Promise<void>(resolve => term!.write(frame.data, resolve));
                if (disposed || version !== connection || socket?.readyState !== WebSocket.OPEN) return;
                transmit({ type: "ack", seq: frame.seq }); setConnected(true);
                setState("Connected · View only");
              } else if (frame.type === "output") {
                await new Promise<void>(resolve => term!.write(frame.data, resolve));
                transmit({ type: "ack", seq: frame.seq });
              }
              else if (frame.type === "resize") { term.resize(frame.cols, frame.rows); transmit({ type: "ack", seq: frame.seq }); }
              else if (frame.type === "control") {
                epoch = frame.epoch; controls = frame.writable; term.options.disableStdin = !controls;
                setWritable(controls); setState(controls ? "Connected · You have control" : "Connected · View only");
                if (controls) { resize(); term.focus(); }
              } else if (frame.type === "exit") { ended = true; controls = false; setConnected(false); setWritable(false); term.options.disableStdin = true; setState("Shell exited"); socket?.close(); }
            }).catch(() => { if (version === connection) socket?.close(); });
          };
          socket.onclose = () => {
            controls = false;
            if (disposed || ended) return;
            setConnected(false); setWritable(false); if (term) term.options.disableStdin = true;
            setState("Disconnected · Input is paused");
            retry = setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** attempts++));
          };
          socket.onerror = () => socket?.close();
        } catch {
          if (disposed) return;
          setState("Unable to connect · Retrying");
          retry = setTimeout(() => void connect(), 5000);
        }
      }
      void connect();
    })();
    return () => {
      disposed = true; clearTimeout(retry); observer?.disconnect(); themeObserver?.disconnect();
      socket?.close(); term?.dispose(); termRef.current = undefined; send.current = () => {}; input.current = () => {};
    };
  }, [id]);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-1">
      <p role="status" className="text-xs text-muted-foreground">{state}</p>
      <Button variant="outline" disabled={!connected} onClick={() => send.current({ type: writable ? "release-control" : "claim-control" })}>{writable ? "Release control" : "Control here"}</Button>
    </div>
    <div ref={container} data-testid="terminal-screen" className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden bg-background p-2 text-foreground" />
    <div className="flex shrink-0 gap-1 overflow-x-auto px-2 pt-1 pb-[calc(8px+var(--safe-bottom))]" aria-label="Terminal keys">
      {[["Ctrl+C", "\x03"], ["Tab", "\t"], ["Esc", "\x1b"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"]].map(([label, data]) =>
        <Button key={label} variant="secondary" className="shrink-0" disabled={!writable} onPointerDown={e => e.preventDefault()} onClick={() => { input.current(data); termRef.current?.focus(); }}>{label}</Button>)}
    </div>
  </div>;
}
