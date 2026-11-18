import { Validator, type Schema } from "@cfworker/json-schema";
import { PROFILES } from "./clients.js";
import { CLIENT_IDS, type ClientId } from "./types.js";

export interface JsonSchema {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  type: "object";
  additionalProperties: true;
  properties: Record<string, unknown>;
  required?: string[];
  $defs?: Record<string, unknown>;
}

const META = "https://json-schema.org/draft/2020-12/schema";

const stringMap = {
  type: "object",
  additionalProperties: { type: "string" },
} as const;

const stringArray = { type: "array", items: { type: "string" } } as const;

export function buildSchema(id: ClientId): JsonSchema {
  const profile = PROFILES[id];
  if (id === "canonical") return canonicalSchema();
  if (id === "codex") return codexSchema();
  const server = serverSchema(id);
  const properties: Record<string, unknown> = {
    [profile.rootKey]: {
      type: "object",
      description: `Server map for ${profile.label}.`,
      additionalProperties: server,
    },
  };
  if (id === "vscode") {
    properties.inputs = {
      type: "array",
      description: "Prompted values referenced as ${input:id}.",
      items: {
        type: "object",
        required: ["type", "id", "description"],
        additionalProperties: true,
        properties: {
          type: { enum: ["promptString", "pickString"] },
          id: { type: "string", minLength: 1 },
          description: { type: "string" },
          password: { type: "boolean" },
          default: { type: "string" },
        },
      },
    };
    properties.sandbox = { type: "object", additionalProperties: true };
  }
  return {
    $schema: META,
    $id: `https://mcp-doctor.local/schemas/${id}.schema.json`,
    title: `${profile.label} MCP config`,
    description: `${profile.summary} Shape documented at ${profile.doc}. Field meaning is enforced by mcp-doctor's lints; this schema checks types.`,
    type: "object",
    additionalProperties: true,
    properties,
  };
}

function canonicalSchema(): JsonSchema {
  return {
    $schema: META,
    $id: "https://mcp-doctor.local/schemas/canonical.schema.json",
    title: "mcp-doctor canonical config",
    description: PROFILES.canonical.summary,
    type: "object",
    additionalProperties: true,
    required: ["servers"],
    properties: {
      servers: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["name", "transport"],
          properties: {
            name: { type: "string", minLength: 1 },
            transport: { enum: ["stdio", "http", "sse", "ws"] },
            command: { type: "string" },
            args: stringArray,
            env: stringMap,
            cwd: { type: "string" },
            envFile: { type: "string" },
            url: { type: "string" },
            headers: stringMap,
            timeoutMs: { type: "number" },
            disabled: { type: "boolean" },
            autoApprove: stringArray,
            trust: { type: "boolean" },
            description: { type: "string" },
            extensions: { type: "object" },
          },
        },
      },
    },
  };
}

function codexSchema(): JsonSchema {
  const profile = PROFILES.codex;
  return {
    $schema: META,
    $id: "https://mcp-doctor.local/schemas/codex.schema.json",
    title: "Codex config.toml MCP tables",
    description: `${profile.summary} This schema describes the TOML document after parsing, not the TOML syntax. Documented at ${profile.doc}.`,
    type: "object",
    additionalProperties: true,
    properties: {
      mcp_servers: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: true,
          properties: {
            command: { type: "string" },
            args: stringArray,
            env: stringMap,
            cwd: { type: "string" },
            url: { type: "string" },
            http_headers: stringMap,
            env_http_headers: stringMap,
            bearer_token_env_var: { type: "string" },
            startup_timeout_sec: { type: "number" },
            startup_timeout_ms: { type: "number" },
            enabled: { type: "boolean" },
          },
        },
      },
    },
  };
}

function serverSchema(id: ClientId): Record<string, unknown> {
  const profile = PROFILES[id];
  const properties: Record<string, unknown> = {};
  if (profile.support.command) properties.command = { type: "string", minLength: 1 };
  if (profile.support.args) properties.args = stringArray;
  if (profile.support.env) properties.env = stringMap;
  if (profile.support.cwd) properties.cwd = { type: "string" };
  if (profile.support.envFile) properties.envFile = { type: "string" };
  if (profile.urlField) properties[profile.urlField] = { type: "string" };
  if (profile.sseUrlField && profile.sseUrlField !== profile.urlField) {
    properties[profile.sseUrlField] = { type: "string" };
  }
  if (id === "windsurf") properties.url = { type: "string" };
  if (profile.support.headers) properties.headers = stringMap;
  if (profile.support.timeoutMs) properties.timeout = { type: "number" };
  if (profile.support.disabled && id !== "codex") properties.disabled = { type: "boolean" };
  if (profile.support.autoApprove) properties.autoApprove = stringArray;
  if (profile.support.trust) properties.trust = { type: "boolean" };
  if (profile.support.description) properties.description = { type: "string" };
  if (id === "zed") properties.source = { type: "string" };
  if (id === "claude-code") {
    properties.type = { enum: ["stdio", "http", "sse", "ws", "streamable-http"] };
  }
  if (id === "vscode") {
    properties.type = { enum: ["stdio", "http", "sse"] };
  }
  if (id === "cline") {
    properties.type = { enum: ["stdio", "sse", "streamableHttp", "ws"] };
  }
  if (id === "cursor") {
    properties.type = { type: "string" };
  }
  return {
    type: "object",
    additionalProperties: true,
    properties,
  };
}

let validators: Map<ClientId, Validator> | undefined;

function validatorFor(id: ClientId): Validator {
  if (!validators) {
    const compiled = new Map<ClientId, Validator>();
    for (const client of CLIENT_IDS) {
      compiled.set(
        client,
        new Validator(buildSchema(client) as unknown as Schema, "2020-12", false),
      );
    }
    validators = compiled;
  }
  const found = validators.get(id);
  if (!found) throw new Error(`no schema for ${id}`);
  return found;
}

export interface SchemaError {
  path: string;
  message: string;
}

export function validateAgainstSchema(client: ClientId, value: unknown): SchemaError[] {
  const result = validatorFor(client).validate(value);
  if (result.valid) return [];
  return result.errors.map((error) => ({
    path: error.instanceLocation.length > 0 ? error.instanceLocation : "/",
    message: error.error,
  }));
}

export function schemaDocument(id: ClientId): string {
  return `${JSON.stringify(buildSchema(id), null, 2)}\n`;
}
