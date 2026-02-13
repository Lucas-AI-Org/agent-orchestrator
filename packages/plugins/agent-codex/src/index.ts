import type {
  Agent,
  AgentIntrospection,
  AgentLaunchConfig,
  ActivityState,
  PluginModule,
  RuntimeHandle,
  Session,
} from "@agent-orchestrator/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\'' .
 */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function createCodexAgent(): Agent {
  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["codex"];

      if (config.permissions === "skip") {
        parts.push("--approval-mode", "full-auto");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.prompt) {
        parts.push(shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      env["AO_PROJECT_ID"] = config.projectConfig.name;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    async detectActivity(session: Session): Promise<ActivityState> {
      if (!session.runtimeHandle) return "exited";

      // Check if codex process is running
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return "exited";

      // Codex doesn't have rich terminal output patterns yet
      // Default to active if running
      return "active";
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync("tmux", [
            "list-panes",
            "-t",
            handle.id,
            "-F",
            "#{pane_tty}",
          ]);
          const tty = ttyOut.trim().split("\n")[0];
          if (!tty) return false;

          const ttyShort = tty.replace(/^\/dev\//, "");
          const { stdout: psOut } = await execFileAsync("ps", [
            "-eo",
            "pid,tty,comm",
          ]);
          for (const line of psOut.split("\n")) {
            const parts = line.trim().split(/\s+/);
            if (
              parts.length >= 3 &&
              parts[1] === ttyShort &&
              parts[2] === "codex"
            ) {
              return true;
            }
          }
          return false;
        }

        const pid = handle.data["pid"] as number | undefined;
        if (pid) {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async introspect(_session: Session): Promise<AgentIntrospection | null> {
      // Codex doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

const plugin: PluginModule<Agent> = { manifest, create };
export default plugin;
