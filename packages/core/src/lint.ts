import { PROFILES } from "./clients.js";
import { findTokens, isNative } from "./interpolate.js";
import { resolveTransport } from "./parse.js";
import type {
  CanonicalConfig,
  CanonicalServer,
  ClientId,
  Diagnostic,
  EnvironmentProbe,
} from "./types.js";
import { adaptInterpolation } from "./interpolate.js";
import { basename, diagnostic, isAbsolutePath, isRecord, lineOfName, redact } from "./util.js";

export interface RuleInfo {
  id: string;
  severity: "error" | "warning";
  summary: string;
  fix: string;
}

export const RULES: readonly RuleInfo[] = [
  {
    id: "npx-missing-yes",
    severity: "error",
    summary: "npx or npm exec will prompt, and a GUI client has no TTY to answer.",
    fix: 'Put "-y" (npx) or "--yes" (npm exec) first in args.',
  },
  {
    id: "windows-cmd-wrapper",
    severity: "warning",
    summary: "Windows cannot CreateProcess a .cmd shim such as npx.",
    fix: 'Set command to "cmd" and args to ["/c", "npx", ...]. See cline/cline#902.',
  },
  {
    id: "command-not-on-path",
    severity: "error",
    summary: "The stdio command does not resolve on PATH.",
    fix: "Install the runtime, or set command to an absolute path. GUI apps do not load your shell profile.",
  },
  {
    id: "version-manager-shadow",
    severity: "warning",
    summary: "node or npx resolves outside nvm, Volta, fnm, or asdf.",
    fix: "Point command at that manager's absolute shim. See modelcontextprotocol/servers#64.",
  },
  {
    id: "missing-env-reference",
    severity: "warning",
    summary: "A referenced environment variable is unset or empty where this process can see it.",
    fix: "Export it in the environment the client actually inherits, or set it under env.",
  },
  {
    id: "env-interpolation-syntax",
    severity: "error",
    summary: "The variable syntax belongs to a different client.",
    fix: "Rewrite it to the form that client expands. See the client column in the README.",
  },
  {
    id: "plaintext-secret",
    severity: "warning",
    summary: "A token, key, or placeholder is written into the file.",
    fix: "Replace the literal with the client's interpolation, and keep the value in the environment.",
  },
  {
    id: "url-field-name",
    severity: "error",
    summary: "The URL is stored under a field this client does not read.",
    fix: "Rename it to the field that client documents (url, serverUrl, or httpUrl).",
  },
  {
    id: "transport-mismatch",
    severity: "error",
    summary: "type, command, and url disagree, or a required type is missing.",
    fix: "Make type match the fields, and set the type Claude Code and Cline require.",
  },
  {
    id: "stdio-missing-command",
    severity: "error",
    summary: "A stdio server has no command.",
    fix: "Set command to an executable name or an absolute path.",
  },
  {
    id: "remote-missing-url",
    severity: "error",
    summary: "An HTTP, SSE, or WebSocket server has no URL.",
    fix: "Set the URL field this client reads.",
  },
  {
    id: "command-contains-args",
    severity: "error",
    summary:
      "command contains spaces, so the client will look for an executable by that whole string.",
    fix: "Split the program into command and the rest into args. Clients do not run a shell.",
  },
  {
    id: "relative-path",
    severity: "warning",
    summary:
      "A path is relative or uses ~, and the client's working directory is not your shell's.",
    fix: "Use an absolute path. ~ is not expanded by these clients.",
  },
  {
    id: "insecure-http",
    severity: "warning",
    summary: "A non-loopback URL is plain HTTP.",
    fix: "Use https. An Authorization header on http:// is an error.",
  },
  {
    id: "suspicious-timeout",
    severity: "warning",
    summary: "The timeout looks like it was written in the wrong unit.",
    fix: "Claude Code, Cline, and Gemini use milliseconds. Codex startup_timeout_sec uses seconds.",
  },
];

const RULE_INDEX = new Map(RULES.map((rule) => [rule.id, rule]));

export interface LintInput {
  client: ClientId;
  raw: unknown;
  text: string;
  probe?: EnvironmentProbe;
}

interface RawServer {
  name: string;
  entry: Record<string, unknown>;
  path: string;
  line: number;
}

export function lintConfig(input: LintInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const server of rawServers(input.raw, input.client, input.text)) {
    for (const rule of RULES) {
      diagnostics.push(...checkRule(rule.id, server, input));
    }
  }
  return diagnostics;
}

