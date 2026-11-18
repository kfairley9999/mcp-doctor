import { spawn, type ChildProcess } from "node:child_process";
import { VERSION } from "../version.js";
import type { CanonicalServer } from "../types.js";
import { isRecord, redact } from "../util.js";

export interface HandshakeOptions {
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  /** Override fetch for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface HandshakeReport {
  ok: boolean;
  skipped?: boolean;
  stage: "skipped" | "spawn" | "initialize" | "timeout" | "exit" | "http" | "unsupported";
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  tools?: string[];
  error?: string;
  stderr?: string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;

export async function handshake(
  server: CanonicalServer,
  options: HandshakeOptions = {},
): Promise<HandshakeReport> {
  if (server.disabled) {
    return { ok: true, skipped: true, stage: "skipped", error: "Server is disabled." };
  }
  if (server.transport === "ws") {
    return {
      ok: false,
      stage: "unsupported",
      error: "WebSocket handshake is not implemented. Validate and convert still work.",
    };
  }
  if (server.transport === "stdio") return handshakeStdio(server, options);
  return handshakeHttp(server, options);
}

function handshakeStdio(
  server: CanonicalServer,
  options: HandshakeOptions,
): Promise<HandshakeReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const command = server.command;
  if (!command || command.trim() === "") {
    return Promise.resolve({ ok: false, stage: "spawn", error: "No command to spawn." });
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, server.args ?? [], {
        cwd: server.cwd,
        env: { ...(options.baseEnv ?? process.env), ...server.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        stage: "spawn",
        error: error instanceof Error ? error.message : "spawn failed",
      });
      return;
    }
    const stderr: string[] = [];
    let stdout = "";
    let settled = false;
    let attempt = 0;
    let sawInitialize = false;
    const pending: HandshakeReport = { ok: false, stage: "initialize" };

    const finish = (report: HandshakeReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 200);
      killer.unref?.();
      resolve({ ...report, stderr: clip(stderr.join("")) });
    };

    const timer = setTimeout(() => {
      if (sawInitialize) finish({ ...pending, ok: true, stage: "initialize" });
      else
        finish({
          ok: false,
          stage: "timeout",
          error: `No initialize response after ${timeoutMs}ms.`,
        });
    }, timeoutMs);
    let grace: ReturnType<typeof setTimeout> = setTimeout(() => undefined, timeoutMs);

    const sendInit = () => {
      const version = PROTOCOL_VERSIONS[attempt];
      if (!version) return;
      const message = {
        jsonrpc: "2.0",
        id: attempt + 1,
        method: "initialize",
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "mcp-doctor", version: VERSION },
        },
      };
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    child.on("error", (error) => {
      finish({ ok: false, stage: "spawn", error: error.message });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(String(chunk));
      if (stderr.join("").length > 64_000) stderr.splice(0, stderr.length / 2);
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > 1_000_000) {
        finish({
          ok: false,
          stage: "initialize",
          error: "stdout exceeded 1MB before initialize completed.",
        });
        return;
      }
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let message: unknown;
        try {
          message = JSON.parse(trimmed) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(message)) continue;
        const id = message.id;
        if (id === attempt + 1 && isRecord(message.result)) {
          const info = isRecord(message.result.serverInfo) ? message.result.serverInfo : undefined;
          pending.ok = true;
          pending.stage = "initialize";
          pending.protocolVersion = stringOr(message.result.protocolVersion);
          pending.serverName = info ? stringOr(info.name) : undefined;
          pending.serverVersion = info ? stringOr(info.version) : undefined;
          sawInitialize = true;
          child.stdin?.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
          );
          const capabilities = isRecord(message.result.capabilities)
            ? message.result.capabilities
            : undefined;
          if (capabilities && "tools" in capabilities) {
            child.stdin?.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} })}\n`,
            );
            clearTimeout(grace);
            grace = setTimeout(() => finish({ ...pending, ok: true, stage: "initialize" }), 400);
          } else {
            finish({ ...pending, ok: true, stage: "initialize" });
          }
        } else if (id === attempt + 1 && message.error !== undefined) {
          const retry = attempt === 0 && protocolError(message.error);
          if (retry) {
            attempt += 1;
            sendInit();
          } else {
            finish({
              ok: false,
              stage: "initialize",
              error: redact(errorText(message.error)),
            });
          }
        } else if (id === 100 && isRecord(message.result) && Array.isArray(message.result.tools)) {
          const tools = message.result.tools.flatMap((tool) =>
            isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
          );
          finish({ ...pending, ok: true, stage: "initialize", tools });
        }
      }
    });
    child.on("exit", (code) => {
      if (sawInitialize) finish({ ...pending, ok: true, stage: "initialize" });
      else
        finish({
          ok: false,
          stage: "exit",
          error: `Process exited (${code ?? "null"}) before initialize completed.`,
        });
    });
    sendInit();
  });
}

async function handshakeHttp(
  server: CanonicalServer,
  options: HandshakeOptions,
): Promise<HandshakeReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!server.url) return { ok: false, stage: "http", error: "No URL." };
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (server.transport === "sse") return await handshakeSse(server, doFetch, controller.signal);
    const init = initializeBody();
    const response = await doFetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...server.headers,
      },
      body: JSON.stringify(init),
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        stage: "http",
        error: `HTTP ${response.status} redirect was not followed.`,
      };
    }
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, stage: "http", error: `HTTP ${response.status}: ${clip(redact(body))}` };
    }
    const message = parseHttpPayload(response.headers.get("content-type"), body);
    if (!message)
      return {
        ok: false,
        stage: "initialize",
        error: "Response was not a JSON-RPC initialize result.",
      };
    if (message.error !== undefined) {
      return { ok: false, stage: "initialize", error: redact(errorText(message.error)) };
    }
    const result = isRecord(message.result) ? message.result : undefined;
    const info = result && isRecord(result.serverInfo) ? result.serverInfo : undefined;
    const session = response.headers.get("mcp-session-id");
    if (session) {
      await doFetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": session,
          ...server.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: controller.signal,
        redirect: "manual",
      }).catch(() => undefined);
    }
    return {
      ok: true,
      stage: "initialize",
      protocolVersion: result ? stringOr(result.protocolVersion) : undefined,
      serverName: info ? stringOr(info.name) : undefined,
      serverVersion: info ? stringOr(info.version) : undefined,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      stage: aborted ? "timeout" : "http",
      error: aborted
        ? `No HTTP response after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handshakeSse(
  server: CanonicalServer,
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<HandshakeReport> {
  if (!server.url) return { ok: false, stage: "http", error: "No URL." };
  const response = await doFetch(server.url, {
    method: "GET",
    headers: { accept: "text/event-stream", ...server.headers },
    signal,
    redirect: "manual",
  });
  if (!response.ok || !response.body) {
    return {
      ok: false,
      stage: "http",
      error: `SSE connection failed with HTTP ${response.status}.`,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let endpoint: string | undefined;
  const deadline = Date.now() + 5_000;
  while (!endpoint && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    endpoint = sseEndpoint(buffer);
  }
  if (!endpoint) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, stage: "initialize", error: "SSE stream did not send an endpoint event." };
  }
  const target = new URL(endpoint, server.url).toString();
  const posted = await doFetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...server.headers },
    body: JSON.stringify(initializeBody()),
    signal,
    redirect: "manual",
  });
  const text = await posted.text();
  await reader.cancel().catch(() => undefined);
  const message = parseHttpPayload(posted.headers.get("content-type"), text);
  if (!posted.ok || !message || message.error !== undefined || !isRecord(message?.result)) {
    return {
      ok: false,
      stage: "initialize",
      error:
        message?.error !== undefined
          ? redact(errorText(message.error))
          : `SSE initialize failed with HTTP ${posted.status}.`,
    };
  }
  const info = isRecord(message.result.serverInfo) ? message.result.serverInfo : undefined;
  return {
    ok: true,
    stage: "initialize",
    protocolVersion: stringOr(message.result.protocolVersion),
    serverName: info ? stringOr(info.name) : undefined,
    serverVersion: info ? stringOr(info.version) : undefined,
  };
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-doctor", version: VERSION },
    },
  };
}

function sseEndpoint(buffer: string): string | undefined {
  const blocks = buffer.split("\n\n");
  for (const block of blocks) {
    if (!block.includes("endpoint")) continue;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) return line.slice(5).trim();
    }
  }
  return undefined;
}

function parseHttpPayload(
  contentType: string | null,
  body: string,
): Record<string, unknown> | undefined {
  const type = contentType ?? "";
  if (type.includes("text/event-stream") || body.includes("data:")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const value: unknown = JSON.parse(line.slice(5).trim());
        if (isRecord(value)) return value;
      } catch {
        /* keep looking */
      }
    }
  }
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function protocolError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("protocol") || text.includes("version");
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "initialize failed";
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clip(text: string): string {
  const clean = redact(text).trim();
  return clean.length > 2000 ? `${clean.slice(0, 2000)}…` : clean;
}
