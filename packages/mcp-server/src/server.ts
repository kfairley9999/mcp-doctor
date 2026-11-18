import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  VERSION,
  analyzeConfig,
  clientList,
  parseClientId,
  type CanonicalServer,
  type ClientId,
  type Transport,
} from "@mcp-doctor/core";
import { doctor, handshake, nodeProbe } from "@mcp-doctor/core/node";
import { z } from "zod";

const clientSchema = z
  .string()
  .optional()
  .describe(`Client id. One of: ${clientList()}. Omit to detect.`);

export function createDoctorServer(): McpServer {
  const server = new McpServer({ name: "mcp-doctor", version: VERSION });

  server.registerTool(
    "validate_config",
    {
      title: "Validate an MCP config",
      description:
        "Parse a client config and check it against that client's schema. Does not spawn servers or contact the network.",
      inputSchema: {
        text: z.string().describe("Raw config file contents."),
        client: clientSchema,
      },
    },
    async ({ text, client }) => {
      const resolved = resolveClient(client);
      if (!resolved.ok) return textResult(resolved.error, true);
      const analysis = analyzeConfig(text, resolved.client, { convert: false });
      return textResult({
        client: analysis.client,
        assumed: analysis.assumed,
        valid: analysis.valid,
        schemaErrors: analysis.schemaErrors,
        diagnostics: analysis.parseDiagnostics,
      });
    },
  );

  server.registerTool(
    "lint_config",
    {
      title: "Lint an MCP config",
      description:
        "Run mcp-doctor's lint rules. Set includeEnvironment only when this process can see the user's PATH. The playground never does.",
      inputSchema: {
        text: z.string(),
        client: clientSchema,
        includeEnvironment: z.boolean().optional(),
      },
    },
    async ({ text, client, includeEnvironment }) => {
      const resolved = resolveClient(client);
      if (!resolved.ok) return textResult(resolved.error, true);
      const probe = includeEnvironment ? nodeProbe() : undefined;
      const analysis = analyzeConfig(text, resolved.client, { convert: false, probe });
      return textResult({
        client: analysis.client,
        diagnostics: [...analysis.parseDiagnostics, ...analysis.lint],
      });
    },
  );

  server.registerTool(
    "convert_config",
    {
      title: "Convert an MCP config",
      description:
        "Emit the same servers for another client. The report lists fields that were rewritten or could not be carried.",
      inputSchema: {
        text: z.string(),
        to: z.string().describe("Target client id."),
        from: clientSchema,
      },
    },
    async ({ text, to, from }) => {
      const target = parseClientId(to);
      if (!target) return textResult(`Unknown client "${to}".`, true);
      const source = resolveClient(from);
      if (!source.ok) return textResult(source.error, true);
      const analysis = analyzeConfig(text, source.client, { convert: true });
      const conversion = analysis.conversions.find((item) => item.client === target);
      return textResult({
        from: analysis.client,
        to: target,
        output: conversion?.output ?? "",
        report: conversion?.report,
      });
    },
  );

  server.registerTool(
    "diagnose_server",
    {
      title: "Handshake one MCP server",
      description:
        "Spawn a stdio server or POST an HTTP initialize request, with a timeout. This runs on the machine where mcp-doctor is installed. Do not point it at a command you do not trust.",
      inputSchema: {
        name: z.string().optional(),
        transport: z.enum(["stdio", "http", "sse", "ws"]).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        url: z.string().optional(),
        headers: z.record(z.string()).optional(),
        timeoutMs: z.number().int().positive().max(60_000).optional(),
      },
    },
    async (input) => {
      const transport: Transport = input.transport ?? (input.url ? "http" : "stdio");
      const serverConfig: CanonicalServer = {
        name: input.name ?? "server",
        transport,
        ...(input.command ? { command: input.command } : {}),
        ...(input.args ? { args: input.args } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      };
      const report = await handshake(serverConfig, { timeoutMs: input.timeoutMs ?? 10_000 });
      return textResult(report, !report.ok && !report.skipped);
    },
  );

  server.registerTool(
    "list_client_configs",
    {
      title: "List local MCP configs",
      description:
        "Find client config files under a home directory and a project root. Read-only. Secret-shaped strings in the summary are redacted. Does not start the servers; use diagnose_server for a handshake.",
      inputSchema: {
        root: z.string().optional().describe("Project directory. Defaults to the process cwd."),
        home: z.string().optional().describe("Home directory. Defaults to HOME."),
      },
    },
    async ({ root, home }) => {
      const report = await doctor({
        cwd: root ?? process.cwd(),
        ...(home ? { home } : {}),
        handshakeServers: false,
      });
      return textResult({
        files: report.files.map((file) => ({
          client: file.location.client,
          scope: file.location.scope,
          path: file.location.path,
          read: file.read,
          error: file.error,
          servers: file.servers.map((server) => ({
            name: server.name,
            transport: server.transport,
            findings: server.diagnostics.length,
          })),
          errors: file.parseDiagnostics.filter((item) => item.severity === "error").length,
        })),
        searched: report.searched.map((item) => item.path),
      });
    },
  );

  return server;
}

function resolveClient(
  client: string | undefined,
): { ok: true; client?: ClientId } | { ok: false; error: string } {
  if (!client) return { ok: true };
  const resolved = parseClientId(client);
  if (!resolved)
    return { ok: false, error: `Unknown client "${client}". Expected: ${clientList()}.` };
  return { ok: true, client: resolved };
}

function textResult(
  value: unknown,
  isError = false,
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    ...(isError ? { isError: true } : {}),
  };
}
