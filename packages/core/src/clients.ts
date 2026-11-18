import { CLIENT_IDS, type ClientId, type Interpolation, type Support } from "./types.js";

export interface Profile {
  id: ClientId;
  label: string;
  format: "json" | "toml";
  /** Object key that holds the server map. Canonical uses an array and ignores this for emit shape. */
  rootKey: string;
  /** True when the client's parser accepts comments and trailing commas. */
  jsonc: boolean;
  doc: string;
  /** Filename users actually edit. */
  configFile: string;
  interpolation: Interpolation;
  support: Support;
  /** Field written for an HTTP URL. Null when the client cannot store a remote server. */
  urlField: "url" | "serverUrl" | "httpUrl" | null;
  /** Gemini stores SSE on `url` and streamable HTTP on `httpUrl`. */
  sseUrlField?: "url";
  /** False when http and sse collapse to one URL field and cannot be told apart later. */
  distinguishesRemote: boolean;
  summary: string;
}

const STDIO_BASE: Support = {
  stdio: true,
  http: false,
  sse: false,
  ws: false,
  command: true,
  args: true,
  env: true,
  cwd: false,
  envFile: false,
  headers: false,
  timeoutMs: false,
  disabled: false,
  autoApprove: false,
  trust: false,
  description: false,
};

function support(overrides: Partial<Support>): Support {
  return { ...STDIO_BASE, ...overrides };
}

export const PROFILES: Record<ClientId, Profile> = {
  canonical: {
    id: "canonical",
    label: "Canonical",
    format: "json",
    rootKey: "servers",
    jsonc: false,
    doc: "https://github.com/modelcontextprotocol/modelcontextprotocol/issues/292",
    configFile: "mcp.canonical.json",
    interpolation: "preserve",
    support: support({
      http: true,
      sse: true,
      ws: true,
      cwd: true,
      envFile: true,
      headers: true,
      timeoutMs: true,
      disabled: true,
      autoApprove: true,
      trust: true,
      description: true,
    }),
    urlField: "url",
    distinguishesRemote: true,
    summary:
      "mcp-doctor's interchange document. Every field the other clients can express has a home here.",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    format: "json",
    rootKey: "mcpServers",
    jsonc: false,
    doc: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    configFile: "claude_desktop_config.json",
    interpolation: "none",
    support: support({}),
    urlField: null,
    distinguishesRemote: false,
    summary:
      "stdio only. command, args, and env. A type of http is ignored and the server does not load.",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    format: "json",
    rootKey: "mcpServers",
    jsonc: false,
    doc: "https://code.claude.com/docs/en/mcp",
    configFile: ".mcp.json",
    interpolation: "shell",
    support: support({
      http: true,
      sse: true,
      ws: true,
      headers: true,
      timeoutMs: true,
    }),
    urlField: "url",
    distinguishesRemote: true,
    summary:
      "Project file .mcp.json. Remote entries need type plus url. ${VAR} and ${VAR:-default} expand in command, args, env, url, and headers.",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    format: "json",
    rootKey: "mcpServers",
    jsonc: true,
    doc: "https://cursor.com/docs/mcp",
    configFile: ".cursor/mcp.json",
    interpolation: "env-colon",
    support: support({
      http: true,
      sse: true,
      envFile: true,
      headers: true,
    }),
    urlField: "url",
    distinguishesRemote: false,
    summary:
      "Project .cursor/mcp.json or global ~/.cursor/mcp.json. Remote servers use url. Interpolation is ${env:NAME}, ${userHome}, and ${workspaceFolder}.",
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    format: "json",
    rootKey: "servers",
    jsonc: true,
    doc: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
    configFile: ".vscode/mcp.json",
    interpolation: "vscode",
    support: support({
      http: true,
      sse: true,
      cwd: true,
      envFile: true,
      headers: true,
    }),
    urlField: "url",
    distinguishesRemote: true,
    summary:
      "The key is servers, not mcpServers. type is required. Secrets go through inputs and ${input:id}. ${env:NAME} is the environment form.",
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    format: "json",
    rootKey: "mcpServers",
    jsonc: false,
    doc: "https://docs.devin.ai/windsurf/plugins/cascade/mcp",
    configFile: "mcp_config.json",
    interpolation: "windsurf",
    support: support({
      http: true,
      sse: true,
      headers: true,
    }),
    urlField: "serverUrl",
    distinguishesRemote: false,
    summary:
      "Remote servers use serverUrl. url is accepted by current Cascade and ignored by older Windsurf builds. ${env:NAME} and ${file:/path} expand.",
  },
  cline: {
    id: "cline",
    label: "Cline",
    format: "json",
    rootKey: "mcpServers",
    jsonc: false,
    doc: "https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx",
    configFile: "cline_mcp_settings.json",
    interpolation: "none",
    support: support({
      http: true,
      sse: true,
      headers: true,
      timeoutMs: true,
      disabled: true,
      autoApprove: true,
    }),
    urlField: "url",
    distinguishesRemote: true,
    summary:
      "Local servers use command. Remote HTTP must set type to streamableHttp. Omitting type on a url selects legacy SSE. disabled and autoApprove are Cline's.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    format: "toml",
    rootKey: "mcp_servers",
    jsonc: false,
    doc: "https://developers.openai.com/codex/config-reference",
    configFile: "~/.codex/config.toml",
    interpolation: "none",
    support: support({
      http: true,
      cwd: true,
      headers: true,
      timeoutMs: true,
      disabled: true,
    }),
    urlField: "url",
    distinguishesRemote: true,
    summary:
      "TOML tables under mcp_servers. url is streamable HTTP. Headers live in http_headers. A bearer token is bearer_token_env_var. Timeouts are seconds.",
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    format: "json",
    rootKey: "mcpServers",
    jsonc: false,
    doc: "https://geminicli.com/docs/tools/mcp-server/",
    configFile: "~/.gemini/settings.json",
    interpolation: "gemini",
    support: support({
      http: true,
      sse: true,
      cwd: true,
      headers: true,
      timeoutMs: true,
      trust: true,
      description: true,
    }),
    urlField: "httpUrl",
    sseUrlField: "url",
    distinguishesRemote: true,
    summary:
      "httpUrl is streamable HTTP, url is SSE, command is stdio. When more than one is set, precedence is httpUrl, then url, then command. $VAR and ${VAR} expand.",
  },
  zed: {
    id: "zed",
    label: "Zed",
    format: "json",
    rootKey: "context_servers",
    jsonc: true,
    doc: "https://zed.dev/docs/ai/mcp",
    configFile: "~/.config/zed/settings.json",
    interpolation: "none",
    support: support({
      http: true,
      sse: true,
      headers: true,
    }),
    urlField: "url",
    distinguishesRemote: false,
    summary:
      "Lives inside settings.json under context_servers, not mcpServers. command is a string. A remote server is a url. Zed does not document variable expansion.",
  },
};

