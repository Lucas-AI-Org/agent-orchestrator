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
 * Streams tmux pane output via SSE. Interactive terminal with direct input.
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [isInteractive, setIsInteractive] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastContentRef = useRef<string>("");

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: true, // Will be enabled when interactive mode is on
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
      setTimeout(() => fitAddonRef.current?.fit(), 150);
    }
  }, [fullscreen]);

  // Handle interactive mode
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    if (isInteractive) {
      term.options.disableStdin = false;
      term.options.cursorBlink = true;

      // Handle keyboard input
      const disposable = term.onData((data) => {
        // Send each keystroke to the session
        void (async () => {
          try {
            await fetch(`/api/sessions/${sessionId}/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: data }),
            });
          } catch (err) {
            console.error("[Terminal] Failed to send input:", err);
          }
        })();
      });

      return () => {
        disposable.dispose();
      };
    } else {
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
    }
  }, [isInteractive, sessionId]);

  // Connect to SSE stream
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const eventSource = new EventSource(`/api/sessions/${sessionId}/terminal`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data) as
          | { type: "snapshot" | "update"; content: string }
          | { type: "exit" };

        if (data.type === "snapshot" || data.type === "update") {
          const content = data.content;

          // Only update if content changed
          if (content !== lastContentRef.current) {
            lastContentRef.current = content;

            // Reset terminal and write new content
            term.reset();
            term.write(content);

            // Scroll to bottom
            term.scrollToBottom();
          }
        } else if (data.type === "exit") {
          term.writeln("\r\n\r\n[Session exited]");
        }
      } catch (err) {
        console.error("[Terminal] Failed to parse SSE event:", err);
      }
    });

    eventSource.addEventListener("error", () => {
      eventSource.close();
      term.writeln("\r\n\r\n[Connection lost]");
    });

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
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
          <div className="h-2.5 w-2.5 rounded-full bg-[#f85149]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#d29922]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#3fb950]" />
        </div>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Read-only
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
