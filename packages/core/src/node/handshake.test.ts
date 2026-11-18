import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handshake } from "./handshake.js";

const fixtureDir = path.resolve(
  fileURLToPath(new URL("../../../../fixtures/servers/", import.meta.url)),
);

function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  });
}

describe("handshake", () => {
  it("initializes the fixture stdio server and lists tools", async () => {
    const report = await handshake(
      {
        name: "fixture",
        transport: "stdio",
        command: process.execPath,
        args: [path.join(fixtureDir, "stdio-ok.mjs")],
      },
      { timeoutMs: 4000 },
    );
    expect(report.ok).toBe(true);
    expect(report.serverName).toBe("fixture");
    expect(report.protocolVersion).toBe("2025-06-18");
    expect(report.tools).toEqual(["ping"]);
  });

  it("falls back when the server only speaks the 2024 protocol", async () => {
    const report = await handshake(
      {
        name: "legacy",
        transport: "stdio",
        command: process.execPath,
        args: [path.join(fixtureDir, "stdio-legacy.mjs")],
      },
      { timeoutMs: 4000 },
    );
    expect(report.ok).toBe(true);
    expect(report.protocolVersion).toBe("2024-11-05");
    expect(report.serverName).toBe("legacy");
  });

  it("reports a timeout, garbage, and a missing binary", async () => {
    const hung = await handshake(
      {
        name: "hang",
        transport: "stdio",
        command: process.execPath,
        args: [path.join(fixtureDir, "stdio-hang.mjs")],
      },
      { timeoutMs: 300 },
    );
    expect(hung.ok).toBe(false);
    expect(hung.stage).toBe("timeout");

    const garbage = await handshake(
      {
        name: "garbage",
        transport: "stdio",
        command: process.execPath,
        args: [path.join(fixtureDir, "stdio-garbage.mjs")],
      },
      { timeoutMs: 2000 },
    );
    expect(garbage.ok).toBe(false);
    expect(garbage.stage === "exit" || garbage.stage === "initialize").toBe(true);

    const missing = await handshake(
      { name: "missing", transport: "stdio", command: "mcp-doctor-not-a-binary" },
      { timeoutMs: 2000 },
    );
    expect(missing.ok).toBe(false);
    expect(missing.stage).toBe("spawn");
  });

  it("skips disabled servers and refuses websocket", async () => {
    const skipped = await handshake({
      name: "off",
      transport: "stdio",
      command: "node",
      disabled: true,
    });
    expect(skipped.skipped).toBe(true);
    const ws = await handshake({ name: "sock", transport: "ws", url: "wss://example.com/socket" });
    expect(ws.stage).toBe("unsupported");
  });

  it("handshakes a local HTTP server and an SSE server", async () => {
    const httpServer = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const message = body ? (JSON.parse(body) as { id?: number }) : {};
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "http-fixture", version: "1.0.0" },
          },
        });
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess" });
        response.end(payload);
      });
    });
    const port = await listen(httpServer);
    try {
      const report = await handshake(
        { name: "http", transport: "http", url: `http://127.0.0.1:${port}/mcp` },
        { timeoutMs: 3000 },
      );
      expect(report.ok).toBe(true);
      expect(report.serverName).toBe("http-fixture");
    } finally {
      httpServer.close();
    }

    const sse = http.createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: endpoint\ndata: /message\n\n");
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const message = JSON.parse(body) as { id?: number };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "sse-fixture", version: "1.0.0" },
            },
          }),
        );
      });
    });
    const ssePort = await listen(sse);
    try {
      const report = await handshake(
        { name: "sse", transport: "sse", url: `http://127.0.0.1:${ssePort}/sse` },
        { timeoutMs: 3000 },
      );
      expect(report.ok).toBe(true);
      expect(report.serverName).toBe("sse-fixture");
    } finally {
      sse.closeAllConnections?.();
      sse.close();
    }
  });

  it("classifies HTTP redirects, JSON-RPC errors, aborts, and broken SSE", async () => {
    const redirect = await handshake(
      { name: "r", transport: "http", url: "http://example.test/mcp" },
      { timeoutMs: 1000, fetch: async () => new Response(null, { status: 302 }) },
    );
    expect(redirect.error).toContain("redirect");

    const rpc = await handshake(
      { name: "r", transport: "http", url: "http://example.test/mcp" },
      {
        timeoutMs: 1000,
        fetch: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nope" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(rpc.stage).toBe("initialize");

    const garbage = await handshake(
      { name: "r", transport: "http", url: "http://example.test/mcp" },
      { timeoutMs: 1000, fetch: async () => new Response("hello", { status: 200 }) },
    );
    expect(garbage.error).toContain("not a JSON-RPC");

    const aborted = await handshake(
      { name: "r", transport: "http", url: "http://example.test/mcp" },
      {
        timeoutMs: 1000,
        fetch: async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      },
    );
    expect(aborted.stage).toBe("timeout");

    const sseMiss = await handshake(
      { name: "r", transport: "sse", url: "http://example.test/sse" },
      {
        timeoutMs: 1000,
        fetch: async () =>
          new Response("event: ping\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      },
    );
    expect(sseMiss.error).toContain("endpoint");

    const sseFail = await handshake(
      { name: "r", transport: "sse", url: "http://example.test/sse" },
      {
        timeoutMs: 1000,
        fetch: async (_url, init) => {
          if (init?.method === "GET") {
            return new Response("event: endpoint\ndata: /message\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          return new Response("nope", { status: 500 });
        },
      },
    );
    expect(sseFail.ok).toBe(false);
    expect(await handshake({ name: "r", transport: "http" })).toMatchObject({
      ok: false,
      stage: "http",
    });
    expect(await handshake({ name: "r", transport: "stdio", command: "   " })).toMatchObject({
      stage: "spawn",
    });
    const thrown = await handshake(
      { name: "r", transport: "http", url: "http://example.test/mcp" },
      { timeoutMs: 500, fetch: async () => Promise.reject(new Error("down")) },
    );
    expect(thrown.stage).toBe("http");
    const sseDown = await handshake(
      { name: "r", transport: "sse", url: "http://example.test/sse" },
      { timeoutMs: 500, fetch: async () => new Response(null, { status: 404 }) },
    );
    expect(sseDown.error).toContain("404");
  });

  it("reports an HTTP error body without throwing", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom");
    });
    const port = await listen(server);
    try {
      const report = await handshake(
        { name: "bad", transport: "http", url: `http://127.0.0.1:${port}/mcp` },
        { timeoutMs: 2000 },
      );
      expect(report.ok).toBe(false);
      expect(report.error).toContain("500");
    } finally {
      server.close();
    }
  });
});