export function ruleFix(id: string): string {
  return RULE_INDEX.get(id)?.fix ?? "See the rule table.";
}

function rawServers(raw: unknown, client: ClientId, text: string): RawServer[] {
  if (!isRecord(raw)) return [];
  const found: RawServer[] = [];
  const push = (name: string, entry: unknown, path: string) => {
    if (!isRecord(entry)) return;
    found.push({ name, entry, path, line: lineOfName(text, name) });
  };
  if (client === "canonical" && Array.isArray(raw.servers)) {
    raw.servers.forEach((entry, index) => {
      if (isRecord(entry) && typeof entry.name === "string")
        push(entry.name, entry, `/servers/${index}`);
    });
    return found;
  }
  if (client === "codex" && isRecord(raw.mcp_servers)) {
    for (const [name, entry] of Object.entries(raw.mcp_servers))
      push(name, entry, `/mcp_servers/${name}`);
    return found;
  }
  const key = PROFILES[client].rootKey;
  const table = raw[key];
  if (isRecord(table)) {
    for (const [name, entry] of Object.entries(table)) push(name, entry, `/${key}/${name}`);
  }
  if (client === "claude-code" && isRecord(raw.projects)) {
    for (const [project, body] of Object.entries(raw.projects)) {
      if (!isRecord(body) || !isRecord(body.mcpServers)) continue;
      for (const [name, entry] of Object.entries(body.mcpServers)) {
        push(name, entry, `/projects/${project}/mcpServers/${name}`);
      }
    }
  }
  return found;
}

function checkRule(id: string, server: RawServer, input: LintInput): Diagnostic[] {
  switch (id) {
    case "npx-missing-yes":
      return npxMissingYes(server);
    case "windows-cmd-wrapper":
      return windowsWrapper(server, input.probe);
    case "command-not-on-path":
      return commandNotOnPath(server, input);
    case "version-manager-shadow":
      return versionManagerShadow(server, input.probe);
    case "missing-env-reference":
      return missingEnv(server, input);
    case "env-interpolation-syntax":
      return interpolationSyntax(server, input.client);
    case "plaintext-secret":
      return plaintextSecret(server, input.client);
    case "url-field-name":
      return urlFieldName(server, input.client);
    case "transport-mismatch":
      return transportMismatch(server, input.client);
    case "stdio-missing-command":
      return missingCommand(server, input.client);
    case "remote-missing-url":
      return missingUrl(server, input.client);
    case "command-contains-args":
      return commandContainsArgs(server);
    case "relative-path":
      return relativePath(server, input.client);
    case "insecure-http":
      return insecureHttp(server, input.client);
    case "suspicious-timeout":
      return suspiciousTimeout(server, input.client);
    default:
      return [];
  }
}

const SHIM_COMMANDS = new Set(["npx", "npm", "pnpm", "yarn"]);
const NODE_COMMANDS = new Set(["node", "npx", "npm", "pnpm"]);

function commandOf(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.command === "string") return entry.command;
  if (isRecord(entry.command) && typeof entry.command.path === "string") return entry.command.path;
  return undefined;
}

function argsOf(entry: Record<string, unknown>): string[] {
  return Array.isArray(entry.args)
    ? entry.args.filter((item): item is string => typeof item === "string")
    : [];
}

function npxMissingYes(server: RawServer): Diagnostic[] {
  const command = commandOf(server.entry);
  if (!command || /\s/.test(command.trim())) return [];
  const base = basename(command).toLowerCase();
  const args = argsOf(server.entry);
  if (base === "npx" && !args.includes("-y") && !args.includes("--yes")) {
    return [
      at(
        server,
        "error",
        "npx-missing-yes",
        `npx on "${server.name}" has no -y. The install prompt never gets a keypress when a client spawns it, so the server hangs.`,
        'Add "-y" as the first argument.',
      ),
    ];
  }
  if (
    (base === "npm" || base === "pnpm") &&
    (args[0] === "exec" || args[0] === "x") &&
    !args.includes("--yes") &&
    !args.includes("-y")
  ) {
    return [
      at(
        server,
        "error",
        "npx-missing-yes",
        `${base} exec on "${server.name}" can prompt. A client has no TTY to answer.`,
        'Add "--yes" before the package name.',
      ),
    ];
  }
  return [];
}

