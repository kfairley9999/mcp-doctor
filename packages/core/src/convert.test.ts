import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_IDS, PROFILES } from "./clients.js";
import { emitConfig, serversEqual } from "./emit.js";
import { parseConfig } from "./parse.js";
import { validateAgainstSchema } from "./schema.js";
import type { CanonicalConfig, CanonicalServer, ClientId } from "./types.js";

interface Golden {
  id: string;
  client: ClientId;
  doc: string;
  text: string;
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/golden.json", import.meta.url)), "utf8"),
) as Golden[];

const stdio: CanonicalServer = {
  name: "docs",
  transport: "stdio",
  command: "npx",
  args: ["-y", "mcp-server"],
  env: { API_KEY: "value" },
};

describe("golden fixtures", () => {
  it("cites a public doc for every client", () => {
    for (const client of CLIENT_IDS) {
      if (client === "canonical") continue;
      expect(golden.some((item) => item.client === client && item.doc.startsWith("https://"))).toBe(
        true,
      );
    }
  });

  for (const fixture of golden) {
    it(`${fixture.id} parses and matches its schema`, () => {
      const parsed = parseConfig(fixture.text, fixture.client);
      expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(parsed.config.servers.length).toBeGreaterThan(0);
      expect(validateAgainstSchema(fixture.client, parsed.raw)).toEqual([]);
      const again = emitConfig(parsed.config, fixture.client, fixture.client);
      const round = parseConfig(again.text, fixture.client);
      expect(round.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(round.config.servers.map((server) => server.name)).toEqual(
        parsed.config.servers.map((server) => server.name),
      );
      expect(round.config.servers.map((server) => server.transport)).toEqual(
        parsed.config.servers.map((server) => server.transport),
      );
    });
  }
});

describe("client pairs", () => {
  const source: CanonicalConfig = { servers: [stdio] };

  for (const from of CLIENT_IDS) {
    for (const to of CLIENT_IDS) {
      it(`${from} -> ${to} keeps stdio command, args, and env`, () => {
        const first = emitConfig(source, from, "canonical");
        const parsed = parseConfig(first.text, from);
        const emitted = emitConfig(parsed.config, to, from);
        const back = parseConfig(emitted.text, to);
        expect(back.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
        const server = back.config.servers.find((item) => item.name === "docs");
        expect(server?.command).toBe("npx");
        expect(server?.args).toEqual(["-y", "mcp-server"]);
        expect(server?.env).toEqual({ API_KEY: "value" });
        expect(server?.transport).toBe("stdio");
        if (back.raw !== undefined) {
          expect(validateAgainstSchema(to, back.raw)).toEqual([]);
        }
      });
    }
  }
});

describe("fields that cannot be carried", () => {
  const rich: CanonicalConfig = {
    servers: [
      {
        ...stdio,
        cwd: "/tmp/work",
        envFile: ".env",
        timeoutMs: 30_000,
        disabled: true,
        autoApprove: ["ping"],
        trust: false,
        description: "docs server",
      },
      {
        name: "remote",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      { name: "events", transport: "sse", url: "https://example.com/sse" },
      { name: "socket", transport: "ws", url: "wss://example.com/socket" },
    ],
    extras: { preferences: { theme: "dark" } },
  };

  for (const to of CLIENT_IDS) {
    it(`reports losses when emitting to ${to}`, () => {
      const emitted = emitConfig(rich, to, "canonical");
      const profile = PROFILES[to];
      const parsed = parseConfig(emitted.text, to);
      const names = parsed.config.servers.map((server) => server.name);
      if (profile.support.ws) expect(names).toContain("socket");
      else expect(emitted.report.dropped.some((item) => item.server === "socket")).toBe(true);
      if (!profile.support.http && !profile.support.sse) {
        expect(
          emitted.report.dropped.some((item) => item.field === "url" || item.field === "transport"),
        ).toBe(true);
      } else {
        expect(names).toContain("remote");
        expect(parsed.config.servers.find((server) => server.name === "remote")?.url).toBe(
          "https://example.com/mcp",
        );
      }
      const docs = parsed.config.servers.find((server) => server.name === "docs");
      expect(docs).toBeDefined();
      if (!profile.support.cwd) {
        expect(
          emitted.report.dropped.some((item) => item.server === "docs" && item.field === "cwd"),
        ).toBe(true);
        expect(docs?.cwd).toBeUndefined();
      } else {
        expect(docs?.cwd).toBe("/tmp/work");
      }
      if (!profile.support.timeoutMs) expect(docs?.timeoutMs).toBeUndefined();
      else expect(docs?.timeoutMs).toBe(30_000);
      if (to !== "canonical") {
        expect(emitted.report.dropped.some((item) => item.field === "preferences")).toBe(true);
      }
    });
  }

  it("round-trips canonical without dropping modeled fields", () => {
    const emitted = emitConfig(rich, "canonical", "canonical");
    const parsed = parseConfig(emitted.text, "canonical");
    expect(emitted.report.dropped).toEqual([]);
    expect(parsed.config.servers.map((server) => stable(server))).toEqual(
      rich.servers.map((server) => stable(server)),
    );
  });
});

describe("detection and parse errors", () => {
  it("detects clients from filenames and shape", () => {
    expect(parseConfig('{"mcpServers":{}}', undefined, "/tmp/.cursor/mcp.json").client).toBe(
      "cursor",
    );
    expect(parseConfig('{"context_servers":{}}').client).toBe("zed");
    expect(parseConfig('[mcp_servers.docs]\ncommand = "node"\n').client).toBe("codex");
    expect(parseConfig("not json").diagnostics[0]?.code).toBe("invalid-json");
    expect(parseConfig("", "cursor").diagnostics[0]?.code).toBe("empty");
    expect(
      parseConfig("[]", "cursor").diagnostics.some((item) => item.code === "invalid-type"),
    ).toBe(true);
    expect(
      parseConfig('{"mcpServers":[]}', "cursor").diagnostics.some(
        (item) => item.code === "invalid-type",
      ),
    ).toBe(true);
  });

  it("rejects an unknown client and accepts JSONC only where documented", () => {
    expect(parseConfig("{}", "nope").diagnostics[0]?.code).toBe("unknown-client");
    const commented = '{\n  // note\n  "mcpServers": {}\n}\n';
    expect(
      parseConfig(commented, "claude-desktop").diagnostics.some(
        (item) => item.code === "jsonc-unsupported",
      ),
    ).toBe(true);
    expect(
      parseConfig(commented, "cursor").diagnostics.some(
        (item) => item.code === "jsonc-unsupported",
      ),
    ).toBe(false);
  });

  it("keeps Zed settings beside context servers", () => {
    const text =
      '{\n  "theme": "one",\n  "context_servers": {\n    "local": { "command": "node", "args": ["server.js"] }\n  }\n}\n';
    const parsed = parseConfig(text, "zed");
    const emitted = emitConfig(parsed.config, "zed", "zed");
    expect(emitted.text).toContain('"theme": "one"');
    expect(emitted.text).toContain('"source": "custom"');
  });
});

function stable(server: CanonicalServer): CanonicalServer {
  const copy = { ...server };
  expect(serversEqual(copy, server)).toBe(true);
  return copy;
}
