import { describe, expect, it } from "vitest";
import { analyzeConfig, catalog } from "./analyze.js";
import { dropReason, parseClientId } from "./clients.js";
import { parseTomlDocument } from "./document.js";
import { emitConfig } from "./emit.js";
import { applySafeFixes, lintConfig, ruleFix } from "./lint.js";
import { claudeProjectServers, parseConfig } from "./parse.js";
import { basename, cloneConfigServers, isAbsolutePath, redact } from "./util.js";
import type { CanonicalConfig, ClientId } from "./types.js";

describe("gaps", () => {
  it("analyzes and catalogs", () => {
    const text = JSON.stringify({
      mcpServers: { fs: { command: "npx", args: ["-y", "pkg"] } },
      preferences: { a: 1 },
    });
    const full = analyzeConfig(text, "claude-desktop");
    expect(full.conversions.length).toBeGreaterThan(5);
    expect(full.valid).toBe(true);
    expect(analyzeConfig("{", "cursor").schemaErrors).toEqual([]);
    const partial = analyzeConfig(text, undefined, {
      convert: false,
      filePath: "claude_desktop_config.json",
    });
    expect(partial.conversions).toEqual([]);
    expect(partial.client).toBe("claude-desktop");
    const meta = catalog();
    expect(meta.rules).toHaveLength(15);
    expect(meta.clients[0]?.support.stdio).toBe(true);
    expect(parseClientId("  Gemini ")).toBe("gemini-cli");
    expect(parseClientId("nope")).toBeUndefined();
    expect(ruleFix("not-a-rule")).toMatch(/rule table/);
  });

  it("explains every dropped field", () => {
    const fields = [
      "url",
      "headers",
      "cwd",
      "envFile",
      "timeoutMs",
      "disabled",
      "autoApprove",
      "trust",
      "description",
      "ws",
      "sse",
      "nope",
    ];
    for (const field of fields) {
      expect(dropReason("cursor", field).length).toBeGreaterThan(5);
      expect(dropReason("claude-desktop", field).length).toBeGreaterThan(5);
      expect(dropReason("codex", field).length).toBeGreaterThan(5);
    }
  });

  it("parses awkward documents", () => {
    expect(parseTomlDocument("[\n").ok).toBe(false);
    expect(parseConfig("   ", "codex").diagnostics[0]?.code).toBe("empty");
    const coerced = parseConfig(
      JSON.stringify({
        mcpServers: {
          s: {
            command: "node",
            env: { N: 1, B: true, Z: null, O: { a: 1 } },
            args: "nope",
            autoApprove: "no",
          },
        },
      }),
      "cursor",
    );
    expect(coerced.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["env-coerced", "env-null", "invalid-type"]),
    );
    const legacy = parseConfig(
      JSON.stringify({
        context_servers: {
          old: { command: { path: "npx", args: ["-y", "pkg"], env: { A: "b" } } },
        },
      }),
      "zed",
    );
    expect(legacy.config.servers[0]?.command).toBe("npx");
    expect(legacy.diagnostics.some((item) => item.code === "zed-legacy-command")).toBe(true);
    const projects = parseConfig(
      JSON.stringify({
        projects: {
          "/work": { mcpServers: { local: { command: "node", args: ["s.js"] }, bad: "nope" } },
        },
      }),
      "claude-code",
    );
    const groups = claudeProjectServers(
      projects.raw,
      projects.diagnostics.length >= 0 ? JSON.stringify(projects.raw) : "",
    );
    expect(groups[0]?.servers[0]?.name).toBe("local");
    expect(groups[0]?.diagnostics.some((item) => item.code === "server-not-object")).toBe(true);
    expect(
      parseConfig(JSON.stringify({ servers: [{ name: "", transport: "nope" }, "x"] }), "canonical")
        .diagnostics.length,
    ).toBeGreaterThan(0);
    expect(
      parseConfig(
        JSON.stringify({ mcpServers: { s: { command: 1, timeout: "soon" } } }),
        "claude-code",
      ).diagnostics.some((d) => d.code === "invalid-type"),
    ).toBe(true);
  });

  it("emits the awkward transports and units", () => {
    const config: CanonicalConfig = {
      servers: [
        { name: "sock", transport: "ws", url: "wss://example.com/socket" },
        {
          name: "events",
          transport: "sse",
          url: "https://example.com/sse",
          command: "node",
          args: ["a"],
          env: { A: "b" },
          cwd: "/tmp",
          envFile: ".env",
        },
        {
          name: "slow",
          transport: "stdio",
          command: "node",
          timeoutMs: 1500,
          disabled: false,
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
        { name: "both", transport: "stdio", command: "npx -y pkg", url: "https://example.com/mcp" },
      ],
      extras: { theme: "dark" },
    };
    const codex = emitConfig(config, "codex", "claude-code");
    expect(codex.text).toContain("bearer_token_env_var");
    expect(codex.text).toContain("startup_timeout_sec");
    expect(codex.report.dropped.some((item) => item.server === "sock")).toBe(true);
    const gemini = emitConfig(
      {
        servers: [
          {
            name: "h",
            transport: "http",
            url: "https://example.com/mcp",
            headers: { A: "b", Authorization: "Bearer ${TOKEN}" },
          },
        ],
      },
      "gemini-cli",
      "cursor",
    );
    expect(gemini.text).toContain("httpUrl");
    const desktop = emitConfig(
      { servers: [{ name: "h", transport: "http", url: "https://example.com/mcp" }] },
      "claude-desktop",
      "cursor",
    );
    expect(desktop.text).not.toContain("example.com");
    const canonical = emitConfig(config, "canonical", "cursor");
    expect(canonical.report.dropped.some((item) => item.field === "theme")).toBe(true);
  });

  it("lints the remaining rules and applies fixes", () => {
    const findings = lintConfig({
      client: "claude-code",
      text: "config",
      raw: {
        mcpServers: {
          a: {
            command: "npm",
            args: ["exec", "pkg"],
            env: { GITHUB_TOKEN: "ghp_exampleExampleExampleExample12", API_KEY: "" },
            url: "http://example.com/mcp",
            httpUrl: "https://example.com/mcp",
            type: "stdio",
          },
          b: { command: "C:/Program Files/node/npx.cmd", args: ["-y", "pkg"] },
          c: { command: "node", args: ["~/data"], cwd: "./work", timeout: 10 },
        },
        projects: { "/p": { mcpServers: { d: { command: "npx", args: ["pkg"] } }, other: 1 } },
      },
      probe: {
        platform: "linux",
        env: { TOKEN: "set" },
        home: "/home/dev",
        which: (command) => (command === "node" ? "/usr/local/bin/node" : undefined),
        versionManagers: (command) =>
          command === "node" ? [{ id: "volta", root: "/home/dev/.volta" }] : [],
      },
    });
    expect(findings.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "npx-missing-yes",
        "plaintext-secret",
        "relative-path",
        "suspicious-timeout",
        "version-manager-shadow",
      ]),
    );
    const fixed = applySafeFixes(
      {
        servers: [
          { name: "a", transport: "stdio", command: "npx", args: ["pkg"] },
          { name: "b", transport: "stdio", command: "npx -y pkg", args: [] },
        ],
      },
      [
        { severity: "error", code: "npx-missing-yes", message: "", server: "a", suggestion: "" },
        {
          severity: "error",
          code: "command-contains-args",
          message: "",
          server: "b",
          suggestion: "",
        },
      ],
    );
    expect(fixed.servers[0]?.args?.[0]).toBe("-y");
    expect(fixed.servers[1]?.command).toBe("npx");
    expect(
      redact(
        "ghp_exampleExampleExampleExample12 github_pat_exampleExampleExampleExample sk-ant-abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz123 xoxb-1234567890-abcdef AKIAIOSFODNN7EXAMPLE Bearer supersecret",
      ),
    ).not.toContain("ghp_");
    expect(isAbsolutePath("C:\\Windows\\npx.cmd")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(basename("C:\\tools\\npx.bat")).toBe("npx");
    expect(basename("/usr/bin/node.exe")).toBe("node");
    expect(cloneConfigServers({ a: 1 })).toEqual({ a: 1 });
  });

  it("covers client detection filenames", () => {
    const paths: [string, ClientId][] = [
      ["C:/Users/a/claude_desktop_config.json", "claude-desktop"],
      ["/work/.mcp.json", "claude-code"],
      ["/home/.claude.json", "claude-code"],
      ["/work/.cursor/mcp.json", "cursor"],
      ["/work/.vscode/mcp.json", "vscode"],
      ["/home/.config/Code/User/mcp.json", "vscode"],
      ["/home/.codeium/windsurf/mcp_config.json", "windsurf"],
      ["/tmp/mcp_config.local.json", "windsurf"],
      ["/tmp/cline_mcp_settings.json", "cline"],
      ["/home/.cline/mcp.json", "cline"],
      ["/home/.codex/config.toml", "codex"],
      ["/work/.gemini/settings.json", "gemini-cli"],
      ["/home/.config/zed/settings.json", "zed"],
      ["/work/.zed/settings.json", "zed"],
    ];
    for (const [file, client] of paths) {
      expect(parseConfig("{}", client, file).client).toBe(client);
    }
    expect(parseConfig('{"servers":[{"name":"a","transport":"stdio"}]}').client).toBe("canonical");
    expect(parseConfig('{"type":"streamableHttp","mcpServers":{}}').client).toBe("cline");
    expect(parseConfig('{"servers":{"a":{"type":"stdio"}}}').assumed).toBe(true);
  });
});
