import { describe, expect, it } from "vitest";
import worker, { handleApi, type Env } from "./worker.js";

describe("playground api", () => {
  it("returns the catalog and analyzes a config without storing it", async () => {
    const meta = await handleApi(new Request("http://playground.test/api/meta"));
    expect(meta?.status).toBe(200);
    const catalog = (await meta?.json()) as { clients: { id: string }[]; rules: { id: string }[] };
    expect(catalog.clients.map((item) => item.id)).toContain("windsurf");
    expect(catalog.rules.length).toBe(15);

    const response = await handleApi(
      new Request("http://playground.test/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["pkg"] } } }),
          client: "claude-desktop",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = (await response?.json()) as {
      lint: { code: string }[];
      conversions: { client: string; output: string }[];
      privacy: string;
    };
    expect(body.lint.some((item) => item.code === "npx-missing-yes")).toBe(true);
    expect(body.conversions.find((item) => item.client === "windsurf")?.output).toContain(
      "mcpServers",
    );
    expect(body.privacy).toMatch(/discarded/i);
  });

  it("rejects bad input and unknown routes", async () => {
    const bad = await handleApi(
      new Request("http://playground.test/api/analyze", { method: "POST", body: "nope" }),
    );
    expect(bad?.status).toBe(400);
    const missing = await handleApi(new Request("http://playground.test/api/nope"));
    expect(missing?.status).toBe(404);
    const huge = await handleApi(
      new Request("http://playground.test/api/analyze", {
        method: "POST",
        headers: { "content-length": String(300 * 1024) },
        body: "{}",
      }),
    );
    expect(huge?.status).toBe(413);
    expect(await handleApi(new Request("http://playground.test/"))).toBeUndefined();
    const options = await handleApi(
      new Request("http://playground.test/api/analyze", { method: "OPTIONS" }),
    );
    expect(options?.status).toBe(204);
    const unknown = await handleApi(
      new Request("http://playground.test/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text: "{}", client: "nope" }),
      }),
    );
    expect(unknown?.status).toBe(400);
    const notText = await handleApi(
      new Request("http://playground.test/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text: 1 }),
      }),
    );
    expect(notText?.status).toBe(400);
    const fat = "x".repeat(300 * 1024);
    const oversized = await handleApi(
      new Request("http://playground.test/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text: fat }),
      }),
    );
    expect(oversized?.status).toBe(413);
    const env = {
      ASSETS: { fetch: async () => new Response("page", { status: 200 }) },
    } as unknown as Env;
    const page = await worker.fetch(new Request("http://playground.test/"), env);
    expect(await page.text()).toBe("page");
  });
});
