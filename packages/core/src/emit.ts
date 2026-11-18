import { dropReason, PROFILES } from "./clients.js";
import { adaptInterpolation, adaptRecord } from "./interpolate.js";
import type {
  CanonicalConfig,
  CanonicalServer,
  CarryReport,
  ClientId,
  Interpolation,
  Transport,
} from "./types.js";
import { isRecord, sortedKeys } from "./util.js";
import { stringify as stringifyToml } from "smol-toml";

export interface EmitResult {
  text: string;
  report: CarryReport;
}

export function emitConfig(
  config: CanonicalConfig,
  to: ClientId,
  from: ClientId = "canonical",
): EmitResult {
  const report: CarryReport = { from, to, dropped: [], rewritten: [] };
  if (to === "canonical") return { text: emitCanonical(config, from, report), report };
  if (to === "codex") return { text: emitCodex(config, from, report), report };
  return { text: emitJsonClient(config, to, from, report), report };
}

function emitCanonical(config: CanonicalConfig, from: ClientId, report: CarryReport): string {
  const same = from === "canonical";
  if (!same && config.extras) {
    for (const key of Object.keys(config.extras)) {
      report.dropped.push({
        field: key,
        reason: "Top-level fields other than servers are not part of the canonical server list.",
      });
    }
  }
  const servers = config.servers.map((server) => canonicalServer(server, same));
  const root: Record<string, unknown> = {};
  if (same && config.extras) Object.assign(root, config.extras);
  root.servers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function canonicalServer(
  server: CanonicalServer,
  keepExtensions: boolean,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: server.name, transport: server.transport };
  copyDefined(entry, "command", server.command);
  copyDefined(entry, "args", server.args);
  copyDefined(entry, "env", server.env);
  copyDefined(entry, "cwd", server.cwd);
  copyDefined(entry, "envFile", server.envFile);
  copyDefined(entry, "url", server.url);
  copyDefined(entry, "headers", server.headers);
  copyDefined(entry, "timeoutMs", server.timeoutMs);
  copyDefined(entry, "disabled", server.disabled);
  copyDefined(entry, "autoApprove", server.autoApprove);
  copyDefined(entry, "trust", server.trust);
  copyDefined(entry, "description", server.description);
  if (keepExtensions && server.extensions) entry.extensions = server.extensions;
  return entry;
}

