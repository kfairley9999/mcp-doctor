import { describe, expect, it } from "vitest";
import { analyzeConfig } from "./analyze.js";
import { parseJsonDocument } from "./document.js";
import { applySafeFixes, lintConfig } from "./lint.js";
import { parseConfig } from "./parse.js";
import { lineFromOffset, lineOfName } from "./util.js";

describe("line lookup", () => {
  it("maps offsets to lines with a cached index", () => {
    const text = "a\nbb\n\nccc";
    expect(lineFromOffset(text, 0)).toBe(1);
    expect(lineFromOffset(text, 2)).toBe(2);
    expect(lineFromOffset(text, 5)).toBe(3);
    expect(lineFromOffset(text, 6)).toBe(4);
    expect(lineFromOffset(text, 999)).toBe(4);
  });

  it("points at the server key, not an earlier string with the same text", () => {
    const text = [
      "{",
      '  "mcpServers": {',
      '    "fs": { "command": "npx", "args": ["github"] },',
      '    "github": { "command": "npx", "args": ["pkg"] }',
      "  }",
      "}",
    ].join("\n");
    expect(lineOfName(text, "github")).toBe(4);
    expect(lineOfName(text, "missing")).toBe(1);
    expect(lineOfName("[mcp_servers.a]\nx = 1\n[mcp_servers.b]\n", "b")).toBe(3);
  });

  it("stays fast on a config with hundreds of servers", () => {
    const servers = Object.fromEntries(
      Array.from({ length: 800 }, (_, i) => [`s${i}`, { command: "npx", args: ["pkg"] }]),
    );
    const text = JSON.stringify({ mcpServers: servers }, null, 2);
    const started = performance.now();
    const parsed = parseConfig(text, "cursor");
    const found = lintConfig({ client: parsed.client, raw: parsed.raw, text });
    expect(found.filter((item) => item.code === "npx-missing-yes")).toHaveLength(800);
    expect(found.find((item) => item.server === "s799")?.line).toBe(lineOfName(text, "s799"));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("hostile input", () => {
  it("reports deeply nested JSON as a diagnostic instead of throwing", () => {
    const deep = "[".repeat(100_000);
    const document = parseJsonDocument(deep);
    expect(document.ok).toBe(false);
    if (!document.ok) expect(document.diagnostics[0]?.message).toMatch(/nested too deeply/);
    expect(() => analyzeConfig(deep, undefined, { convert: true })).not.toThrow();
  });
});

describe("safe fixes", () => {
  it("adds -y after splitting an npx command string, so one pass is enough", () => {
    const text = JSON.stringify({ mcpServers: { a: { command: "npx some-pkg --flag" } } });
    const parsed = parseConfig(text, "cursor");
    const diagnostics = lintConfig({ client: parsed.client, raw: parsed.raw, text });
    const fixed = applySafeFixes(parsed.config, diagnostics);
    expect(fixed.servers[0]?.command).toBe("npx");
    expect(fixed.servers[0]?.args).toEqual(["-y", "some-pkg", "--flag"]);
    const again = applySafeFixes(
      { servers: [{ name: "b", transport: "stdio", command: "npx --yes pkg" }] },
      [{ severity: "error", code: "command-contains-args", message: "", server: "b" }],
    );
    expect(again.servers[0]?.args).toEqual(["--yes", "pkg"]);
  });
});
