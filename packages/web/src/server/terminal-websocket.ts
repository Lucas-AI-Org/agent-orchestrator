/**
 * WebSocket server for interactive terminal sessions.
 *
 * Runs alongside Next.js on port 3001.
 * Provides bidirectional streaming for tmux sessions.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

interface TerminalSession {
  sessionId: string;
  ws: WebSocket;
  captureProcess: ChildProcess | null;
}

const sessions = new Map<string, TerminalSession>();

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    ws.close(1008, "Missing session parameter");
    return;
  }

  console.log(`[WebSocket] Client connected to session: ${sessionId}`);

  // Create session
  const session: TerminalSession = {
    sessionId,
    ws,
    captureProcess: null,
  };

  sessions.set(sessionId, session);

  // Start streaming tmux output using tmux pipe-pane
  // This continuously pipes output to a command
  const captureProcess = spawn("tmux", [
    "pipe-pane",
    "-t",
    sessionId,
    "-O",
    "cat",
  ]);

  session.captureProcess = captureProcess;

  // Stream output to WebSocket
  captureProcess.stdout?.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data.toString("utf-8"));
    }
  });

  captureProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[WebSocket] tmux pipe-pane error:`, data.toString());
  });

  captureProcess.on("exit", (code) => {
    console.log(`[WebSocket] pipe-pane exited for ${sessionId} with code ${code}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Session ended");
    }
  });

  // Handle input from client
  ws.on("message", (message) => {
    const data = message.toString("utf-8");

    // Parse message: could be input or control command
    try {
      const msg = JSON.parse(data) as { type: string; data?: string; cols?: number; rows?: number };

      if (msg.type === "input" && msg.data) {
        // Send input to tmux session
        const sendProcess = spawn("tmux", [
          "send-keys",
          "-t",
          sessionId,
          "-l",
          msg.data,
        ]);

        sendProcess.on("error", (err) => {
          console.error(`[WebSocket] Failed to send keys:`, err);
        });
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        // Resize tmux pane
        const resizeProcess = spawn("tmux", [
          "resize-pane",
          "-t",
          sessionId,
          "-x",
          String(msg.cols),
          "-y",
          String(msg.rows),
        ]);

        resizeProcess.on("error", (err) => {
          console.error(`[WebSocket] Failed to resize:`, err);
        });
      }
    } catch {
      // Not JSON, treat as raw input
      const sendProcess = spawn("tmux", ["send-keys", "-t", sessionId, "-l", data]);
      sendProcess.on("error", (err) => {
        console.error(`[WebSocket] Failed to send keys:`, err);
      });
    }
  });

  // Handle disconnect
  ws.on("close", () => {
    console.log(`[WebSocket] Client disconnected from session: ${sessionId}`);

    // Stop pipe-pane
    if (session.captureProcess) {
      spawn("tmux", ["pipe-pane", "-t", sessionId]);
      session.captureProcess.kill();
    }

    sessions.delete(sessionId);
  });

  // Send initial output (capture recent history)
  spawn("tmux", ["capture-pane", "-t", sessionId, "-p", "-S", "-100"])
    .stdout?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data.toString("utf-8"));
      }
    });
});

const PORT = parseInt(process.env.WS_PORT ?? "3001", 10);

server.listen(PORT, () => {
  console.log(`[WebSocket] Terminal server listening on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[WebSocket] Shutting down...");
  wss.close();
  server.close();
  process.exit(0);
});
