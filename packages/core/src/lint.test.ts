import { describe, expect, it } from "vitest";
import { RULES, lintConfig } from "./lint.js";
import type { EnvironmentProbe } from "./types.js";

function lint(
  text: string,
  client: Parameters<typeof lintConfig>[0]["client"] = "claude-desktop",
  probe?: EnvironmentProbe,
) {
  return lintConfig({
    client,
    raw: JSON.parse(text) as unknown,
    text,
    probe,
  });
}

function codes(text: string, client?: Parameters<typeof lint>[1], probe?: EnvironmentProbe) {
  return lint(text, client, probe).map((item) => item.code);
}

const probe = (partial: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  platform: "linux",
  env: {},
  home: "/home/dev",
  which: () => undefined,
  versionManagers: () => [],
  ...partial,
});

describe("lint rules", () => {
  it("has a fix for every rule", () => {
    expect(RULES).toHaveLength(15);
    for (const rule of RULES) expect(rule.fix.length).toBeGreaterThan(10);
  });

  it("flags npx without -y", () => {
    const findings = lint('{"mcpServers":{"fs":{"command":"npx","args":["pkg"]}}}');
    const hit = findings.find((item) => item.code === "npx-missing-yes");
    expect(hit?.suggestion).toMatch(/-y/);
  });

  it("accepts npx -y", () => {
    expect(codes('{"mcpServers":{"fs":{"command":"npx","args":["-y","pkg"]}}}')).not.toContain(
      "npx-missing-yes",
    );
  });

  it("warns about Windows shims and errors on win32", () => {
    const text = '{"mcpServers":{"fs":{"command":"npx","args":["-y","pkg"]}}}';
    expect(
      lint(text, "cursor", probe({ platform: "linux" })).find(
        (item) => item.code === "windows-cmd-wrapper",
      )?.severity,
    ).toBe("warning");
    expect(
      lint(text, "cursor", probe({ platform: "win32" })).find(
        (item) => item.code === "windows-cmd-wrapper",
      )?.severity,
    ).toBe("error");
    expect(
      codes(
        '{"mcpServers":{"fs":{"command":"cmd","args":["/c","npx","-y","pkg"]}}}',
        "cursor",
        probe({ platform: "win32" }),
      ),
    ).not.toContain("windows-cmd-wrapper");
  });

  it("flags a missing command and a shadowed version manager", () => {
    const text = '{"mcpServers":{"fs":{"command":"npx","args":["-y","pkg"]}}}';
    expect(codes(text, "cursor", probe())).toContain("command-not-on-path");
    const shadowed = lint(
      text,
      "cursor",
      probe({
        which: () => "/usr/bin/npx",
        versionManagers: () => [
          {
            id: "nvm",
            root: "/home/dev/.nvm",
            shim: "/home/dev/.nvm/versions/node/v22.14.0/bin/npx",
          },
        ],
      }),
    );
    const hit = shadowed.find((item) => item.code === "version-manager-shadow");
    expect(hit?.suggestion).toContain("/home/dev/.nvm/versions/node/v22.14.0/bin/npx");
    expect(shadowed.map((item) => item.code)).not.toContain("command-not-on-path");
  });

  it("flags the wrong interpolation and an unset variable", () => {
    const text = '{"mcpServers":{"api":{"type":"http","url":"https://example.com/${env:TOKEN}"}}}';
    const findings = lint(text, "claude-code", probe({ env: {} }));
    expect(findings.map((item) => item.code)).toContain("env-interpolation-syntax");
    expect(findings.map((item) => item.code)).toContain("missing-env-reference");
    expect(findings.find((item) => item.code === "env-interpolation-syntax")?.suggestion).toContain(
      "${TOKEN}",
    );
  });

  it("does not echo a plaintext token", () => {
    const token = "ghp_exampleExampleExampleExample12";
    const findings = lint(
      `{"mcpServers":{"gh":{"command":"npx","args":["-y","pkg"],"env":{"GITHUB_TOKEN":"${token}"}}}}`,
    );
    const hit = findings.find((item) => item.code === "plaintext-secret");
    expect(hit).toBeDefined();
    expect(hit?.message.includes(token)).toBe(false);
  });

  it("catches url versus serverUrl and transport mismatches", () => {
    expect(codes('{"mcpServers":{"r":{"url":"https://example.com/mcp"}}}', "windsurf")).toContain(
      "url-field-name",
    );
    expect(
      codes('{"mcpServers":{"r":{"serverUrl":"https://example.com/mcp"}}}', "cursor"),
    ).toContain("url-field-name");
    expect(
      codes('{"mcpServers":{"r":{"url":"https://example.com/mcp"}}}', "claude-code"),
    ).toContain("transport-mismatch");
    expect(codes('{"mcpServers":{"r":{"url":"https://example.com/mcp"}}}', "cline")).toContain(
      "transport-mismatch",
    );
    expect(codes('{"mcpServers":{"r":{"type":"http","command":"npx"}}}', "claude-code")).toContain(
      "remote-missing-url",
    );
    expect(codes('{"mcpServers":{"r":{}}}', "claude-desktop")).toContain("stdio-missing-command");
  });

  it("splits a command string and rejects relative paths and cleartext auth", () => {
    const split = lint('{"mcpServers":{"fs":{"command":"npx -y pkg"}}}');
    expect(split.find((item) => item.code === "command-contains-args")?.suggestion).toContain(
      '"npx"',
    );
    expect(codes('{"mcpServers":{"fs":{"command":"node","args":["./server.js"]}}}')).toContain(
      "relative-path",
    );
    const insecure = lint(
      '{"mcpServers":{"r":{"url":"http://example.com/mcp","headers":{"Authorization":"Bearer abc"}}}}',
      "cursor",
    );
    expect(insecure.find((item) => item.code === "insecure-http")?.severity).toBe("error");
  });

  it("catches a timeout written in the wrong unit", () => {
    expect(codes('{"mcpServers":{"s":{"command":"node","timeout":30}}}', "gemini-cli")).toContain(
      "suspicious-timeout",
    );
    const toml = { mcp_servers: { s: { command: "node", startup_timeout_sec: 30000 } } };
    const findings = lintConfig({ client: "codex", raw: toml, text: "" });
    expect(findings.map((item) => item.code)).toContain("suspicious-timeout");
  });
});
