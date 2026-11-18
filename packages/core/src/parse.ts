import { PROFILES, parseClientId } from "./clients.js";
import { parseJsonDocument, parseTomlDocument } from "./document.js";
import type { CanonicalConfig, CanonicalServer, ClientId, Diagnostic, Transport } from "./types.js";
import { diagnostic, isRecord, lineOfName } from "./util.js";

const CONSUMED = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "envFile",
  "url",
  "serverUrl",
  "httpUrl",
  "headers",
  "type",
  "timeout",
  "timeoutMs",
  "disabled",
  "autoApprove",
  "trust",
  "description",
  "enabled",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "http_headers",
  "bearer_token_env_var",
  "env_http_headers",
  "name",
  "transport",
  "extensions",
]);

export interface ResolvedTransport {
  transport: Transport;
  url?: string;
  notes: Diagnostic[];
}

export interface ParseResult {
  client: ClientId;
  assumed: boolean;
  config: CanonicalConfig;
  diagnostics: Diagnostic[];
  jsonc: boolean;
  raw: unknown;
}

export function detectClient(
  text: string,
  filePath?: string,
): { client: ClientId; assumed: boolean } {
  const hinted = filePath ? clientFromPath(filePath) : undefined;
  if (hinted) return { client: hinted, assumed: false };
  const trimmed = text.trim();
  if (
    trimmed.startsWith("[mcp_servers") ||
    trimmed.includes("\n[mcp_servers") ||
    /^mcp_servers\./m.test(trimmed)
  ) {
    return { client: "codex", assumed: false };
  }
  if (/"context_servers"\s*:/.test(text)) return { client: "zed", assumed: false };
  if (/"httpUrl"\s*:/.test(text)) return { client: "gemini-cli", assumed: false };
  if (/"serverUrl"\s*:/.test(text)) return { client: "windsurf", assumed: false };
  if (/"autoApprove"\s*:/.test(text)) return { client: "cline", assumed: false };
  if (/"inputs"\s*:/.test(text) && /"servers"\s*:/.test(text)) {
    return { client: "vscode", assumed: false };
  }
  if (/"servers"\s*:\s*\[/.test(text)) return { client: "canonical", assumed: false };
  if (/"servers"\s*:/.test(text) && /"type"\s*:/.test(text) && !/"mcpServers"\s*:/.test(text)) {
    return { client: "vscode", assumed: true };
  }
  if (/"type"\s*:\s*"(?:stdio|http|sse|ws|streamable-http)"/.test(text)) {
    return { client: "claude-code", assumed: true };
  }
  if (/"streamableHttp"\s*:/.test(text) || /"type"\s*:\s*"streamableHttp"/.test(text)) {
    return { client: "cline", assumed: true };
  }
  if (/"url"\s*:/.test(text) && /"mcpServers"\s*:/.test(text)) {
    return { client: "cursor", assumed: true };
  }
  if (/"mcpServers"\s*:/.test(text)) return { client: "claude-desktop", assumed: true };
  return { client: "canonical", assumed: true };
}

export function clientFromPath(filePath: string): ClientId | undefined {
  const value = filePath.replace(/\\/g, "/").toLowerCase();
  if (value.endsWith("claude_desktop_config.json")) return "claude-desktop";
  if (value.endsWith("/.mcp.json") || value.endsWith(".mcp.json")) return "claude-code";
  if (value.endsWith("/.claude.json") || value.endsWith("/claude.json")) return "claude-code";
  if (value.includes("/.cursor/") && value.endsWith("mcp.json")) return "cursor";
  if (value.endsWith("/.cursor/mcp.json")) return "cursor";
  if (value.includes("/.vscode/") && value.endsWith("mcp.json")) return "vscode";
  if (value.endsWith("/user/mcp.json")) return "vscode";
  if (value.endsWith("mcp_config.json") || value.endsWith("mcp_config.local.json")) {
    return "windsurf";
  }
  if (value.endsWith("cline_mcp_settings.json") || value.endsWith("/.cline/mcp.json")) {
    return "cline";
  }
  if (value.includes("/.codex/") && value.endsWith("config.toml")) return "codex";
  if (value.endsWith("/.gemini/settings.json") || value.includes("/.gemini/")) return "gemini-cli";
  if (value.includes("/zed/") && value.endsWith("settings.json")) return "zed";
  if (value.includes("/.zed/") && value.endsWith("settings.json")) return "zed";
  return undefined;
}

export function parseConfig(
  text: string,
  client?: ClientId | string,
  filePath?: string,
): ParseResult {
  const detected = detectClient(text, filePath);
  let resolved = detected.client;
  let assumed = detected.assumed;
  if (client !== undefined) {
    const parsed = typeof client === "string" ? (parseClientId(client) ?? undefined) : client;
    if (!parsed) {
      return {
        client: detected.client,
        assumed: true,
        config: { servers: [] },
        diagnostics: [
          diagnostic(
            "error",
            "unknown-client",
            `Unknown client "${String(client)}". Expected one of: ${Object.keys(PROFILES).join(", ")}.`,
          ),
        ],
        jsonc: false,
        raw: undefined,
      };
    }
    resolved = parsed;
    assumed = false;
  }
  return parseAs(text, resolved, assumed);
}

export function parseAs(text: string, client: ClientId, assumed: boolean): ParseResult {
  const profile = PROFILES[client];
  const parsed = profile.format === "toml" ? parseTomlDocument(text) : parseJsonDocument(text);
  if (!parsed.ok) {
    return {
      client,
      assumed,
      config: { servers: [] },
      diagnostics: parsed.diagnostics,
      jsonc: false,
      raw: undefined,
    };
  }
  const diagnostics: Diagnostic[] = [];
  if (assumed) {
    diagnostics.push(
      diagnostic(
        "info",
        "client-assumed",
        `No client was given. Reading this as ${profile.label}. Pass the client explicitly when the file could belong to more than one.`,
      ),
    );
  }
  if (parsed.jsonc && !profile.jsonc) {
    diagnostics.push(
      diagnostic(
        "error",
        "jsonc-unsupported",
        `${profile.label} loads this file with a strict JSON parser. Comments and trailing commas will fail there.`,
        { suggestion: "Remove comments and trailing commas." },
      ),
    );
  }
  if (!isRecord(parsed.value)) {
    diagnostics.push(
      diagnostic("error", "invalid-type", "The config root must be an object.", { path: "/" }),
    );
    return {
      client,
      assumed,
      config: { servers: [] },
      diagnostics,
      jsonc: parsed.jsonc,
      raw: parsed.value,
    };
  }
  const config = readRoot(parsed.value, client, diagnostics, text);
  return { client, assumed, config, diagnostics, jsonc: parsed.jsonc, raw: parsed.value };
}

function readRoot(
  root: Record<string, unknown>,
  client: ClientId,
  diagnostics: Diagnostic[],
  text: string,
): CanonicalConfig {
  if (client === "canonical") {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(root)) {
      if (key !== "servers") extras[key] = value;
    }
    const serversRaw = root.servers;
    if (serversRaw === undefined) {
      return { servers: [], ...(Object.keys(extras).length > 0 ? { extras } : {}) };
    }
    if (!Array.isArray(serversRaw)) {
      diagnostics.push(
        diagnostic("error", "invalid-type", "canonical servers must be an array.", {
          path: "/servers",
        }),
      );
      return { servers: [], ...(Object.keys(extras).length > 0 ? { extras } : {}) };
    }
    const servers: CanonicalServer[] = [];
    serversRaw.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
        diagnostics.push(
          diagnostic("error", "server-not-object", "Each canonical server needs a name.", {
            path: `/servers/${index}`,
          }),
        );
        return;
      }
      servers.push(
        serverFromEntry(entry.name, entry, client, diagnostics, text, `/servers/${index}`),
      );
    });
    return { servers, ...(Object.keys(extras).length > 0 ? { extras } : {}) };
  }

  const profile = PROFILES[client];
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key !== profile.rootKey) extras[key] = value;
  }
  const table = root[profile.rootKey];
  if (table === undefined) {
    return { servers: [], ...(Object.keys(extras).length > 0 ? { extras } : {}) };
  }
  if (!isRecord(table)) {
    diagnostics.push(
      diagnostic(
        "error",
        "invalid-type",
        `${profile.rootKey} must be an object keyed by server name.`,
        {
          path: `/${profile.rootKey}`,
        },
      ),
    );
    return { servers: [], ...(Object.keys(extras).length > 0 ? { extras } : {}) };
  }
  const servers: CanonicalServer[] = [];
  for (const [name, entry] of Object.entries(table)) {
    const path = `/${profile.rootKey}/${name}`;
    if (!isRecord(entry)) {
      diagnostics.push(
        diagnostic("error", "server-not-object", `Server "${name}" must be an object.`, {
          path,
          server: name,
          line: lineOfName(text, name),
        }),
      );
      continue;
    }
    servers.push(serverFromEntry(name, entry, client, diagnostics, text, path));
  }
  return { servers, ...(Object.keys(extras).length > 0 ? { extras } : {}) };
}

