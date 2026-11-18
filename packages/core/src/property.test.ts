import { array, assert, constantFrom, property, record, stringMatching } from "fast-check";
import { describe, expect, it } from "vitest";
import { CLIENT_IDS } from "./clients.js";
import { emitConfig } from "./emit.js";
import { adaptInterpolation } from "./interpolate.js";
import { parseConfig } from "./parse.js";
import { validateAgainstSchema } from "./schema.js";
import type { CanonicalConfig, Interpolation } from "./types.js";

const name = stringMatching(/^[a-z][a-z0-9]{0,8}$/);
const token = stringMatching(/^[a-z0-9]{1,12}$/);

describe("properties", () => {
  it("stdio command, args, and env survive every client", () => {
    assert(
      property(
        name,
        array(token, { minLength: 1, maxLength: 3 }),
        record({ API_KEY: token }),
        constantFrom(...CLIENT_IDS),
        (serverName, args, env, client) => {
          const config: CanonicalConfig = {
            servers: [{ name: serverName, transport: "stdio", command: "node", args, env }],
          };
          const emitted = emitConfig(config, client, "canonical");
          const parsed = parseConfig(emitted.text, client);
          const server = parsed.config.servers.find((item) => item.name === serverName);
          expect(server?.command).toBe("node");
          expect(server?.args).toEqual(args);
          expect(server?.env).toEqual(env);
          expect(validateAgainstSchema(client, parsed.raw)).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("does not throw while parsing arbitrary text", () => {
    assert(
      property(
        stringMatching(/^[\x20-\x7e]{0,80}$/),
        constantFrom(...CLIENT_IDS),
        (text, client) => {
          expect(() => parseConfig(text, client)).not.toThrow();
        },
      ),
      { numRuns: 40 },
    );
  });

  it("adapts interpolation idempotently", () => {
    const targets: Interpolation[] = [
      "shell",
      "env-colon",
      "vscode",
      "windsurf",
      "gemini",
      "none",
      "preserve",
    ];
    assert(
      property(
        constantFrom(
          "npx",
          "${TOKEN}",
          "${env:TOKEN}",
          "$TOKEN",
          "%TOKEN%",
          "${TOKEN:-fallback}",
          "Bearer ${env:TOKEN}",
          "${workspaceFolder}/server.js",
          "${input:api-key}",
          "${file:/tmp/token}",
        ),
        constantFrom(...targets),
        (value, target) => {
          const once = adaptInterpolation(value, target);
          const twice = adaptInterpolation(once.value, target);
          expect(twice.value).toBe(once.value);
        },
      ),
    );
  });
});
