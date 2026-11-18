import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { candidatePaths } from "./discover.js";
import { doctor } from "./doctor.js";
import { detectVersionManagers, nodeProbe, readTextFile, which } from "./runtime.js";

const fixture = path.resolve(
  fileURLToPath(new URL("../../../../fixtures/servers/stdio-ok.mjs", import.meta.url)),
);

describe("doctor", () => {
  it("reads a project config, handshakes it, and does not write", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-doctor-"));
    const home = path.join(root, "home");
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    const file = path.join(root, ".cursor", "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [fixture] },
        },
      }),
    );
    const before = statSync(file).mtimeMs;
    const listing = readdirSync(root);
    const report = await doctor({
      cwd: root,
      home,
      platform: "linux",
      env: { PATH: process.env.PATH ?? "", HOME: home },
      timeoutMs: 4000,
    });
    const found = report.files.find((item) => item.location.path === file);
    expect(found?.servers[0]?.handshake?.ok).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(readFileSync(file, "utf8")).toContain("fixture");
    expect(readdirSync(root)).toEqual(listing);
    expect(report.searched.some((item) => item.client === "claude-desktop")).toBe(true);
  });

  it("names the paths it would read on each platform", () => {
    const linux = candidatePaths({ cwd: "/work", home: "/home/dev", platform: "linux", env: {} });
    expect(
      linux.some((item) => item.path.endsWith("/.config/Claude/claude_desktop_config.json")),
    ).toBe(true);
    const mac = candidatePaths({ cwd: "/work", home: "/Users/dev", platform: "darwin", env: {} });
    expect(mac.some((item) => item.path.includes("Library/Application Support/Claude"))).toBe(true);
    const win = candidatePaths({
      cwd: "C:/work",
      home: "C:/Users/dev",
      platform: "win32",
      env: { APPDATA: "C:/Users/dev/AppData/Roaming" },
    });
    expect(
      win.some((item) => item.path.includes("AppData") && item.client === "claude-desktop"),
    ).toBe(true);
  });

  it("resolves executables and version-manager shims", () => {
    expect(which(process.execPath, process.env, process.platform)).toBe(process.execPath);
    expect(which("node", process.env, process.platform)).toBeTruthy();
    const home = mkdtempSync(path.join(tmpdir(), "mcp-doctor-vm-"));
    mkdirSync(path.join(home, ".nvm", "alias"), { recursive: true });
    mkdirSync(path.join(home, ".nvm", "versions", "node", "v22.14.0", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".nvm", "alias", "default"), "v22.14.0\n");
    writeFileSync(path.join(home, ".nvm", "versions", "node", "v22.14.0", "bin", "npx"), "");
    mkdirSync(path.join(home, ".volta", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".volta", "bin", "npx"), "");
    const managers = detectVersionManagers(home, "npx");
    expect(managers.map((item) => item.id)).toEqual(expect.arrayContaining(["nvm", "volta"]));
    expect(managers.find((item) => item.id === "nvm")?.shim).toContain("v22.14.0");
    mkdirSync(path.join(home, ".fnm", "aliases", "default", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".fnm", "aliases", "default", "bin", "npx"), "");
    mkdirSync(path.join(home, ".asdf", "shims"), { recursive: true });
    expect(detectVersionManagers(home, "npx").map((item) => item.id)).toEqual(
      expect.arrayContaining(["fnm", "asdf", "nvm"]),
    );
    expect(detectVersionManagers("", "npx")).toEqual([]);
    const winDir = path.join(home, "win");
    mkdirSync(winDir, { recursive: true });
    writeFileSync(path.join(winDir, "npx.CMD"), "");
    expect(which("npx", { PATH: `${winDir};;${winDir}`, PATHEXT: ".CMD" }, "win32")).toBe(
      path.join(winDir, "npx.CMD"),
    );
    mkdirSync(path.join(home, ".nvm-plain"), { recursive: true });
    writeFileSync(path.join(home, ".nvm", "alias", "default"), "lts/iron\n");
    expect(
      detectVersionManagers(home, "node").find((item) => item.id === "nvm")?.shim,
    ).toBeUndefined();
    expect(readTextFile(path.join(home, "missing"))).toBeUndefined();
    expect(nodeProbe().home.length).toBeGreaterThan(0);
  });

  it("reports an unreadable file and project-scoped Claude Code servers without starting them", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-doctor-ro-"));
    const file = path.join(root, ".mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { top: { command: "node", args: ["top.js"] } },
        projects: {
          "/work": { mcpServers: { nested: { type: "http", url: "https://example.com/mcp" } } },
        },
      }),
    );
    const report = await doctor({
      cwd: root,
      home: path.join(root, "home"),
      platform: "linux",
      env: { HOME: path.join(root, "home"), PATH: "" },
      handshakeServers: false,
      file: { path: file, client: "claude-code" },
    });
    expect(report.files[0]?.servers.map((server) => server.name)).toEqual(
      expect.arrayContaining(["top", expect.stringContaining("nested")]),
    );
    const missing = await doctor({
      cwd: root,
      home: path.join(root, "home"),
      platform: "linux",
      env: { HOME: path.join(root, "home") },
      handshakeServers: false,
      file: { path: path.join(root, "nope.json"), client: "cursor" },
    });
    expect(missing.files[0]?.read).toBe(false);
    writeFileSync(path.join(root, "bad.json"), "{");
    const invalid = await doctor({
      cwd: root,
      platform: "linux",
      env: {},
      handshakeServers: false,
      file: { path: path.join(root, "bad.json"), client: "cursor" },
    });
    expect(invalid.files[0]?.schemaErrors).toEqual([]);
    const defaults = await doctor({
      handshakeServers: false,
      cwd: root,
      env: { USERPROFILE: root },
      platform: "linux",
    });
    expect(defaults.searched.length).toBeGreaterThan(0);
    expect(
      candidatePaths({ cwd: root, home: root, platform: "win32", env: {} }).some((item) =>
        item.path.includes("AppData"),
      ),
    ).toBe(true);
  });
});