function emitJsonClient(
  config: CanonicalConfig,
  to: ClientId,
  from: ClientId,
  report: CarryReport,
): string {
  const profile = PROFILES[to];
  const same = from === to;
  noteExtras(config, same, to, report);
  const servers: Record<string, Record<string, unknown>> = {};
  for (const server of config.servers) {
    const entry = emitServer(server, to, report);
    if (entry) servers[server.name] = entry;
  }
  const root: Record<string, unknown> = {};
  if (same && config.extras) Object.assign(root, config.extras);
  root[profile.rootKey] = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function emitCodex(config: CanonicalConfig, from: ClientId, report: CarryReport): string {
  const same = from === "codex";
  noteExtras(config, same, "codex", report);
  const servers: Record<string, Record<string, unknown>> = {};
  for (const server of config.servers) {
    const entry = emitServer(server, "codex", report);
    if (entry) servers[server.name] = entry;
  }
  const doc: Record<string, unknown> = {};
  if (same && config.extras) Object.assign(doc, config.extras);
  delete doc.mcp_servers;
  doc.mcp_servers = servers;
  const text = stringifyToml(doc);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function noteExtras(
  config: CanonicalConfig,
  same: boolean,
  to: ClientId,
  report: CarryReport,
): void {
  if (same || !config.extras) return;
  for (const key of Object.keys(config.extras)) {
    report.dropped.push({
      field: key,
      reason: `${PROFILES[to].label} cannot carry the top-level field "${key}" from ${PROFILES[report.from].label}.`,
    });
  }
}

function emitServer(
  server: CanonicalServer,
  to: ClientId,
  report: CarryReport,
): Record<string, unknown> | undefined {
  const profile = PROFILES[to];
  const same = report.from === to;
  let transport = server.transport;

  if (transport === "ws" && !profile.support.ws) {
    report.dropped.push({
      server: server.name,
      field: "transport",
      reason: dropReason(to, "ws"),
    });
    return undefined;
  }

  if (transport === "sse" && !profile.support.sse && profile.support.http) {
    transport = "http";
    report.rewritten.push({
      server: server.name,
      field: "transport",
      reason: `${profile.label} will speak streamable HTTP to this URL. Confirm the server is not SSE-only.`,
    });
  } else if (
    transport === "sse" &&
    profile.support.sse &&
    !profile.distinguishesRemote &&
    profile.support.http
  ) {
    report.rewritten.push({
      server: server.name,
      field: "transport",
      reason: `${profile.label} stores HTTP and SSE as the same URL, so the SSE label will be read back as HTTP.`,
    });
  }

  const remote = transport === "http" || transport === "sse" || transport === "ws";
  if (remote && !profile.support.http && !profile.support.sse && !profile.support.ws) {
    if (server.command && profile.support.stdio) {
      report.dropped.push({
        server: server.name,
        field: "url",
        reason: dropReason(to, "url"),
      });
      if (server.headers) {
        report.dropped.push({
          server: server.name,
          field: "headers",
          reason: dropReason(to, "headers"),
        });
      }
      transport = "stdio";
    } else {
      report.dropped.push({
        server: server.name,
        field: "transport",
        reason: `${profile.label} cannot launch a ${server.transport} server. The entry was omitted.`,
      });
      return undefined;
    }
  }

  const entry: Record<string, unknown> = {};
  writeType(entry, transport, to);
  const target = profile.interpolation;

  if (!remote) {
    carryString(
      entry,
      "command",
      server.command,
      server,
      "command",
      profile.support.command,
      target,
      report,
    );
    carryArgs(entry, server, profile.support.args, target, report);
    carryEnv(entry, "env", server.env, server, profile.support.env, target, report);
    carryString(entry, "cwd", server.cwd, server, "cwd", profile.support.cwd, target, report);
    carryString(
      entry,
      "envFile",
      server.envFile,
      server,
      "envFile",
      profile.support.envFile,
      target,
      report,
    );
    if (server.url) {
      report.dropped.push({
        server: server.name,
        field: "url",
        reason: `${profile.label} is being given a stdio server, so the URL was not written.`,
      });
    }
  } else {
    if (server.command) {
      report.dropped.push({
        server: server.name,
        field: "command",
        reason: `${profile.label} remote entries do not take a command. The URL was kept.`,
      });
    }
    for (const field of ["args", "env", "cwd", "envFile"] as const) {
      if (server[field] !== undefined) {
        report.dropped.push({
          server: server.name,
          field,
          reason: `${profile.label} remote entries do not use ${field}.`,
        });
      }
    }
  }

  if (remote && server.url) {
    const field =
      transport === "sse" && profile.sseUrlField
        ? profile.sseUrlField
        : (profile.urlField ?? "url");
    const adapted = adaptInterpolation(server.url, target);
    entry[field] = adapted.value;
    pushAdapt(report, server.name, "url", adapted.rewrites, adapted.unsupported);
    if (field !== "url") {
      report.rewritten.push({
        server: server.name,
        field: "url",
        reason: `Written as ${field}, which is the field ${profile.label} reads.`,
      });
    }
  }

  if (server.headers) writeHeaders(entry, server, to, report, remote);

  if (server.timeoutMs !== undefined) {
    if (!profile.support.timeoutMs) {
      report.dropped.push({
        server: server.name,
        field: "timeoutMs",
        reason: dropReason(to, "timeoutMs"),
      });
    } else if (to === "codex") {
      const seconds = Math.max(1, Math.round(server.timeoutMs / 1000));
      entry.startup_timeout_sec = seconds;
      if (server.timeoutMs % 1000 !== 0) {
        report.rewritten.push({
          server: server.name,
          field: "timeoutMs",
          reason: `Codex stores seconds. ${server.timeoutMs}ms was rounded to ${seconds}s.`,
        });
      } else {
        report.rewritten.push({
          server: server.name,
          field: "timeoutMs",
          reason: `Written as startup_timeout_sec = ${seconds}. Codex's unit is seconds.`,
        });
      }
    } else {
      entry.timeout = server.timeoutMs;
    }
  }

  if (server.disabled !== undefined) {
    if (!profile.support.disabled) {
      report.dropped.push({
        server: server.name,
        field: "disabled",
        reason: dropReason(to, "disabled"),
      });
    } else if (to === "codex") {
      entry.enabled = !server.disabled;
      report.rewritten.push({
        server: server.name,
        field: "disabled",
        reason: `Codex uses enabled = ${String(!server.disabled)}.`,
      });
    } else {
      entry.disabled = server.disabled;
    }
  }

  carryArray(
    entry,
    "autoApprove",
    server.autoApprove,
    server,
    profile.support.autoApprove,
    report,
    "autoApprove",
  );
  if (server.trust !== undefined) {
    if (profile.support.trust) entry.trust = server.trust;
    else
      report.dropped.push({ server: server.name, field: "trust", reason: dropReason(to, "trust") });
  }
  carryString(
    entry,
    "description",
    server.description,
    server,
    "description",
    profile.support.description,
    target,
    report,
  );

  if (to === "zed") {
    const source = server.extensions?.source;
    entry.source = typeof source === "string" ? source : "custom";
  }

  if (same && server.extensions) {
    for (const key of sortedKeys(server.extensions)) {
      if (key in entry) continue;
      if (to === "zed" && key === "source") continue;
      entry[key] = server.extensions[key];
    }
  } else if (server.extensions) {
    for (const key of Object.keys(server.extensions)) {
      report.dropped.push({
        server: server.name,
        field: key,
        reason: `${profile.label} has no field "${key}". It was kept only because the source client stored it.`,
      });
    }
  }

  return entry;
}

function writeType(entry: Record<string, unknown>, transport: Transport, to: ClientId): void {
  if (to === "vscode") {
    entry.type = transport === "ws" ? "http" : transport;
    return;
  }
  if (to === "claude-code" && transport !== "stdio") {
    entry.type = transport;
    return;
  }
  if (to === "cline" && transport === "http") entry.type = "streamableHttp";
  if (to === "cline" && transport === "sse") entry.type = "sse";
  if (to === "cline" && transport === "ws") entry.type = "ws";
}

function writeHeaders(
  entry: Record<string, unknown>,
  server: CanonicalServer,
  to: ClientId,
  report: CarryReport,
  remote: boolean,
): void {
  if (!server.headers) return;
  const profile = PROFILES[to];
  if (!profile.support.headers) {
    report.dropped.push({
      server: server.name,
      field: "headers",
      reason: dropReason(to, "headers"),
    });
    return;
  }
  if (!remote && to !== "codex") {
    report.dropped.push({
      server: server.name,
      field: "headers",
      reason: "Headers belong to a remote server. A stdio entry cannot send them.",
    });
    return;
  }
  const adapted = adaptRecord(server.headers, profile.interpolation);
  const headers = adapted.value ?? {};
  pushAdapt(report, server.name, "headers", adapted.rewrites, adapted.unsupported);
  if (to === "codex") {
    const names = Object.keys(headers);
    const authorization = headers.Authorization;
    const bearer = authorization
      ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(authorization)
      : null;
    if (bearer?.[1] && names.length === 1) {
      entry.bearer_token_env_var = bearer[1];
      report.rewritten.push({
        server: server.name,
        field: "headers.Authorization",
        reason: `Moved to bearer_token_env_var = "${bearer[1]}" so the token stays in the environment.`,
      });
      return;
    }
    entry.http_headers = headers;
    report.rewritten.push({
      server: server.name,
      field: "headers",
      reason: "Written as http_headers. Codex does not expand ${VAR} inside header values.",
    });
    return;
  }
  entry.headers = headers;
}

function carryString(
  entry: Record<string, unknown>,
  key: string,
  value: string | undefined,
  server: CanonicalServer,
  field: string,
  supported: boolean,
  target: Interpolation,
  report: CarryReport,
): void {
  if (value === undefined) return;
  if (!supported) {
    report.dropped.push({ server: server.name, field, reason: dropReason(report.to, field) });
    return;
  }
  const adapted = adaptInterpolation(value, target);
  entry[key] = adapted.value;
  pushAdapt(report, server.name, field, adapted.rewrites, adapted.unsupported);
}

function carryArgs(
  entry: Record<string, unknown>,
  server: CanonicalServer,
  supported: boolean,
  target: Interpolation,
  report: CarryReport,
): void {
  if (!server.args) return;
  if (!supported) {
    report.dropped.push({
      server: server.name,
      field: "args",
      reason: dropReason(report.to, "args"),
    });
    return;
  }
  const args: string[] = [];
  for (const arg of server.args) {
    const adapted = adaptInterpolation(arg, target);
    args.push(adapted.value);
    pushAdapt(report, server.name, "args", adapted.rewrites, adapted.unsupported);
  }
  entry.args = args;
}

function carryEnv(
  entry: Record<string, unknown>,
  key: string,
  value: Record<string, string> | undefined,
  server: CanonicalServer,
  supported: boolean,
  target: Interpolation,
  report: CarryReport,
): void {
  if (!value) return;
  if (!supported) {
    report.dropped.push({
      server: server.name,
      field: "env",
      reason: dropReason(report.to, "env"),
    });
    return;
  }
  const adapted = adaptRecord(value, target);
  entry[key] = adapted.value;
  pushAdapt(report, server.name, "env", adapted.rewrites, adapted.unsupported);
}

function carryArray(
  entry: Record<string, unknown>,
  key: string,
  value: string[] | undefined,
  server: CanonicalServer,
  supported: boolean,
  report: CarryReport,
  field: string,
): void {
  if (!value) return;
  if (!supported) {
    report.dropped.push({ server: server.name, field, reason: dropReason(report.to, field) });
    return;
  }
  entry[key] = value;
}

function pushAdapt(
  report: CarryReport,
  server: string,
  field: string,
  rewrites: string[],
  unsupported: string[],
): void {
  for (const detail of rewrites) {
    report.rewritten.push({ server, field, reason: detail });
  }
  for (const detail of unsupported) {
    report.dropped.push({ server, field, reason: detail });
  }
}

function copyDefined(entry: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) entry[key] = value;
}

export function stableServer(server: CanonicalServer): CanonicalServer {
  const copy: CanonicalServer = { name: server.name, transport: server.transport };
  if (server.command !== undefined) copy.command = server.command;
  if (server.args !== undefined) copy.args = [...server.args];
  if (server.env !== undefined) copy.env = { ...server.env };
  if (server.cwd !== undefined) copy.cwd = server.cwd;
  if (server.envFile !== undefined) copy.envFile = server.envFile;
  if (server.url !== undefined) copy.url = server.url;
  if (server.headers !== undefined) copy.headers = { ...server.headers };
  if (server.timeoutMs !== undefined) copy.timeoutMs = server.timeoutMs;
  if (server.disabled !== undefined) copy.disabled = server.disabled;
  if (server.autoApprove !== undefined) copy.autoApprove = [...server.autoApprove];
  if (server.trust !== undefined) copy.trust = server.trust;
  if (server.description !== undefined) copy.description = server.description;
  if (server.extensions !== undefined) copy.extensions = server.extensions;
  return copy;
}

export function serversEqual(left: CanonicalServer, right: CanonicalServer): boolean {
  return JSON.stringify(stableServer(left)) === JSON.stringify(stableServer(right));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