export function serverFromEntry(
  name: string,
  entry: Record<string, unknown>,
  client: ClientId,
  diagnostics: Diagnostic[],
  text: string,
  path: string,
): CanonicalServer {
  const line = lineOfName(text, name);
  const resolved = resolveTransport(entry, client, name, path, line);
  const server: CanonicalServer = { name, transport: resolved.transport };
  if (resolved.url !== undefined) server.url = resolved.url;

  if (typeof entry.command === "string") server.command = entry.command;
  else if (isRecord(entry.command) && typeof entry.command.path === "string") {
    server.command = entry.command.path;
    if (
      Array.isArray(entry.command.args) &&
      entry.command.args.every((item) => typeof item === "string")
    ) {
      server.args = entry.command.args;
    }
    if (isRecord(entry.command.env)) {
      const env = readStringMap(entry.command.env, diagnostics, `${path}/command/env`, name, line);
      if (env) server.env = env;
    }
    diagnostics.push(
      diagnostic(
        "info",
        "zed-legacy-command",
        `Server "${name}" uses Zed's older command object. The flat command string is what current Zed writes.`,
        {
          path,
          server: name,
          line,
          suggestion: 'Use "command": "npx" and a sibling "args" array.',
        },
      ),
    );
  } else if (entry.command !== undefined) {
    diagnostics.push(
      diagnostic("error", "invalid-type", `command on "${name}" must be a string.`, {
        path: `${path}/command`,
        server: name,
        line,
      }),
    );
  }

  if (server.args === undefined && entry.args !== undefined) {
    const args = readArgs(entry.args, diagnostics, `${path}/args`, name, line);
    if (args) server.args = args;
  }
  if (server.env === undefined && entry.env !== undefined) {
    const env = readStringMap(entry.env, diagnostics, `${path}/env`, name, line);
    if (env) server.env = env;
  }
  if (typeof entry.cwd === "string") server.cwd = entry.cwd;
  if (typeof entry.envFile === "string") server.envFile = entry.envFile;

  const headers = readHeaders(entry, client, diagnostics, path, name, line);
  if (headers && Object.keys(headers).length > 0)
    server.headers = { ...server.headers, ...headers };

  const timeoutMs = readTimeout(entry, diagnostics, path, name, line);
  if (timeoutMs !== undefined) server.timeoutMs = timeoutMs;

  if (typeof entry.disabled === "boolean") server.disabled = entry.disabled;
  if (typeof entry.enabled === "boolean") server.disabled = !entry.enabled;
  if (
    Array.isArray(entry.autoApprove) &&
    entry.autoApprove.every((item) => typeof item === "string")
  ) {
    server.autoApprove = entry.autoApprove;
  } else if (entry.autoApprove !== undefined) {
    diagnostics.push(
      diagnostic("error", "invalid-type", `autoApprove on "${name}" must be an array of strings.`, {
        path: `${path}/autoApprove`,
        server: name,
        line,
      }),
    );
  }
  if (typeof entry.trust === "boolean") server.trust = entry.trust;
  if (typeof entry.description === "string") server.description = entry.description;

  const extensions: Record<string, unknown> = {};
  if (isRecord(entry.extensions)) Object.assign(extensions, entry.extensions);
  for (const [key, value] of Object.entries(entry)) {
    if (!CONSUMED.has(key)) extensions[key] = value;
  }
  if (Object.keys(extensions).length > 0) server.extensions = extensions;
  return server;
}

