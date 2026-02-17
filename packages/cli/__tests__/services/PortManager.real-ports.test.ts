/**
 * PortManager integration test — uses real port binding (no mocks).
 *
 * Verifies that PortManager correctly detects occupied ports and
 * falls back to the next available port.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { PortManager } from "../../src/services/PortManager.js";

/** Bind to a port and return the server (for cleanup). */
function occupyPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    // Bind on all interfaces (default) to match isPortAvailable() behavior
    server.listen(port);
  });
}

// Use high ports to avoid conflicts with other services
const BASE_PORT = 19_100;

describe("PortManager (real ports)", () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const s of servers) {
      s.close();
    }
    servers.length = 0;
  });

  it("should find the preferred port when it is free", async () => {
    const pm = new PortManager();
    const port = await pm.findAvailable(BASE_PORT);
    expect(port).toBe(BASE_PORT);
  });

  it("should skip an occupied port and return the next available", async () => {
    const server = await occupyPort(BASE_PORT + 10);
    servers.push(server);

    const pm = new PortManager();
    const port = await pm.findAvailable(BASE_PORT + 10);
    expect(port).toBe(BASE_PORT + 11);
  });

  it("should skip multiple occupied ports", async () => {
    servers.push(await occupyPort(BASE_PORT + 20));
    servers.push(await occupyPort(BASE_PORT + 21));
    servers.push(await occupyPort(BASE_PORT + 22));

    const pm = new PortManager();
    const port = await pm.findAvailable(BASE_PORT + 20);
    expect(port).toBe(BASE_PORT + 23);
  });

  it("should throw when all ports in range are occupied", async () => {
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
      servers.push(await occupyPort(BASE_PORT + 30 + i));
    }

    const pm = new PortManager();
    await expect(pm.findAvailable(BASE_PORT + 30, maxAttempts)).rejects.toThrow(
      /Could not find available port/,
    );
  });

  it("should allocate service ports avoiding occupied ones", async () => {
    // Occupy the default dashboard port
    servers.push(await occupyPort(BASE_PORT + 40));

    const pm = new PortManager();
    const ports = await pm.allocateServicePorts(BASE_PORT + 40);

    // Dashboard should skip to next port
    expect(ports.dashboard).toBe(BASE_PORT + 41);
    // WebSocket ports should be allocated from their defaults (3001, 3003)
    expect(typeof ports.terminalWs).toBe("number");
    expect(typeof ports.directTerminalWs).toBe("number");
    // All three must be different
    const allPorts = [ports.dashboard, ports.terminalWs, ports.directTerminalWs];
    expect(new Set(allPorts).size).toBe(3);
  });

  it("should not double-allocate even with real port checks", async () => {
    const pm = new PortManager();
    const port1 = await pm.findAvailable(BASE_PORT + 50);
    const port2 = await pm.findAvailable(BASE_PORT + 50);

    expect(port1).toBe(BASE_PORT + 50);
    expect(port2).toBe(BASE_PORT + 51);
    expect(port1).not.toBe(port2);
  });
});
