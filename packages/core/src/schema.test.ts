import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_IDS } from "./clients.js";
import { buildSchema, validateAgainstSchema } from "./schema.js";
import { checkSchemas } from "./schema/self-check.js";

describe("schemas", () => {
  it("compiles every client schema and matches the committed files", () => {
    const problems = checkSchemas(false);
    expect(problems).toEqual([]);
    for (const id of CLIENT_IDS) {
      const schema = buildSchema(id);
      expect(schema.$schema).toContain("2020-12");
      expect(schema.description.length).toBeGreaterThan(20);
      expect(() => validateAgainstSchema(id, {})).not.toThrow();
    }
  });

  it("rejects a server whose command is not a string", () => {
    const errors = validateAgainstSchema("claude-desktop", {
      mcpServers: { filesystem: { command: 12 } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("keeps the canonical schema required fields", () => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../schemas/canonical.schema.json",
    );
    const schema = JSON.parse(readFileSync(file, "utf8")) as { required?: string[] };
    expect(schema.required).toContain("servers");
  });
});