export function resolveTransport(
  entry: Record<string, unknown>,
  client: ClientId,
  name: string,
  path: string,
  line: number,
): ResolvedTransport {
  const notes: Diagnostic[] = [];
  if (client === "canonical") {
    const declared = mapType(typeof entry.transport === "string" ? entry.transport : undefined);
    if (entry.transport !== undefined && !declared) {
      notes.push(
        diagnostic(
          "error",
          "transport-mismatch",
          `Server "${name}" has transport "${String(entry.transport)}".`,
          {
            path: `${path}/transport`,
            server: name,
            line,
          },
        ),
      );
    }
    return { transport: declared ?? "stdio", url: stringField(entry.url), notes };
  }
  const typeRaw = typeof entry.type === "string" ? entry.type.trim() : undefined;
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const url = stringField(entry.url);
  const serverUrl = stringField(entry.serverUrl);
  const httpUrl = stringField(entry.httpUrl);
  const mapped = mapType(typeRaw);
  if (typeRaw && !mapped) {
    notes.push(
      diagnostic(
        "error",
        "transport-mismatch",
        `Server "${name}" has type "${typeRaw}", which is not a known transport.`,
        {
          path: `${path}/type`,
          server: name,
          line,
          suggestion: 'Use "stdio", "http", "sse", or "ws", or the client\'s own alias.',
        },
      ),
    );
  }

  if (client === "gemini-cli") {
    if (httpUrl && url && httpUrl !== url) {
      notes.push(
        diagnostic(
          "warning",
          "transport-mismatch",
          `Server "${name}" sets both httpUrl and url. Gemini CLI prefers httpUrl and will not open the SSE url.`,
          { path, server: name, line, suggestion: "Keep only the transport you mean." },
        ),
      );
    }
    if (httpUrl) return { transport: "http", url: httpUrl, notes };
    if (url) return { transport: "sse", url, notes };
    return { transport: "stdio", notes };
  }

  if (client === "windsurf") {
    if (serverUrl && url && serverUrl !== url) {
      notes.push(
        diagnostic(
          "error",
          "url-field-name",
          `Server "${name}" sets serverUrl and url to different values. Windsurf will not pick one for you.`,
          { path, server: name, line, suggestion: "Keep serverUrl and delete url." },
        ),
      );
    }
    const remote = serverUrl ?? url;
    if (remote) return { transport: "http", url: remote, notes };
    return { transport: "stdio", notes };
  }

  if (client === "claude-desktop") {
    const remote = url ?? serverUrl ?? httpUrl;
    if (remote && !command) {
      notes.push(
        diagnostic(
          "error",
          "transport-mismatch",
          `Server "${name}" is a remote entry. Claude Desktop's JSON config only launches stdio processes, and "type": "http" is skipped.`,
          {
            path,
            server: name,
            line,
            suggestion:
              "Run a local stdio proxy yourself, or convert this entry to a client that speaks HTTP.",
          },
        ),
      );
      return { transport: "http", url: remote, notes };
    }
    if (typeRaw && typeRaw !== "stdio") {
      notes.push(
        diagnostic(
          "warning",
          "transport-mismatch",
          `Server "${name}" sets type "${typeRaw}". Claude Desktop does not read type and will try to launch command.`,
          { path, server: name, line },
        ),
      );
    }
    return { transport: "stdio", url: remote, notes };
  }

  if (client === "codex") {
    if (url) return { transport: "http", url, notes };
    return { transport: "stdio", notes };
  }

  if (client === "cline") {
    if (mapped === "http" || typeRaw === "streamableHttp") return { transport: "http", url, notes };
    if (mapped === "sse") return { transport: "sse", url, notes };
    if (mapped === "ws") return { transport: "ws", url, notes };
    if ((url || serverUrl) && !command && !mapped) {
      notes.push(
        diagnostic(
          "warning",
          "transport-mismatch",
          `Server "${name}" has a url and no type. Cline treats that as legacy SSE, not streamable HTTP.`,
          {
            path,
            server: name,
            line,
            suggestion: 'Set "type": "streamableHttp" for a streamable HTTP endpoint.',
          },
        ),
      );
      return { transport: "sse", url: url ?? serverUrl, notes };
    }
    return { transport: mapped ?? "stdio", url: url ?? serverUrl, notes };
  }

  if (client === "claude-code" && (url || serverUrl || httpUrl) && !typeRaw) {
    notes.push(
      diagnostic(
        "error",
        "transport-mismatch",
        `Server "${name}" has a url and no type. Claude Code reads a typeless entry as stdio and skips it.`,
        {
          path,
          server: name,
          line,
          suggestion: 'Add "type": "http" (or "sse" / "ws") to match the endpoint.',
        },
      ),
    );
    return { transport: "http", url: url ?? serverUrl ?? httpUrl, notes };
  }

  const remote = url ?? serverUrl ?? httpUrl;
  if (mapped === "stdio" && remote && !command) {
    notes.push(
      diagnostic("error", "transport-mismatch", `Server "${name}" says stdio but only has a URL.`, {
        path,
        server: name,
        line,
        suggestion: "Set type to http or sse, or add a command.",
      }),
    );
  }
  if ((mapped === "http" || mapped === "sse" || mapped === "ws") && !remote && command) {
    notes.push(
      diagnostic(
        "error",
        "transport-mismatch",
        `Server "${name}" says ${mapped} but has a command and no URL.`,
        { path, server: name, line, suggestion: "Add the endpoint url, or change type to stdio." },
      ),
    );
  }
  if (mapped) return { transport: mapped, url: remote, notes };
  if (remote && !command) return { transport: "http", url: remote, notes };
  return { transport: "stdio", url: remote, notes };
}

