import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type Io } from "./run.js";

const broken = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["pkg", "./data"]
    }
  }
}`;

function capture(): Io & { text(): { out: string; err: string } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    text: () => ({ out: stdout.join(""), err: stderr.join("") }),
  };
}

describe("cli", () => {
  it("prints help and version", async () => {
    const help = capture();
    expect(await run(["--help"], help)).toBe(0);
    expect(help.text().out).toContain("mcp-doctor");
    const version = capture();
    expect(await run(["--version"], version)).toBe(0);
    expect(version.text().out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const missing = capture();
    expect(await run([], missing)).toBe(2);
  });

  it("lints text, json, and sarif", async () => {
    const io = capture();
    io.readFile = () => broken;
    expect(await run(["lint", "-", "--client", "claude-desktop", "--no-env"], io)).toBe(1);
    expect(io.text().out).toContain("npx-missing-yes");
    expect(io.text().out).toContain("relative-path");

    const json = capture();
    json.readFile = () => broken;
    expect(
      await run(["lint", "-", "--client", "claude-desktop", "--format", "json", "--no-env"], json),
    ).toBe(1);
    expect(JSON.parse(json.text().out).diagnostics.length).toBeGreaterThan(0);

    const sarif = capture();
    sarif.readFile = () => broken;
    expect(
      await run(
        ["lint", "-", "--client", "claude-desktop", "--format", "sarif", "--no-env"],
        sarif,
      ),
    ).toBe(1);
    const doc = JSON.parse(sarif.text().out) as { version: string; runs: { results: unknown[] }[] };
    expect(doc.version).toBe("2.1.0");
    expect(doc.runs[0]?.results.length).toBeGreaterThan(0);
  });

  it("converts cursor config to windsurf and reports the rename", async () => {
    const io = capture();
    const cursor = readExample("cursor.json");
    io.readFile = () => cursor;
    expect(await run(["convert", "-", "--from", "cursor", "--to", "windsurf"], io)).toBe(0);
    expect(io.text().out).toContain("serverUrl");
    expect(io.text().err).toContain("serverUrl");
  });

  it("validates a documented Claude Desktop config", async () => {
    const io = capture();
    io.readFile = () =>
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      });
    expect(await run(["validate", "-", "--client", "claude-desktop"], io)).toBe(0);
  });

  it("applies the npx fix without writing unless asked", async () => {
    const io = capture();
    io.readFile = () => broken;
    expect(
      await run(
        ["lint", "-", "--client", "claude-desktop", "--fix", "--no-env", "--format", "json"],
        io,
      ),
    ).toBe(1);
    expect(io.text().out).toContain('"-y"');
  });

  it("rejects bad usage", async () => {
    const io = capture();
    expect(await run(["nope"], io)).toBe(2);
    expect(await run(["validate"], io)).toBe(2);
    expect(await run(["validate", "-", "--client", "nope"], { ...io, readFile: () => "{}" })).toBe(
      2,
    );
    expect(await run(["lint"], io)).toBe(2);
    expect(await run(["lint", "-", "--format", "xml"], { ...io, readFile: () => "{}" })).toBe(2);
    expect(await run(["convert"], io)).toBe(2);
    expect(await run(["convert", "-"], { ...io, readFile: () => "{}" })).toBe(2);
    expect(await run(["convert", "-", "--to", "nope"], { ...io, readFile: () => "{}" })).toBe(2);
    expect(
      await run(["convert", "-", "--to", "cursor", "--from", "nope"], {
        ...io,
        readFile: () => "{}",
      }),
    ).toBe(2);
    expect(await run(["doctor", "--timeout", "nope"], io)).toBe(2);
    expect(await run(["doctor", "--file", "a.json"], io)).toBe(2);
    expect(await run(["doctor", "--client", "nope"], io)).toBe(2);
    const empty = capture();
    empty.cwd = "/tmp/mcp-doctor-nowhere";
    empty.env = { ...process.env, HOME: "/tmp/mcp-doctor-nowhere-home" };
    expect(
      await run(
        [
          "doctor",
          "--no-handshake",
          "--home",
          "/tmp/mcp-doctor-nowhere-home",
          "--root",
          "/tmp/mcp-doctor-nowhere",
        ],
        empty,
      ),
    ).toBe(0);
    expect(empty.text().out).toContain("No config files found");
    const strict = capture();
    strict.readFile = () =>
      JSON.stringify({ mcpServers: { a: { command: "node", args: ["./x"] } } });
    expect(
      await run(["lint", "-", "--client", "claude-desktop", "--strict", "--no-env"], strict),
    ).toBe(1);
    const wrapped = capture();
    wrapped.readFile = () => JSON.stringify({ output: true });
    expect(
      await run(["convert", "-", "--from", "cursor", "--to", "codex", "--format", "json"], {
        ...wrapped,
        readFile: () => '{"mcpServers":{"a":{"command":"node"}}}',
      }),
    ).toBe(0);
  });

  it("writes fixes, reports schema errors, and formats doctor results", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-doctor-cli2-"));
    const file = path.join(root, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["pkg"] } } }));
    const write = capture();
    expect(
      await run(
        ["lint", file, "--client", "claude-desktop", "--fix", "--write", "--no-env"],
        write,
      ),
    ).toBe(1);
    expect(readFileSync(file, "utf8")).toContain('"-y"');

    const bad = capture();
    expect(
      await run(["validate", file, "--client", "claude-desktop"], {
        ...bad,
        readFile: () => JSON.stringify({ mcpServers: { fs: { command: 1 } } }),
      }),
    ).toBe(1);
    expect(bad.text().out).toContain("schema");

    const broken = capture();
    expect(
      await run(["convert", "nope.json", "--to", "cursor"], { ...broken, readFile: () => "{" }),
    ).toBe(1);

    const out = path.join(root, "out.toml");
    const saved = capture();
    expect(
      await run(
        ["convert", file, "--from", "claude-desktop", "--to", "codex", "--output", out],
        saved,
      ),
    ).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("mcp_servers");

    const jsonDoctor = capture();
    expect(
      await run(
        ["doctor", "--format", "json", "--no-handshake", "--root", root, "--home", root],
        jsonDoctor,
      ),
    ).toBe(0);
    expect(JSON.parse(jsonDoctor.text().out).files).toBeInstanceOf(Array);

    const failing = path.join(root, "fail.json");
    writeFileSync(
      failing,
      JSON.stringify({
        mcpServers: {
          off: { command: "node", disabled: true },
          missing: { command: "mcp-doctor-missing-bin" },
        },
      }),
    );
    const doctorIo = capture();
    const code = await run(
      ["doctor", "--file", failing, "--client", "cursor", "--timeout", "1500", "--home", root],
      doctorIo,
    );
    expect(code).toBe(1);
    expect(doctorIo.text().out).toContain("fail");
    expect(doctorIo.text().out).toContain("skip");
    const sarif = capture();
    sarif.readFile = () => '{"mcpServers":{}}';
    expect(await run(["lint", "-", "--format", "sarif", "--no-env"], sarif)).toBe(0);
    expect(sarif.text().out).toContain('"note"');
  });

  it("doctors one file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-doctor-cli-"));
    const fixture = path.resolve(
      fileURLToPath(new URL("../../../fixtures/servers/stdio-ok.mjs", import.meta.url)),
    );
    const file = path.join(root, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }),
    );
    const io = capture();
    io.cwd = root;
    const code = await run(
      ["doctor", "--file", file, "--client", "cursor", "--timeout", "4000", "--home", root],
      io,
    );
    expect(code).toBe(0);
    expect(io.text().out).toContain("ok");
    expect(io.text().out).toContain("fixture");
  });
});

function readExample(name: string): string {
  const file = path.resolve(fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url)));
  return readFileSync(file, "utf8");
}
