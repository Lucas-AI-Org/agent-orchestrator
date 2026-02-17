/**
 * Port utilities — low-level port availability check.
 *
 * Higher-level port allocation is handled by PortManager service.
 */

import { createServer } from "node:net";

/**
 * Check if a port is available by attempting to bind to it.
 * Returns true if the port is free, false if it's in use.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      server.close();
      resolve(false);
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}