function mapType(typeRaw: string | undefined): Transport | undefined {
  if (!typeRaw) return undefined;
  const value = typeRaw.toLowerCase();
  if (value === "stdio" || value === "local") return "stdio";
  if (value === "http" || value === "streamable-http" || value === "streamablehttp") return "http";
  if (value === "sse") return "sse";
  if (value === "ws" || value === "websocket") return "ws";
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readArgs(
  value: unknown,
  diagnostics: Diagnostic[],
  path: string,
  server: string,
  line: number,
): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    diagnostics.push(
      diagnostic("error", "invalid-type", "args must be an array of strings.", {
        path,
        server,
        line,
      }),
    );
    return undefined;
  }
  return value;
}

function readStringMap(
  value: unknown,
  diagnostics: Diagnostic[],
  path: string,
  server: string,
  line: number,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic("error", "invalid-type", `${path} must be an object of strings.`, {
        path,
        server,
        line,
      }),
    );
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
      diagnostics.push(
        diagnostic(
          "warning",
          "env-coerced",
          `${path}.${key} is not a string. It was coerced to "${String(entry)}". Several clients reject non-strings.`,
          { path: `${path}/${key}`, server, line },
        ),
      );
    } else if (entry === null) {
      diagnostics.push(
        diagnostic("warning", "env-null", `${path}.${key} is null and was dropped.`, {
          path: `${path}/${key}`,
          server,
          line,
        }),
      );
    } else {
      diagnostics.push(
        diagnostic("error", "invalid-type", `${path}.${key} must be a string.`, {
          path: `${path}/${key}`,
          server,
          line,
        }),
      );
    }
  }
  return out;
}

