import http from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { clipBody, handshake } from "./handshake.js";

describe("handshake diagnostics", () => {
  it("names stdout noise when a server never answers initialize", async () => {
    const report = await handshake(
      {
        name: "noisy",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "console.log('Server starting on stdio...'); setInterval(() => {}, 1000);"],
      },
      { timeoutMs: 800 },
    );
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("timeout");
    expect(report.error).toContain("non-JSON to stdout");
    expect(report.error).toContain("Server starting on stdio...");
  });

  it("keeps a plain timeout message when stdout stayed quiet", async () => {
    const report = await handshake(
      {
        name: "quiet",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
      },
      { timeoutMs: 500 },
    );
    expect(report.error).toBe("No initialize response after 500ms.");
  });

  it("reduces an HTML error page to a short line of text", async () => {
    const page = `<!doctype html><html><head><title>Example</title><style>body{color:red}</style></head><body><h1>Method Not Allowed</h1><p>${"filler ".repeat(200)}</p></body></html>`;
    const server = http.createServer((_request, response) => {
      response.writeHead(405, { "content-type": "text/html" });
      response.end(page);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const report = await handshake(
        { name: "web", transport: "http", url: `http://127.0.0.1:${address.port}/mcp` },
        { timeoutMs: 2000 },
      );
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/^HTTP 405: Example Method Not Allowed filler/);
      expect(report.error).not.toContain("<");
      expect(report.error).not.toContain("color:red");
      expect(report.error?.length ?? 0).toBeLessThan(330);
    } finally {
      server.close();
    }
  });

  it("clips plain bodies and redacts credentials", () => {
    expect(clipBody("  bad\n\n token ghp_abcdefghijklmnopqrstuvwxyz  ")).toBe(
      "bad token [redacted]",
    );
    expect(clipBody("x".repeat(1000))).toHaveLength(301);
  });
});
