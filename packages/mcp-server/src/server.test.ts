import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createDoctorServer } from "./server.js";

async function call(name: string, args: Record<string, unknown>) {
  const server = createDoctorServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  await server.close();
  const content = result.content as { type: string; text: string }[];
  const text = content[0]?.text ?? "";
  return { text, isError: result.isError === true };
}

describe("mcp server", () => {
  it("validates, lints, and converts through the official SDK", async () => {
    const text = JSON.stringify({
      mcpServers: { filesystem: { command: "npx", args: ["pkg"] } },
    });
    const valid = await call("validate_config", { text, client: "claude-desktop" });
    expect(valid.isError).toBe(false);
    expect(valid.text).toContain("claude-desktop");

    const lint = await call("lint_config", { text, client: "claude-desktop" });
    expect(lint.text).toContain("npx-missing-yes");

    const converted = await call("convert_config", { text, from: "claude-desktop", to: "vscode" });
    const body = JSON.parse(converted.text) as { output: string };
    expect(body.output).toContain('"servers"');
    expect(body.output).toContain('"stdio"');
  });

  it("lists configs without starting servers and handshakes the fixture", async () => {
    const listed = await call("list_client_configs", {
      root: "/tmp/mcp-doctor-empty",
      home: "/tmp/mcp-doctor-empty-home",
    });
    expect(listed.text).toContain("searched");

    const fixture = path.resolve(
      fileURLToPath(new URL("../../../fixtures/servers/stdio-ok.mjs", import.meta.url)),
    );
    const diagnosis = await call("diagnose_server", {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
      timeoutMs: 4000,
    });
    expect(diagnosis.text).toContain('"ok": true');
    expect(diagnosis.text).toContain("fixture");
  });

  it("lists a real config file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-doctor-srv-"));
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "node", args: ["server.js"] } } }),
    );
    const listed = await call("list_client_configs", { root, home: root });
    expect(listed.text).toContain("docs");
    expect(listed.text).toContain("cursor");
    const failed = await call("diagnose_server", { url: "http://127.0.0.1:1", timeoutMs: 400 });
    expect(failed.isError).toBe(true);
    const bare = await call("diagnose_server", {});
    expect(bare.text).toContain("spawn");
    const remote = await call("diagnose_server", {
      name: "remote",
      transport: "http",
      url: "http://127.0.0.1:1",
      headers: { A: "b" },
      env: { A: "b" },
      timeoutMs: 400,
    });
    expect(remote.isError).toBe(true);
    const envLint = await call("lint_config", {
      text: JSON.stringify({ mcpServers: { a: { command: "node" } } }),
      includeEnvironment: true,
    });
    expect(envLint.text).toContain("diagnostics");
  });

  it("rejects an unknown client", async () => {
    const result = await call("validate_config", { text: "{}", client: "notepad" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown client");
  });
});