function readHeaders(
  entry: Record<string, unknown>,
  client: ClientId,
  diagnostics: Diagnostic[],
  path: string,
  server: string,
  line: number,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const direct = entry.headers ?? entry.http_headers;
  if (direct !== undefined) {
    const map = readStringMap(direct, diagnostics, `${path}/headers`, server, line);
    if (map) Object.assign(headers, map);
  }
  if (typeof entry.bearer_token_env_var === "string" && entry.bearer_token_env_var.length > 0) {
    headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
  }
  if (isRecord(entry.env_http_headers)) {
    for (const [header, variable] of Object.entries(entry.env_http_headers)) {
      if (typeof variable === "string") headers[header] = `\${${variable}}`;
    }
  }
  if (client === "codex" && entry.headers !== undefined) {
    diagnostics.push(
      diagnostic(
        "warning",
        "url-field-name",
        "Codex reads http_headers, not headers. The values were kept and will be written back as http_headers.",
        { path, server, line, suggestion: "Rename headers to http_headers." },
      ),
    );
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readTimeout(
  entry: Record<string, unknown>,
  diagnostics: Diagnostic[],
  path: string,
  server: string,
  line: number,
): number | undefined {
  const ms =
    readFinite(entry.timeoutMs) ??
    readFinite(entry.startup_timeout_ms) ??
    readFinite(entry.timeout);
  const sec = readFinite(entry.startup_timeout_sec);
  if (ms !== undefined && sec !== undefined) {
    diagnostics.push(
      diagnostic(
        "warning",
        "suspicious-timeout",
        `Server "${server}" sets both a millisecond timeout and startup_timeout_sec. The millisecond value was kept.`,
        { path, server, line },
      ),
    );
  }
  if (ms !== undefined) return ms;
  if (sec !== undefined) return Math.round(sec * 1000);
  if (
    entry.timeout !== undefined ||
    entry.timeoutMs !== undefined ||
    entry.startup_timeout_sec !== undefined
  ) {
    diagnostics.push(
      diagnostic("error", "invalid-type", `Timeout on "${server}" must be a finite number.`, {
        path,
        server,
        line,
      }),
    );
  }
  return undefined;
}

function readFinite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Project-scoped servers inside ~/.claude.json. The top-level map is parsed separately. */
export function claudeProjectServers(
  raw: unknown,
  text: string,
): { project: string; servers: CanonicalServer[]; diagnostics: Diagnostic[] }[] {
  if (!isRecord(raw) || !isRecord(raw.projects)) return [];
  const groups: { project: string; servers: CanonicalServer[]; diagnostics: Diagnostic[] }[] = [];
  for (const [project, body] of Object.entries(raw.projects)) {
    if (!isRecord(body) || !isRecord(body.mcpServers)) continue;
    const diagnostics: Diagnostic[] = [];
    const servers: CanonicalServer[] = [];
    for (const [name, entry] of Object.entries(body.mcpServers)) {
      const path = `/projects/${project}/mcpServers/${name}`;
      if (!isRecord(entry)) {
        diagnostics.push(
          diagnostic("error", "server-not-object", `Server "${name}" must be an object.`, {
            path,
            server: name,
          }),
        );
        continue;
      }
      servers.push(serverFromEntry(name, entry, "claude-code", diagnostics, text, path));
    }
    groups.push({ project, servers, diagnostics });
  }
  return groups;
}
