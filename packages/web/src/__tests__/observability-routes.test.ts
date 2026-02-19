import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fns ────────────────────────────────────────────────────────────

const mockReadLogsFromDir = vi.fn();
const mockTailLogs = vi.fn();
const mockResolveProjectLogDir = vi.fn();
const mockLoadConfig = vi.fn();
const mockLogWriterAppend = vi.fn();

vi.mock("@composio/ao-core", () => {
  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
  function normalizeRoutePath(path: string): string {
    return path
      .replace(/\/sessions\/[^/]+/g, "/sessions/:id")
      .replace(/\/prs\/[^/]+/g, "/prs/:id");
  }
  return {
    resolveProjectLogDir: (...args: unknown[]) => mockResolveProjectLogDir(...args),
    readLogsFromDir: (...args: unknown[]) => mockReadLogsFromDir(...args),
    tailLogs: (...args: unknown[]) => mockTailLogs(...args),
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    percentile,
    normalizeRoutePath,
    /** Inline implementation of parseApiLogs from core (uses mocked readLogsFromDir). */
    parseApiLogs: (logDir: string, opts?: { since?: Date; route?: string }) => {
      const raw = mockReadLogsFromDir(logDir, "api", {
        source: "api",
        since: opts?.since,
      }) as Array<{ ts: string; sessionId?: string | null; data?: Record<string, unknown> }>;
      const results = [];
      for (const entry of raw) {
        const data = entry.data ?? {};
        if (!data["method"] || !data["path"]) continue;
        const req = {
          ts: entry.ts,
          method: String(data["method"]),
          path: String(data["path"]),
          sessionId: entry.sessionId ?? null,
          statusCode: Number(data["statusCode"]) || 0,
          durationMs: Number(data["durationMs"]) || 0,
          error: data["error"] ? String(data["error"]) : undefined,
          timings: data["timings"] as Record<string, number> | undefined,
          cacheStats: data["cacheStats"] as { hits: number; misses: number; hitRate: number; size: number } | undefined,
        };
        if (opts?.route && !req.path.includes(opts.route)) continue;
        results.push(req);
      }
      return results;
    },
    /** Inline implementation of computeApiStats from core. */
    computeApiStats: (entries: Array<{ method: string; path: string; statusCode: number; durationMs: number; error?: string; cacheStats?: unknown }>) => {
      const byRoute = new Map<string, typeof entries>();
      for (const entry of entries) {
        const key = `${entry.method} ${normalizeRoutePath(entry.path)}`;
        const arr = byRoute.get(key) ?? [];
        arr.push(entry);
        byRoute.set(key, arr);
      }
      const routes: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number; errors: number }> = {};
      for (const [route, logs] of byRoute) {
        const durations = logs.map((l) => l.durationMs).sort((a, b) => a - b);
        routes[route] = {
          count: logs.length,
          avgMs: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
          p50Ms: percentile(durations, 50),
          p95Ms: percentile(durations, 95),
          p99Ms: percentile(durations, 99),
          errors: logs.filter((l) => l.error !== undefined || l.statusCode >= 400).length,
        };
      }
      let latestCacheStats = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if ((entries[i] as { cacheStats?: unknown }).cacheStats) {
          latestCacheStats = (entries[i] as { cacheStats?: unknown }).cacheStats;
          break;
        }
      }
      const slowest = [...entries].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
      return { routes, slowest, latestCacheStats };
    },
    LogWriter: vi.fn().mockImplementation(() => ({
      append: mockLogWriterAppend,
      appendLine: vi.fn(),
      close: vi.fn(),
    })),
  };
});

// ── Import routes after mocking ─────────────────────────────────────────

const { GET: logsGET } = await import("../app/api/logs/route.js");
const { GET: perfGET } = await import("../app/api/perf/route.js");
const { POST: clientLogsPost } = await import("../app/api/client-logs/route.js");

// ── Helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({});
  mockResolveProjectLogDir.mockReturnValue("/tmp/test-logs");
});

// ── GET /api/logs ───────────────────────────────────────────────────────