const ALIASES: Record<string, ClientId> = {
  canonical: "canonical",
  "claude-desktop": "claude-desktop",
  claude_desktop: "claude-desktop",
  desktop: "claude-desktop",
  "claude-code": "claude-code",
  claude_code: "claude-code",
  claudecode: "claude-code",
  cursor: "cursor",
  vscode: "vscode",
  "vs-code": "vscode",
  "visual-studio-code": "vscode",
  code: "vscode",
  windsurf: "windsurf",
  cascade: "windsurf",
  cline: "cline",
  codex: "codex",
  "gemini-cli": "gemini-cli",
  gemini: "gemini-cli",
  zed: "zed",
};

export function parseClientId(input: string): ClientId | undefined {
  const key = input.trim().toLowerCase();
  return ALIASES[key];
}

export function clientList(): string {
  return CLIENT_IDS.join(", ");
}

export { CLIENT_IDS };

export function dropReason(client: ClientId, field: string): string {
  const label = PROFILES[client].label;
  switch (field) {
    case "url":
    case "headers":
      return client === "claude-desktop"
        ? `${label} only launches a local process. It does not store a remote URL or headers. The mcp-remote proxy is a workaround this tool will not invent for you.`
        : `${label} cannot carry ${field}.`;
    case "cwd":
      return `${label} does not document a working directory. The client will start the process with whatever directory it was launched from, often / for a GUI app.`;
    case "envFile":
      return `${label} has no envFile field. Inline the variables under env, or use the client's own interpolation.`;
    case "timeoutMs":
      return `${label} has no per-server timeout in the config this tool understands.`;
    case "disabled":
      return client === "codex"
        ? "Codex uses enabled = false. This converter writes that when disabled is set."
        : `${label} cannot disable a server inside the server entry. Remove the entry, or use the client's own UI.`;
    case "autoApprove":
      return `autoApprove is a Cline field. ${label} will ignore it.`;
    case "trust":
      return `trust is a Gemini CLI field. ${label} will ignore it.`;
    case "description":
      return `${label} has no description field on a server entry.`;
    case "ws":
      return `${label} cannot express a WebSocket MCP server. Claude Code can, with type "ws".`;
    case "sse":
      return `${label} cannot express an SSE transport separately from streamable HTTP.`;
    default:
      return `${label} has no equivalent for ${field}.`;
  }
}
