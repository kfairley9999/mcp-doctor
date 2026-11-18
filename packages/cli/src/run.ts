import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  VERSION,
  analyzeConfig,
  applySafeFixes,
  clientList,
  emitConfig,
  lintConfig,
  parseClientId,
  parseConfig,
  type ClientId,
  type Diagnostic,
} from "@mcp-doctor/core";
import { doctor, nodeProbe } from "@mcp-doctor/core/node";
import { formatSarif } from "./sarif.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readFile?: (file: string) => string;
}

const HELP = `mcp-doctor ${VERSION}
Validate, lint, convert, and handshake MCP client configs.

Usage
  mcp-doctor validate <file> [--client <id>]
  mcp-doctor lint <file> [--client <id>] [--format text|json|sarif] [--no-env] [--fix] [--write] [--strict]
  mcp-doctor convert <file> --to <client> [--from <client>] [--output <file>] [--format text|json]
  mcp-doctor doctor [--root <dir>] [--home <dir>] [--timeout <ms>] [--file <path> --client <id>] [--no-handshake] [--format text|json]

Clients
  ${clientList()}

doctor reads config files and starts the servers they name. It does not modify those files.
A file of "-" is stdin. Exit 0 when there is no error. Exit 1 on errors. Exit 2 on bad usage.
`;

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    io.stdout(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const command = argv[0];
  const rest = argv.slice(1);
  try {
    if (command === "validate") return validateCommand(rest, io);
    if (command === "lint") return lintCommand(rest, io);
    if (command === "convert") return convertCommand(rest, io);
    if (command === "doctor") return doctorCommand(rest, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "failed"}\n`);
    return 2;
  }
  io.stderr(`Unknown command "${command ?? ""}".\n${HELP}`);
  return 2;
}

function validateCommand(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { client: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const file = positionals[0];
  if (!file) return usage(io, "validate needs a file.");
  const text = readInput(file, io);
  const client = optionalClient(values.client);
  const parsed = parseConfig(text, client, file === "-" ? undefined : file);
  const analysis = analyzeConfig(text, parsed.client, {
    convert: false,
    filePath: file === "-" ? undefined : file,
  });
  const problems = [
    ...analysis.parseDiagnostics,
    ...analysis.schemaErrors.map((error) => schemaDiag(error)),
  ];
  if (problems.length === 0 && analysis.valid) {
    io.stdout(`${parsed.client}: valid\n`);
    return 0;
  }
  io.stdout(formatText(file, problems));
  for (const error of analysis.schemaErrors)
    io.stdout(`  error  schema  ${error.path}  ${error.message}\n`);
  return analysis.valid ? 0 : 1;
}

function lintCommand(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      client: { type: "string" },
      format: { type: "string", default: "text" },
      "no-env": { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const file = positionals[0];
  if (!file) return usage(io, "lint needs a file.");
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json" && format !== "sarif") {
    return usage(io, "--format must be text, json, or sarif.");
  }
  const text = readInput(file, io);
  const parsed = parseConfig(text, optionalClient(values.client), file === "-" ? undefined : file);
  const probe = values["no-env"]
    ? undefined
    : nodeProbe({
        platform: io.platform,
        env: io.env,
        home: io.env.HOME ?? io.env.USERPROFILE ?? "",
        cwd: io.cwd,
      });
  const diagnostics = [
    ...parsed.diagnostics,
    ...lintConfig({ client: parsed.client, raw: parsed.raw, text, probe }),
  ];
  if (values.fix) {
    const fixed = applySafeFixes(parsed.config, diagnostics);
    const emitted = emitConfig(fixed, parsed.client, parsed.client);
    if (values.write) {
      if (file === "-") return usage(io, "--write needs a real file.");
      writeFileSync(file, emitted.text);
      io.stderr(`wrote ${file}\n`);
    } else {
      io.stdout(emitted.text);
    }
  }
  if (format === "json")
    io.stdout(`${JSON.stringify({ client: parsed.client, diagnostics }, null, 2)}\n`);
  else if (format === "sarif") io.stdout(formatSarif(file, diagnostics));
  else if (!values.fix) io.stdout(formatText(file, diagnostics));
  const errors = diagnostics.filter((item) => item.severity === "error");
  const warnings = diagnostics.filter((item) => item.severity === "warning");
  if (errors.length > 0) return 1;
  if (values.strict && warnings.length > 0) return 1;
  return 0;
}

function convertCommand(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      from: { type: "string" },
      output: { type: "string" },
      format: { type: "string", default: "text" },
    },
    allowPositionals: true,
    strict: true,
  });
  const file = positionals[0];
  if (!file) return usage(io, "convert needs a file.");
  if (!values.to) return usage(io, "convert needs --to <client>.");
  const to = parseClientId(values.to);
  if (!to) return usage(io, `Unknown --to "${values.to}".`);
  const from = values.from ? parseClientId(values.from) : undefined;
  if (values.from && !from) return usage(io, `Unknown --from "${values.from}".`);
  const text = readInput(file, io);
  const parsed = parseConfig(text, from, file === "-" ? undefined : file);
  if (
    parsed.diagnostics.some((item) => item.severity === "error" && item.code === "invalid-json")
  ) {
    io.stderr(formatText(file, parsed.diagnostics));
    return 1;
  }
  const emitted = emitConfig(parsed.config, to, parsed.client);
  const report = `${formatReport(emitted.report)}\n`;
  if ((values.format ?? "text") === "json") {
    const payload = `${JSON.stringify({ client: to, output: emitted.text, report: emitted.report }, null, 2)}\n`;
    if (values.output) writeFileSync(values.output, payload);
    else io.stdout(payload);
    return 0;
  }
  io.stderr(report);
  if (values.output) writeFileSync(values.output, emitted.text);
  else io.stdout(emitted.text);
  return 0;
}

async function doctorCommand(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      home: { type: "string" },
      timeout: { type: "string" },
      file: { type: "string" },
      client: { type: "string" },
      "no-handshake": { type: "boolean", default: false },
      format: { type: "string", default: "text" },
    },
    allowPositionals: true,
    strict: true,
  });
  const client = values.client ? parseClientId(values.client) : undefined;
  if (values.client && !client) return usage(io, `Unknown --client "${values.client}".`);
  if (values.file && !client)
    return usage(io, "--file requires --client, so a loose file is not guessed wrong.");
  const timeoutMs = values.timeout ? Number(values.timeout) : 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return usage(io, "--timeout must be a positive number of milliseconds.");
  const report = await doctor({
    cwd: values.root ?? io.cwd,
    home: values.home ?? io.env.HOME ?? io.env.USERPROFILE ?? "",
    platform: io.platform,
    env: io.env,
    timeoutMs,
    handshakeServers: !values["no-handshake"],
    ...(values.file && client ? { file: { path: values.file, client } } : {}),
  });
  if ((values.format ?? "text") === "json") {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout(formatDoctor(report));
  }
  const failed = report.files.some(
    (file) =>
      file.schemaErrors.length > 0 ||
      file.parseDiagnostics.some((item) => item.severity === "error") ||
      file.lint.some((item) => item.severity === "error") ||
      file.servers.some(
        (server) => server.handshake && !server.handshake.ok && !server.handshake.skipped,
      ),
  );
  return failed ? 1 : 0;
}

function optionalClient(value: string | undefined): ClientId | undefined {
  if (!value) return undefined;
  const client = parseClientId(value);
  if (!client) throw new Error(`Unknown client "${value}". Expected: ${clientList()}.`);
  return client;
}

function readInput(file: string, io: Io): string {
  if (file === "-") return io.readFile ? io.readFile("-") : readFileSync(0, "utf8");
  if (io.readFile) return io.readFile(file);
  return readFileSync(file, "utf8");
}

function usage(io: Io, message: string): number {
  io.stderr(`${message}\n${HELP}`);
  return 2;
}

function schemaDiag(error: { path: string; message: string }): Diagnostic {
  return { severity: "error", code: "schema", message: error.message, path: error.path };
}

export function formatText(file: string, diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return `${file}: no findings\n`;
  const lines = [`${file}`];
  for (const item of diagnostics) {
    const where = item.server ? `  ${item.server}` : "";
    lines.push(`  ${item.severity.padEnd(7)} ${item.code}${where}`);
    lines.push(`         ${item.message}`);
    if (item.suggestion) lines.push(`         fix: ${item.suggestion}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatReport(report: {
  dropped: { server?: string; field: string; reason: string }[];
  rewritten: { server?: string; field: string; reason: string }[];
}): string {
  const lines = ["carry report"];
  if (report.rewritten.length === 0 && report.dropped.length === 0) {
    lines.push("  nothing dropped or rewritten");
    return lines.join("\n");
  }
  for (const item of report.rewritten) {
    lines.push(`  rewrite  ${item.server ? `${item.server} ` : ""}${item.field}: ${item.reason}`);
  }
  for (const item of report.dropped) {
    lines.push(`  drop     ${item.server ? `${item.server} ` : ""}${item.field}: ${item.reason}`);
  }
  return lines.join("\n");
}

function formatDoctor(report: Awaited<ReturnType<typeof doctor>>): string {
  const lines = [
    "mcp-doctor",
    "Read-only. Servers named below are started so the initialize handshake can run. Config files are not modified.",
    "",
  ];
  if (report.files.length === 0) {
    lines.push("No config files found.");
    lines.push("Looked at:");
    for (const location of report.searched) lines.push(`  ${location.client}  ${location.path}`);
    return `${lines.join("\n")}\n`;
  }
  for (const file of report.files) {
    lines.push(`${file.location.client}  ${file.location.scope}  ${file.location.path}`);
    if (file.error) lines.push(`  ${file.error}`);
    for (const item of file.parseDiagnostics)
      lines.push(`  ${item.severity}  ${item.code}  ${item.message}`);
    for (const error of file.schemaErrors)
      lines.push(`  error  schema  ${error.path}  ${error.message}`);
    const fileOnly = file.lint.filter((item) => !item.server);
    for (const item of fileOnly) lines.push(`  ${item.severity}  ${item.code}  ${item.message}`);
    for (const server of file.servers) {
      const target = server.command ?? server.url ?? server.transport;
      lines.push(`  ${server.name}  ${server.transport}  ${target}`);
      for (const item of server.diagnostics) {
        lines.push(`    ${item.severity}  ${item.code}  ${item.message}`);
        if (item.suggestion) lines.push(`      fix: ${item.suggestion}`);
      }
      if (server.handshake) {
        if (server.handshake.skipped) lines.push("    skip  handshake  disabled");
        else if (server.handshake.ok) {
          const who = [server.handshake.serverName, server.handshake.serverVersion]
            .filter(Boolean)
            .join(" ");
          const tools = server.handshake.tools
            ? `  tools: ${server.handshake.tools.join(", ")}`
            : "";
          lines.push(
            `    ok    handshake  ${server.handshake.protocolVersion ?? "initialized"}${who ? `  ${who}` : ""}${tools}`,
          );
        } else {
          lines.push(
            `    fail  handshake  ${server.handshake.stage}  ${server.handshake.error ?? "failed"}`,
          );
          if (server.handshake.stderr)
            lines.push(`      stderr: ${server.handshake.stderr.split("\n")[0] ?? ""}`);
        }
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
