import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { isPortAvailable, findAvailablePort } from "../../src/lib/web-dir.js";

/**
 * Bind a TCP server to a port on 127.0.0.1.
 * Returns the server handle for cleanup.
 */
function occupyPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port, "127.0.0.1");
  });
}

describe("isPortAvailable", () => {
  it("returns true for a free port", async () => {
    // Use a high ephemeral port unlikely to be in use
    const result = await isPortAvailable(19876);
    expect(result).toBe(true);
  });

  it("returns false for an occupied port", async () => {
    const server = await occupyPort(19877);
    try {
      const result = await isPortAvailable(19877);
      expect(result).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("findAvailablePort", () => {
  it("returns the base port when it is free", async () => {
    const port = await findAvailablePort(19880);
    expect(port).toBe(19880);
  });

  it("skips occupied ports and returns the next free one", async () => {
    // Occupy 19890 and 19891
    const s1 = await occupyPort(19890);
    const s2 = await occupyPort(19891);
    try {
      const port = await findAvailablePort(19890);
      expect(port).toBe(19892);
    } finally {
      s1.close();
      s2.close();
    }
  });
});