function windowsWrapper(server: RawServer, probe: EnvironmentProbe | undefined): Diagnostic[] {
  const command = commandOf(server.entry);
  if (!command) return [];
  const base = basename(command).toLowerCase();
  const args = argsOf(server.entry);
  if (base === "cmd" && (args[0] === "/c" || args[0] === "/C")) return [];
  const isShim = SHIM_COMMANDS.has(base) || /\.(cmd|bat)$/i.test(command);
  if (!isShim) return [];
  const win = probe?.platform === "win32";
  return [
    at(
      server,
      win ? "error" : "warning",
      "windows-cmd-wrapper",
      win
        ? `"${base}" is a .cmd shim. CreateProcess on Windows will fail with ENOENT unless cmd.exe launches it.`
        : `"${base}" works on this machine, and fails on Windows, because it is a .cmd shim. Shared configs hit this.`,
      `Use command "cmd" and args ${JSON.stringify(["/c", base, ...args])}.`,
    ),
  ];
}

function commandNotOnPath(server: RawServer, input: LintInput): Diagnostic[] {
  if (!input.probe) return [];
  const resolved = resolveTransport(
    server.entry,
    input.client,
    server.name,
    server.path,
    server.line,
  );
  if (resolved.transport !== "stdio") return [];
  const command = commandOf(server.entry);
  if (!command || command.trim() === "" || /\s/.test(command.trim())) return [];
  const probe = input.probe;
  if (probe.which(command)) return [];
  const base = basename(command);
  const manager = NODE_COMMANDS.has(base.toLowerCase())
    ? probe.versionManagers(base).find((item) => item.shim)
    : undefined;
  const suggestion = manager?.shim
    ? `${manager.id} is installed but not on this PATH. Set command to ${manager.shim}.`
    : "Install it, or set command to an absolute path. A GUI client does not source your shell rc.";
  return [
    at(
      server,
      "error",
      "command-not-on-path",
      `command "${command}" for "${server.name}" was not found on PATH.`,
      suggestion,
    ),
  ];
}

function versionManagerShadow(
  server: RawServer,
  probe: EnvironmentProbe | undefined,
): Diagnostic[] {
  if (!probe) return [];
  const command = commandOf(server.entry);
  if (!command || isAbsolutePath(command)) return [];
  const base = basename(command).toLowerCase();
  if (!NODE_COMMANDS.has(base)) return [];
  const resolved = probe.which(command);
  if (!resolved) return [];
  const out: Diagnostic[] = [];
  for (const manager of probe.versionManagers(base)) {
    if (resolved.startsWith(manager.root)) continue;
    out.push(
      at(
        server,
        "warning",
        "version-manager-shadow",
        `"${command}" resolves to ${resolved}, outside ${manager.id} at ${manager.root}. Terminal sessions and GUI apps then run different Node builds (modelcontextprotocol/servers#64).`,
        manager.shim
          ? `Set command to ${manager.shim}.`
          : `Set command to the absolute ${base} inside ${manager.root}. nvm itself is a shell function, so a GUI cannot see it.`,
      ),
    );
  }
  return out;
}

function missingEnv(server: RawServer, input: LintInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const env = isRecord(server.entry.env) ? server.entry.env : undefined;
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && value.trim() === "" && looksSecretKey(key)) {
        out.push(
          at(
            server,
            "warning",
            "missing-env-reference",
            `env.${key} on "${server.name}" is empty.`,
            `Set ${key} in the server's env block or in the environment the client inherits.`,
          ),
        );
      }
    }
  }
  if (!input.probe) return out;
  for (const token of tokensIn(server.entry)) {
    if (
      token.form === "default" ||
      token.form === "input" ||
      token.form === "file" ||
      token.form === "special"
    ) {
      continue;
    }
    if (input.probe.env[token.name] === undefined) {
      out.push(
        at(
          server,
          "warning",
          "missing-env-reference",
          `${token.raw} on "${server.name}" is not set in this environment.`,
          `Export ${token.name} where the client can see it. A desktop app often does not load the shell profile.`,
        ),
      );
    }
  }
  return out;
}

