import { lintConfig } from "../lint.js";
import { claudeProjectServers, parseConfig } from "../parse.js";
import { validateAgainstSchema } from "../schema.js";
import type { CanonicalServer, ClientId, Diagnostic } from "../types.js";
import {
  candidatePaths,
  existingConfigs,
  type ConfigLocation,
  type DiscoveryContext,
} from "./discover.js";
import { handshake, type HandshakeReport } from "./handshake.js";
import { nodeProbe, readTextFile, type RuntimeOptions } from "./runtime.js";

export interface DoctorOptions extends RuntimeOptions {
  timeoutMs?: number;
  handshakeServers?: boolean;
  file?: { path: string; client?: ClientId };
}

export interface ServerReport {
  name: string;
  transport: string;
  command?: string;
  url?: string;
  diagnostics: Diagnostic[];
  handshake?: HandshakeReport;
}

export interface FileReport {
  location: ConfigLocation;
  read: boolean;
  error?: string;
  servers: ServerReport[];
  parseDiagnostics: Diagnostic[];
  schemaErrors: { path: string; message: string }[];
  lint: Diagnostic[];
}

export interface DoctorReport {
  files: FileReport[];
  /** Every path doctor considered. Missing files are not opened. */
  searched: ConfigLocation[];
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const platform = options.platform ?? process.platform;
  const ctx: DiscoveryContext = { cwd, home, platform, env };
  const probe = nodeProbe({ platform, env, home, cwd });
  const searched = options.file
    ? [
        {
          client: options.file.client ?? "canonical",
          scope: "project" as const,
          path: options.file.path,
        },
      ]
    : candidatePaths(ctx);
  const located = options.file ? searched : existingConfigs(ctx);
  const files: FileReport[] = [];
  for (const location of located) {
    files.push(await inspectFile(location, options, env, probe));
  }
  return { files, searched };
}

async function inspectFile(
  location: ConfigLocation,
  options: DoctorOptions,
  env: NodeJS.ProcessEnv,
  probe: ReturnType<typeof nodeProbe>,
): Promise<FileReport> {
  const text = readTextFile(location.path);
  if (text === undefined) {
    return {
      location,
      read: false,
      error: "Unreadable. doctor only reads config files; it does not create or modify them.",
      servers: [],
      parseDiagnostics: [],
      schemaErrors: [],
      lint: [],
    };
  }
  const client = options.file?.client ?? location.client;
  const parsed = parseConfig(text, client, location.path);
  const schemaErrors =
    parsed.raw === undefined ? [] : validateAgainstSchema(parsed.client, parsed.raw);
  const lint = lintConfig({ client: parsed.client, raw: parsed.raw, text, probe });
  const groups: { label: string; servers: CanonicalServer[] }[] = [
    { label: location.scope, servers: parsed.config.servers },
  ];
  if (parsed.client === "claude-code") {
    for (const project of claudeProjectServers(parsed.raw, text)) {
      groups.push({ label: project.project, servers: project.servers });
    }
  }
  const servers: ServerReport[] = [];
  for (const group of groups) {
    for (const server of group.servers) {
      let shake: HandshakeReport | undefined;
      if (options.handshakeServers !== false) {
        shake = await handshake(server, { timeoutMs: options.timeoutMs, baseEnv: env });
      }
      servers.push({
        name: group.label === location.scope ? server.name : `${server.name} (${group.label})`,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.url ? { url: server.url } : {}),
        diagnostics: lint.filter((item) => item.server === server.name),
        ...(shake ? { handshake: shake } : {}),
      });
    }
  }
  return {
    location: { ...location, client: parsed.client },
    read: true,
    servers,
    parseDiagnostics: parsed.diagnostics,
    schemaErrors,
    lint,
  };
}
