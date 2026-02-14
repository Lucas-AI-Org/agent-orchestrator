"use client";

import { useState, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/cn";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed using xterm.js.
 * Proper interactive terminal via WebSocket - type directly, real-time streaming.
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance - fully interactive
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      theme: {
        background: "#000000",
        foreground: "#d0d0d0",
        cursor: "#d0d0d0",
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    // Initial fit
    setTimeout(() => fitAddon.fit(), 50);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle window resize
    const handleResize = () => {
      setTimeout(() => fitAddon.fit(), 50);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Refit terminal when fullscreen changes
  useEffect(() => {
    if (fitAddonRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        // Send resize to server
        const term = xtermRef.current;
        const ws = wsRef.current;
        if (term && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
      }, 150);
    }
  }, [fullscreen]);

  // Connect to WebSocket for interactive terminal
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    // Connect to WebSocket server
    const wsUrl = `ws://localhost:${process.env.NEXT_PUBLIC_WS_PORT ?? "3001"}?session=${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      console.log("[Terminal] WebSocket connected");

      // Send initial terminal size
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      // Write output from server
      term.write(event.data);
    });

    ws.addEventListener("error", (err) => {
      console.error("[Terminal] WebSocket error:", err);
      term.writeln("\r\n\r\n[Connection error]");
      setConnected(false);
    });

    ws.addEventListener("close", () => {
      console.log("[Terminal] WebSocket closed");
      term.writeln("\r\n\r\n[Connection closed]");
      setConnected(false);
    });

    // Handle keyboard input - send to server
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Handle terminal resize - send to server
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className="flex gap-1.5">
          <div
            className={cn(
              "h-2.5 w-2.5 rounded-full transition-colors",
              connected ? "bg-[#3fb950]" : "bg-[#f85149]",
            )}
          />
          <div className="h-2.5 w-2.5 rounded-full bg-[#d29922]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#484f58]" />
        </div>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <span
          className={cn(
            "text-[10px] font-medium uppercase tracking-wide",
            connected ? "text-[var(--color-accent-green)]" : "text-[var(--color-text-muted)]",
          )}
        >
          {connected ? "Interactive" : "Connecting..."}
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div
        ref={terminalRef}
        className={cn(
          "p-2",
          fullscreen ? "h-[calc(100vh-40px)]" : "h-[600px]",
        )}
      />
    </div>
  );
}
