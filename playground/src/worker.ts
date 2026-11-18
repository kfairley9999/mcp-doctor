import { analyzeConfig, catalog, parseClientId } from "@mcp-doctor/core";

export interface Env {
  ASSETS: Fetcher;
}

const MAX_BYTES = 256 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await handleApi(request);
    if (api) {
      log(request, api.status);
      return api;
    }
    const asset = await env.ASSETS.fetch(request);
    log(request, asset.status);
    return asset;
  },
};

/** API routes only. Returns undefined so static assets can be served for everything else. */
export async function handleApi(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return undefined;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders("no-store") });
  }
  if (url.pathname === "/api/meta" && request.method === "GET") {
    return json(catalog(), 200, "public, max-age=300");
  }
  if (url.pathname === "/api/analyze" && request.method === "POST") {
    return analyze(request);
  }
  return new Response("Not found", { status: 404, headers: baseHeaders("no-store") });
}

async function analyze(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BYTES) {
    return json({ error: "Config is larger than 256KB." }, 413, "no-store");
  }
  const raw = await request.text();
  if (raw.length > MAX_BYTES)
    return json({ error: "Config is larger than 256KB." }, 413, "no-store");
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return json({ error: 'Send JSON: {"text": "...", "client": "cursor"}.' }, 400, "no-store");
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "Body needs a text string." }, 400, "no-store");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return json({ error: "Body needs a text string." }, 400, "no-store");
  }
  const hinted = typeof record.client === "string" ? record.client : undefined;
  if (hinted && !parseClientId(hinted)) {
    return json({ error: `Unknown client "${hinted}".` }, 400, "no-store");
  }
  let analysis;
  try {
    analysis = analyzeConfig(record.text, hinted ? parseClientId(hinted) : undefined, {
      convert: true,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        path: "/api/analyze",
        message: error instanceof Error ? error.message : "analyze failed",
      }),
    );
    return json({ error: "The config could not be checked." }, 500, "no-store");
  }
  return json(
    {
      client: analysis.client,
      assumed: analysis.assumed,
      valid: analysis.valid,
      schemaErrors: analysis.schemaErrors,
      parseDiagnostics: analysis.parseDiagnostics,
      lint: analysis.lint,
      conversions: analysis.conversions.map((item) => ({
        client: item.client,
        output: item.output,
        dropped: item.report.dropped,
        rewritten: item.report.rewritten,
      })),
      privacy:
        "Processed in this request and discarded. Not stored, not logged, and not sent to any other host.",
    },
    200,
    "no-store",
  );
}

function json(value: unknown, status: number, cache: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...baseHeaders(cache), "content-type": "application/json; charset=utf-8" },
  });
}

function baseHeaders(cache: string): Record<string, string> {
  return {
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  };
}

function log(request: Request, status: number): void {
  const url = new URL(request.url);
  console.log(
    JSON.stringify({
      method: request.method,
      path: url.pathname,
      status,
      bytes: Number(request.headers.get("content-length") ?? "0"),
    }),
  );
}