describe("GET /api/logs", () => {
  it("returns entries when logs exist", async () => {
    const fakeEntries = [
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "events",
        sessionId: null,
        message: "session spawned",
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "warn",
        source: "events",
        sessionId: "s-1",
        message: "timeout",
      },
    ];
    mockReadLogsFromDir.mockReturnValue(fakeEntries);

    const req = new Request("http://localhost:3000/api/logs?limit=100");
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.entries).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.entries[0].message).toBe("session spawned");
  });

  it("applies source filter (maps to file prefix)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request("http://localhost:3000/api/logs?source=api&limit=50");
    await logsGET(req);

    // readLogsFromDir should be called with the log dir and prefix "api"
    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "api",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("defaults source to events when not specified", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request("http://localhost:3000/api/logs");
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.any(Object),
    );
  });

  it("applies tail parameter (calls tailLogs instead of readLogsFromDir)", async () => {
    const tailEntries = [
      {
        ts: "2026-01-01T00:05:00Z",
        level: "info",
        source: "events",
        sessionId: null,
        message: "last line",
      },
    ];
    mockTailLogs.mockReturnValue(tailEntries);

    const req = new Request("http://localhost:3000/api/logs?tail=10");
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].message).toBe("last line");

    // tailLogs should be called, NOT readLogsFromDir
    expect(mockTailLogs).toHaveBeenCalledWith("/tmp/test-logs/events.jsonl", 10);
    expect(mockReadLogsFromDir).not.toHaveBeenCalled();
  });

  it("returns 500 when config has no projects", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);
    // resolveLogDir() will throw "No projects configured."

    const req = new Request("http://localhost:3000/api/logs");
    const res = await logsGET(req);
    expect(res.status).toBe(500);

    const json = await res.json();
    expect(json.error).toMatch(/No projects configured/);
  });

  it("passes since parameter as a Date object to query options", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?since=2026-01-15T10:00:00Z",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        since: new Date("2026-01-15T10:00:00Z"),
        limit: 200,
      }),
    );
  });

  it("parses comma-separated level parameter into an array", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?level=info,warn,error",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        level: ["info", "warn", "error"],
      }),
    );
  });

  it("passes sessionId parameter to query options", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?sessionId=backend-3",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({
        sessionId: "backend-3",
      }),
    );
  });

  it("applies combined filters (source + level + since)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?source=dashboard&level=error,warn&since=2026-02-01T00:00:00Z&limit=50",
    );
    await logsGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "dashboard",
      {
        since: new Date("2026-02-01T00:00:00Z"),
        level: ["error", "warn"],
        limit: 50,
      },
    );
  });

  it("handles non-numeric limit parameter gracefully (defaults to NaN)", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?limit=notanumber",
    );
    await logsGET(req);

    // parseInt("notanumber", 10) returns NaN — still passed to readLogsFromDir
    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "events",
      expect.objectContaining({ limit: NaN }),
    );
  });

  it("handles non-numeric tail parameter gracefully", async () => {
    mockTailLogs.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/logs?tail=abc",
    );
    const res = await logsGET(req);
    expect(res.status).toBe(200);

    // parseInt("abc", 10) returns NaN — still calls tailLogs with NaN
    expect(mockTailLogs).toHaveBeenCalledWith(
      "/tmp/test-logs/events.jsonl",
      NaN,
    );
    expect(mockReadLogsFromDir).not.toHaveBeenCalled();
  });
});

// ── GET /api/perf ───────────────────────────────────────────────────────