function interpolationSyntax(server: RawServer, client: ClientId): Diagnostic[] {
  const target = PROFILES[client].interpolation;
  if (target === "preserve") return [];
  const out: Diagnostic[] = [];
  for (const token of tokensIn(server.entry)) {
    if (isNative(token, target)) continue;
    const adapted = adaptInterpolation(token.raw, target);
    const suggestion =
      adapted.value !== token.raw
        ? `Write ${adapted.value}.`
        : (adapted.unsupported[0] ?? ruleFix("env-interpolation-syntax"));
    out.push(
      at(
        server,
        target === "none" ? "warning" : "error",
        "env-interpolation-syntax",
        `${token.raw} is not expanded by ${PROFILES[client].label}.`,
        suggestion,
      ),
    );
  }
  return out;
}

function plaintextSecret(server: RawServer, client: ClientId): Diagnostic[] {
  const out: Diagnostic[] = [];
  const form = nativeSecretForm(client);
  walkStrings(server.entry, (pointer, value) => {
    if (findTokens(value).length > 0) return;
    if (isPlaceholder(value)) {
      out.push(
        at(
          server,
          "warning",
          "plaintext-secret",
          `${pointer} on "${server.name}" is still a placeholder (${redact(value).slice(0, 40)}). The server will reject it.`,
          `Replace it with ${form}.`,
        ),
      );
      return;
    }
    const kind = secretKind(pointer, value);
    if (!kind) return;
    out.push(
      at(
        server,
        "warning",
        "plaintext-secret",
        `${pointer} on "${server.name}" looks like ${kind} written in the file.`,
        `Remove the literal and reference ${form}. The report does not echo the value.`,
      ),
    );
  });
  return out;
}

function urlFieldName(server: RawServer, client: ClientId): Diagnostic[] {
  const entry = server.entry;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  const serverUrl = typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  const httpUrl = typeof entry.httpUrl === "string" ? entry.httpUrl : undefined;
  if (client === "windsurf") {
    if (url && !serverUrl) {
      return [
        at(
          server,
          "warning",
          "url-field-name",
          `Windsurf's documented field is serverUrl. Older builds ignore url, so "${server.name}" never connects.`,
          "Rename url to serverUrl.",
        ),
      ];
    }
    return [];
  }
  if (client === "gemini-cli") {
    const notes: Diagnostic[] = [];
    if (serverUrl) {
      notes.push(
        at(
          server,
          "error",
          "url-field-name",
          "Gemini CLI does not read serverUrl.",
          "Use httpUrl for streamable HTTP or url for SSE.",
        ),
      );
    }
    if (url && !httpUrl && /\/mcp\/?($|\?)/.test(url)) {
      notes.push(
        at(
          server,
          "warning",
          "url-field-name",
          "Gemini CLI treats url as SSE. A path ending in /mcp is almost always streamable HTTP and belongs in httpUrl.",
          "Rename url to httpUrl.",
        ),
      );
    }
    return notes;
  }
  if (client === "canonical" || client === "codex") return [];
  if ((serverUrl || httpUrl) && !url) {
    const field = serverUrl ? "serverUrl" : "httpUrl";
    return [
      at(
        server,
        "error",
        "url-field-name",
        `${PROFILES[client].label} does not read ${field} on "${server.name}".`,
        "Rename it to url.",
      ),
    ];
  }
  return [];
}

function transportMismatch(server: RawServer, client: ClientId): Diagnostic[] {
  const resolved = resolveTransport(server.entry, client, server.name, server.path, server.line);
  return resolved.notes.filter(
    (note) => note.code === "transport-mismatch" || note.code === "url-field-name",
  );
}

function missingCommand(server: RawServer, client: ClientId): Diagnostic[] {
  const resolved = resolveTransport(server.entry, client, server.name, server.path, server.line);
  if (resolved.transport !== "stdio") return [];
  const command = commandOf(server.entry);
  if (command && command.trim() !== "") return [];
  if (resolved.notes.some((note) => note.code === "transport-mismatch")) return [];
  return [
    at(
      server,
      "error",
      "stdio-missing-command",
      `Stdio server "${server.name}" has no command, so the client has nothing to spawn.`,
      "Set command to the executable.",
    ),
  ];
}

function missingUrl(server: RawServer, client: ClientId): Diagnostic[] {
  const resolved = resolveTransport(server.entry, client, server.name, server.path, server.line);
  if (resolved.transport === "stdio") return [];
  if (resolved.url && resolved.url.trim() !== "") return [];
  return [
    at(
      server,
      "error",
      "remote-missing-url",
      `${resolved.transport} server "${server.name}" has no URL.`,
      `Set ${PROFILES[client].urlField ?? "url"}.`,
    ),
  ];
}

