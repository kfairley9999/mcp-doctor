import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion = requested === "2024-11-05" ? "2024-11-05" : "2025-06-18";
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "0.0.1" },
        },
      })}\n`,
    );
    return;
  }
  if (message.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: "ping", description: "fixture tool", inputSchema: { type: "object" } }],
        },
      })}\n`,
    );
  }
});
