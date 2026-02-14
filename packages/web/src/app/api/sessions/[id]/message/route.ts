import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars } from "@/lib/validation";
import type { Runtime } from "@agent-orchestrator/core";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { message: rawMessage } = await request.json() as { message: string };

    if (!rawMessage) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    // Strip control characters to prevent injection when passed to shell-based runtimes
    const message = stripControlChars(rawMessage);

    if (message.trim().length === 0) {
      return NextResponse.json(
        { error: "Message must not be empty after sanitization" },
        { status: 400 },
      );
    }

    const { sessionManager, config, registry } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!session.runtimeHandle) {
      return NextResponse.json({ error: "Session has no runtime handle" }, { status: 400 });
    }

    // Get the runtime plugin for this session's project
    const project = config.projects[session.projectId];
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Use project runtime or fall back to defaults
    const runtimeName = project.runtime ?? config.defaults?.runtime;
    if (!runtimeName) {
      return NextResponse.json({ error: "Project has no runtime configured" }, { status: 500 });
    }

    const runtime = registry.get<Runtime>("runtime", runtimeName);
    if (!runtime) {
      return NextResponse.json({ error: "Runtime plugin not found" }, { status: 500 });
    }

    try {
      // Use the Runtime plugin's sendMessage method which handles sanitization
      // and uses the correct runtime handle
      await runtime.sendMessage(session.runtimeHandle, message);
      return NextResponse.json({ success: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send message:", errorMsg);
      return NextResponse.json(
        { error: `Failed to send message: ${errorMsg}` },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