function commandContainsArgs(server: RawServer): Diagnostic[] {
  const command = commandOf(server.entry);
  if (!command || !/\s/.test(command.trim())) return [];
  const trimmed = command.trim();
  const looksLikePath =
    (trimmed.includes("/") || trimmed.includes("\\")) &&
    !/ -/.test(trimmed) &&
    !/^(npx|npm|pnpm|yarn|node|python3?|uvx|uv|docker|bun)\s/.test(trimmed);
  if (looksLikePath) return [];
  const parts = splitCommandLine(trimmed);
  const [program, ...rest] = parts;
  if (!program) return [];
  return [
    at(
      server,
      "error",
      "command-contains-args",
      `command for "${server.name}" contains spaces. The client looks up that whole string as the executable and does not invoke a shell.`,
      `Set command to ${JSON.stringify(program)} and prepend ${JSON.stringify(rest)} to args.`,
    ),
  ];
}

function relativePath(server: RawServer, client: ClientId): Diagnostic[] {
  const out: Diagnostic[] = [];
  const command = commandOf(server.entry);
  if (command && isRelative(command)) {
    out.push(
      at(
        server,
        "warning",
        "relative-path",
        `command "${command}" is not absolute. ${PROFILES[client].label} may start with cwd / when launched from a GUI.`,
        "Use an absolute path.",
      ),
    );
  }
  for (const arg of argsOf(server.entry)) {
    if (!isRelative(arg)) continue;
    out.push(
      at(
        server,
        "warning",
        "relative-path",
        `Argument "${arg}" on "${server.name}" is relative or uses ~. These clients do not expand ~ and do not share your shell's cwd.`,
        "Use an absolute path.",
      ),
    );
  }
  if (typeof server.entry.cwd === "string" && isRelative(server.entry.cwd)) {
    out.push(
      at(
        server,
        "warning",
        "relative-path",
        `cwd "${server.entry.cwd}" is relative.`,
        "Use an absolute directory.",
      ),
    );
  }
  return out;
}

