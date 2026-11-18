import { analyzeConfig, catalog, parseClientId } from "@mcp-doctor/core";

export interface Env {
  ASSETS: Fetcher;
}

/** Real client configs are a few KB. 64KB keeps one request inside the free-tier CPU budget. */
const MAX_BYTES = 64 * 1024;
const TOO_LARGE = "Config is larger than 64KB.";

/** Sent on every response: API, static assets, and errors. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** Copy a response and add the security headers it is missing. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const ROUTES: Record<string, string> = { "/api/meta": "GET", "/api/analyze": "POST" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await handleApi(request);
    if (api) {
      log(request, api.status);
      return api;
    }
    const asset = await env.ASSETS.fetch(request);
    log(request, asset.status);
    return withSecurityHeaders(asset);
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
  const allowed = ROUTES[url.pathname];
  if (allowed) {
    return json({ error: `Use ${allowed}.` }, 405, "no-store", { allow: allowed });
  }
  return json({ error: "Not found." }, 404, "no-store");
}

async function analyze(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BYTES) {
    return json({ error: TOO_LARGE }, 413, "no-store");
  }
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return json({ error: TOO_LARGE }, 413, "no-store");
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

function json(
  value: unknown,
  status: number,
  cache: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...baseHeaders(cache),
      ...extra,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function baseHeaders(cache: string): Record<string, string> {
  return { "cache-control": cache, ...SECURITY_HEADERS };
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