describe("GET /api/perf", () => {
  const perfLogEntries = [
    {
      ts: "2026-01-01T00:00:00Z",
      level: "info",
      source: "api",
      sessionId: null,
      message: "req",
      data: {
        method: "GET",
        path: "/api/sessions",
        statusCode: 200,
        durationMs: 150,
      },
    },
    {
      ts: "2026-01-01T00:01:00Z",
      level: "info",
      source: "api",
      sessionId: null,
      message: "req",
      data: {
        method: "GET",
        path: "/api/sessions",
        statusCode: 200,
        durationMs: 250,
      },
    },
    {
      ts: "2026-01-01T00:02:00Z",
      level: "info",
      source: "api",
      sessionId: null,
      message: "req",
      data: {
        method: "POST",
        path: "/api/spawn",
        statusCode: 500,
        durationMs: 3000,
        error: "fail",
      },
    },
  ];

  it("returns route stats with count, avgMs, p50Ms, etc.", async () => {
    mockReadLogsFromDir.mockReturnValue(perfLogEntries);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.routes).toBeDefined();
    expect(json.totalRequests).toBe(3);

    // Two GET /api/sessions entries -> normalized to "GET /api/sessions"
    const sessionRoute = json.routes["GET /api/sessions"];
    expect(sessionRoute).toBeDefined();
    expect(sessionRoute.count).toBe(2);
    expect(sessionRoute.avgMs).toBe(200); // (150 + 250) / 2
    expect(sessionRoute.p50Ms).toBeDefined();
    expect(sessionRoute.p95Ms).toBeDefined();
    expect(sessionRoute.p99Ms).toBeDefined();
    expect(sessionRoute.errors).toBe(0);

    // One POST /api/spawn with statusCode 500 and error
    const spawnRoute = json.routes["POST /api/spawn"];
    expect(spawnRoute).toBeDefined();
    expect(spawnRoute.count).toBe(1);
    expect(spawnRoute.avgMs).toBe(3000);
    expect(spawnRoute.errors).toBe(1);
  });

  it("returns slowest requests sorted by duration", async () => {
    mockReadLogsFromDir.mockReturnValue(perfLogEntries);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    const json = await res.json();

    expect(json.slowest).toBeDefined();
    expect(Array.isArray(json.slowest)).toBe(true);
    expect(json.slowest.length).toBe(3);
    // Sorted descending by duration
    expect(json.slowest[0].durationMs).toBe(3000);
    expect(json.slowest[1].durationMs).toBe(250);
    expect(json.slowest[2].durationMs).toBe(150);
  });

  it("normalizes route paths for grouping", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {
          method: "GET",
          path: "/api/sessions/backend-3",
          statusCode: 200,
          durationMs: 100,
        },
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {
          method: "GET",
          path: "/api/sessions/frontend-1",
          statusCode: 200,
          durationMs: 200,
        },
      },
    ]);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    const json = await res.json();

    // Both should be grouped under the normalized key
    const normalized = json.routes["GET /api/sessions/:id"];
    expect(normalized).toBeDefined();
    expect(normalized.count).toBe(2);
  });

  it("returns 500 when no projects configured", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(500);

    const json = await res.json();
    expect(json.error).toMatch(/No projects configured/);
  });

  it("passes since parameter as Date to readLogsFromDir", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request(
      "http://localhost:3000/api/perf?since=2026-02-01T12:00:00Z",
    );
    await perfGET(req);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "api",
      expect.objectContaining({
        source: "api",
        since: new Date("2026-02-01T12:00:00Z"),
      }),
    );
  });

  it("filters entries by route parameter using path.includes", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 100 },
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "POST", path: "/api/spawn", statusCode: 200, durationMs: 200 },
      },
      {
        ts: "2026-01-01T00:02:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "GET", path: "/api/sessions/s-1", statusCode: 200, durationMs: 150 },
      },
    ]);

    const req = new Request("http://localhost:3000/api/perf?route=sessions");
    const res = await perfGET(req);
    const json = await res.json();

    // Only entries whose path includes "sessions" should appear
    expect(json.totalRequests).toBe(2); // 2 session entries passed route filter
    // Routes should only contain session-related entries
    expect(json.routes["POST /api/spawn"]).toBeUndefined();
    expect(json.routes["GET /api/sessions"]).toBeDefined();
    expect(json.routes["GET /api/sessions/:id"]).toBeDefined();
  });

  it("returns zeroed stats when no log entries exist", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.routes).toEqual({});
    expect(json.slowest).toEqual([]);
    expect(json.cacheStats).toBeNull();
    expect(json.totalRequests).toBe(0);
  });

  it("returns latestCacheStats from the most recent entry with cacheStats", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 200,
          durationMs: 100,
          cacheStats: { hits: 5, misses: 2 },
        },
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 200,
          durationMs: 120,
          cacheStats: { hits: 10, misses: 3 },
        },
      },
      {
        ts: "2026-01-01T00:02:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {
          method: "GET",
          path: "/api/sessions",
          statusCode: 200,
          durationMs: 80,
          // no cacheStats in this entry
        },
      },
    ]);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    const json = await res.json();

    // Should be the last entry that had cacheStats (the second one)
    expect(json.cacheStats).toEqual({ hits: 10, misses: 3 });
  });

  it("skips entries with missing method or path fields", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-01-01T00:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { path: "/api/sessions", statusCode: 200, durationMs: 100 },
        // missing method
      },
      {
        ts: "2026-01-01T00:01:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "GET", statusCode: 200, durationMs: 200 },
        // missing path
      },
      {
        ts: "2026-01-01T00:02:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: {},
        // missing both
      },
      {
        ts: "2026-01-01T00:03:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        // no data field at all (data will be undefined, ?? {} makes it {})
      },
    ]);

    const req = new Request("http://localhost:3000/api/perf");
    const res = await perfGET(req);
    const json = await res.json();

    // All entries should be skipped — no routes recorded
    expect(json.routes).toEqual({});
    expect(json.slowest).toEqual([]);
    expect(json.totalRequests).toBe(0); // 0 valid entries parsed
  });

  it("applies combined since + route filtering", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2026-02-01T10:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "GET", path: "/api/sessions", statusCode: 200, durationMs: 100 },
      },
      {
        ts: "2026-02-01T11:00:00Z",
        level: "info",
        source: "api",
        sessionId: null,
        message: "req",
        data: { method: "POST", path: "/api/spawn", statusCode: 200, durationMs: 300 },
      },
    ]);

    const req = new Request(
      "http://localhost:3000/api/perf?since=2026-02-01T00:00:00Z&route=spawn",
    );
    const res = await perfGET(req);
    const json = await res.json();

    // since is passed to readLogsFromDir
    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/test-logs",
      "api",
      expect.objectContaining({
        since: new Date("2026-02-01T00:00:00Z"),
      }),
    );

    // route filtering happens in-memory — only spawn should appear in routes
    expect(json.routes["POST /api/spawn"]).toBeDefined();
    expect(json.routes["POST /api/spawn"].count).toBe(1);
    expect(json.routes["GET /api/sessions"]).toBeUndefined();
  });
});