function insecureHttp(server: RawServer, client: ClientId): Diagnostic[] {
  const resolved = resolveTransport(server.entry, client, server.name, server.path, server.line);
  if (!resolved.url) return [];
  let parsed: URL;
  try {
    parsed = new URL(resolved.url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:") return [];
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1"
  ) {
    return [];
  }
  const headers = isRecord(server.entry.headers)
    ? server.entry.headers
    : isRecord(server.entry.http_headers)
      ? server.entry.http_headers
      : {};
  const auth = Object.keys(headers).some((key) => /authorization|api[-_]?key|token/i.test(key));
  const userinfo = parsed.username !== "" || parsed.password !== "";
  const severity = auth || userinfo ? "error" : "warning";
  return [
    at(
      server,
      severity,
      "insecure-http",
      severity === "error"
        ? `"${server.name}" sends credentials to ${parsed.host} over cleartext HTTP.`
        : `"${server.name}" uses http://${parsed.host}. Several clients refuse non-loopback HTTP, and a proxy can read the traffic.`,
      "Use https.",
    ),
  ];
}

function suspiciousTimeout(server: RawServer, client: ClientId): Diagnostic[] {
  const msClients = new Set<ClientId>(["claude-code", "cline", "gemini-cli", "canonical"]);
  if (msClients.has(client)) {
    const value = numeric(server.entry.timeout) ?? numeric(server.entry.timeoutMs);
    if (value !== undefined && value > 0 && value < 1000) {
      return [
        at(
          server,
          "warning",
          "suspicious-timeout",
          `timeout ${value} on "${server.name}" is milliseconds. ${value}ms expires before a handshake.`,
          `Use ${value * 1000} if you meant ${value} seconds.`,
        ),
      ];
    }
  }
  if (client === "codex") {
    const seconds = numeric(server.entry.startup_timeout_sec);
    if (seconds !== undefined && seconds >= 1000) {
      return [
        at(
          server,
          "warning",
          "suspicious-timeout",
          `startup_timeout_sec is ${seconds}. Codex uses seconds, so this waits ${seconds} seconds.`,
          "If you meant milliseconds, divide by 1000.",
        ),
      ];
    }
  }
  return [];
}

function at(
  server: RawServer,
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  suggestion: string,
): Diagnostic {
  return diagnostic(severity, code, message, {
    path: server.path,
    server: server.name,
    line: server.line,
    suggestion,
  });
}

function tokensIn(entry: Record<string, unknown>): ReturnType<typeof findTokens> {
  const tokens: ReturnType<typeof findTokens> = [];
  walkStrings(entry, (_pointer, value) => {
    tokens.push(...findTokens(value));
  });
  return tokens;
}

function walkStrings(
  entry: Record<string, unknown>,
  visit: (pointer: string, value: string) => void,
): void {
  const fields = ["command", "url", "serverUrl", "httpUrl", "cwd", "envFile"] as const;
  for (const field of fields) {
    const value = entry[field];
    if (typeof value === "string") visit(field, value);
  }
  if (Array.isArray(entry.args)) {
    entry.args.forEach((value, index) => {
      if (typeof value === "string") visit(`args[${index}]`, value);
    });
  }
  for (const mapName of ["env", "headers", "http_headers"] as const) {
    const map = entry[mapName];
    if (!isRecord(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string") visit(`${mapName}.${key}`, value);
    }
  }
}

function looksSecretKey(key: string): boolean {
  return /api[_-]?key|secret|token|password|passwd|credential|auth/i.test(key);
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  return (
    /^<[^>]+>$/.test(trimmed) ||
    /your[-_ ]?(token|key|secret|api)/i.test(trimmed) ||
    /^(changeme|placeholder|todo|xxx+|token|secret|password|api[-_]?key)$/i.test(trimmed) ||
    trimmed.includes("YOUR_") ||
    trimmed.includes("REPLACE_ME")
  );
}

function secretKind(pointer: string, value: string): string | undefined {
  if (/^ghp_[A-Za-z0-9]{20,}$/.test(value) || /^github_pat_[A-Za-z0-9_]{20,}/.test(value)) {
    return "a GitHub token";
  }
  if (/^sk-ant-[A-Za-z0-9_-]{10,}/.test(value)) return "an Anthropic key";
  if (/^sk-[A-Za-z0-9]{20,}/.test(value)) return "an API key";
  if (/^xox[baprs]-/.test(value)) return "a Slack token";
  if (/^AKIA[0-9A-Z]{16}/.test(value)) return "an AWS access key";
  if (/^glpat-/.test(value)) return "a GitLab token";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/.test(value))
    return "a URL with a password";
  const key = pointer.split(".").pop() ?? pointer;
  if (
    looksSecretKey(key) &&
    value.length >= 12 &&
    !/^(true|false|null|none|disabled)$/i.test(value)
  ) {
    return "a secret";
  }
  return undefined;
}

function nativeSecretForm(client: ClientId): string {
  switch (PROFILES[client].interpolation) {
    case "shell":
      return "${YOUR_SECRET}";
    case "env-colon":
    case "vscode":
    case "windsurf":
      return "${env:YOUR_SECRET}";
    case "gemini":
      return "${YOUR_SECRET}";
    default:
      return "an environment variable the client injects, not a literal";
  }
}

function isRelative(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("~/") ||
    value === "~"
  );
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    const part = match[1] ?? match[2] ?? match[3];
    if (part) parts.push(part);
  }
  return parts;
}

/** Mechanical fixes that cannot change which server you meant. */
export function applySafeFixes(
  config: CanonicalConfig,
  diagnostics: Diagnostic[],
): CanonicalConfig {
  const servers = config.servers.map((server) => ({
    ...server,
    args: server.args ? [...server.args] : undefined,
  }));
  const byName = new Map(servers.map((server) => [server.name, server]));
  for (const item of diagnostics) {
    if (!item.server) continue;
    const server = byName.get(item.server);
    if (!server) continue;
    if (
      item.code === "npx-missing-yes" &&
      server.command &&
      basename(server.command).toLowerCase() === "npx"
    ) {
      const args = server.args ?? [];
      if (!args.includes("-y") && !args.includes("--yes")) server.args = ["-y", ...args];
    }
    if (item.code === "command-contains-args" && server.command && /\s/.test(server.command)) {
      const [program, ...rest] = splitCommandLine(server.command);
      if (program) {
        server.command = program;
        server.args = [...rest, ...(server.args ?? [])];
      }
    }
  }
  return { ...config, servers: servers.map(cleanServer) };
}

function cleanServer(server: CanonicalServer): CanonicalServer {
  if (server.args && server.args.length === 0) {
    const { args: _args, ...rest } = server;
    return rest;
  }
  return server;
}