// ── POST /api/client-logs ───────────────────────────────────────────────

describe("POST /api/client-logs", () => {
  it("returns 400 when body has no entries array", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({ something: "else" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/Missing entries/);
  });

  it("returns 400 when body is not an object", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify("just a string"),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toMatch(/Invalid request/);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: "not json at all",
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(400);
  });

  it("logs valid entries and skips invalid ones", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "page loaded", url: "/dashboard" },
          { level: "error", message: "fetch failed", stack: "Error: 500\n  at ..." },
          { level: "invalid-level", message: "bad level" }, // invalid: level not in set
          { notAMessage: true }, // invalid: no message field
          { level: "warn", message: "slow render", timing: { ttfb: 120 } },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(3); // info, error, warn are valid; 2 invalid skipped

    // Verify append was called 3 times with correct structure
    expect(mockLogWriterAppend).toHaveBeenCalledTimes(3);

    // Check first call (info entry)
    const firstCall = mockLogWriterAppend.mock.calls[0][0];
    expect(firstCall.level).toBe("info");
    expect(firstCall.source).toBe("browser");
    expect(firstCall.message).toBe("page loaded");
    expect(firstCall.data).toEqual({ url: "/dashboard" });

    // Check second call (error entry with stack)
    const secondCall = mockLogWriterAppend.mock.calls[1][0];
    expect(secondCall.level).toBe("error");
    expect(secondCall.message).toBe("fetch failed");
    expect(secondCall.data).toHaveProperty("stack");

    // Check third call (warn entry with timing)
    const thirdCall = mockLogWriterAppend.mock.calls[2][0];
    expect(thirdCall.level).toBe("warn");
    expect(thirdCall.message).toBe("slow render");
    expect(thirdCall.data).toEqual({ timing: { ttfb: 120 } });
  });

  it("returns logged: 0 when writer is unavailable", async () => {
    mockResolveProjectLogDir.mockReturnValue(null);

    // Force re-import to reset the cached logWriter
    // Since logWriter is module-level, we need a fresh module
    vi.resetModules();

    // Re-apply the mock after resetModules
    vi.doMock("@composio/ao-core", () => ({
      resolveProjectLogDir: () => null,
      loadConfig: () => ({}),
      LogWriter: vi.fn().mockImplementation(() => ({
        append: mockLogWriterAppend,
        appendLine: vi.fn(),
        close: vi.fn(),
      })),
    }));

    const { POST: freshPost } = await import("../app/api/client-logs/route.js");

    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [{ level: "info", message: "test" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await freshPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(0);
  });

  it("returns correct count for empty entries array", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({ entries: [] }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(0);
  });

  it("includes optional fields (url, stack, timing) in data when present", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          {
            level: "error",
            message: "API call failed",
            url: "/api/sessions",
            stack: "TypeError: fetch failed\n  at fetchSessions (app.js:42)",
            timing: { fetchMs: 2500, renderMs: 12 },
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.logged).toBe(1);

    const call = mockLogWriterAppend.mock.calls[0][0];
    expect(call.level).toBe("error");
    expect(call.message).toBe("API call failed");
    expect(call.data).toEqual({
      url: "/api/sessions",
      stack: "TypeError: fetch failed\n  at fetchSessions (app.js:42)",
      timing: { fetchMs: 2500, renderMs: 12 },
    });
  });

  it("omits optional fields from data when they are falsy", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          {
            level: "info",
            message: "page loaded",
            url: undefined,
            stack: null,
            timing: undefined,
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.logged).toBe(1);

    // Falsy optional fields should not appear in data
    const call = mockLogWriterAppend.mock.calls[0][0];
    expect(call.data).toEqual({});
    expect(call.data).not.toHaveProperty("url");
    expect(call.data).not.toHaveProperty("stack");
    expect(call.data).not.toHaveProperty("timing");
  });

  it("logs multiple valid entries in a batch and returns correct count", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "page loaded" },
          { level: "warn", message: "slow render" },
          { level: "error", message: "crash detected" },
          { level: "info", message: "navigation complete" },
          { level: "warn", message: "memory high" },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(5);
    expect(mockLogWriterAppend).toHaveBeenCalledTimes(5);

    // Verify each call has source: "browser" and sessionId: null
    for (let i = 0; i < 5; i++) {
      const call = mockLogWriterAppend.mock.calls[i][0];
      expect(call.source).toBe("browser");
      expect(call.sessionId).toBeNull();
      expect(call.ts).toBeDefined();
    }
  });

  it("accepts a mix of valid and invalid entries (partial acceptance)", async () => {
    const req = new Request("http://localhost:3000/api/client-logs", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          { level: "info", message: "good entry 1" },            // valid
          { level: "debug", message: "bad level" },               // invalid: "debug" not in VALID_LEVELS
          { level: "error", message: "good entry 2" },            // valid
          42,                                                      // invalid: not an object
          null,                                                    // invalid: null
          { level: "warn" },                                      // invalid: no message
          { message: "no level" },                                // invalid: no level
          { level: "warn", message: "good entry 3" },             // valid
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await clientLogsPost(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.logged).toBe(3); // Only 3 valid entries

    expect(mockLogWriterAppend).toHaveBeenCalledTimes(3);
    expect(mockLogWriterAppend.mock.calls[0][0].message).toBe("good entry 1");
    expect(mockLogWriterAppend.mock.calls[1][0].message).toBe("good entry 2");
    expect(mockLogWriterAppend.mock.calls[2][0].message).toBe("good entry 3");
  });
});
