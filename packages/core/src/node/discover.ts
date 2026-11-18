import path from "node:path";
import { statSync } from "node:fs";
import type { ClientId } from "../types.js";

export interface DiscoveryContext {
  cwd: string;
  home: string;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface ConfigLocation {
  client: ClientId;
  scope: "user" | "project";
  path: string;
}

export function candidatePaths(ctx: DiscoveryContext): ConfigLocation[] {
  const home = ctx.home;
  const cwd = ctx.cwd;
  const xdg = ctx.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const appData =
    ctx.platform === "win32" ? (ctx.env.APPDATA ?? path.join(home, "AppData", "Roaming")) : "";
  const locations: ConfigLocation[] = [];
  const add = (client: ClientId, scope: "user" | "project", file: string) => {
    locations.push({ client, scope, path: file });
  };

  if (ctx.platform === "darwin") {
    add(
      "claude-desktop",
      "user",
      path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    add(
      "vscode",
      "user",
      path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    );
    add(
      "cline",
      "user",
      path.join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
    add(
      "cline",
      "user",
      path.join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  } else if (ctx.platform === "win32") {
    add("claude-desktop", "user", path.join(appData, "Claude", "claude_desktop_config.json"));
    add("vscode", "user", path.join(appData, "Code", "User", "mcp.json"));
    add(
      "cline",
      "user",
      path.join(
        appData,
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
    add(
      "cline",
      "user",
      path.join(
        appData,
        "Cursor",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
    add("zed", "user", path.join(appData, "Zed", "settings.json"));
  } else {
    add("claude-desktop", "user", path.join(xdg, "Claude", "claude_desktop_config.json"));
    add("vscode", "user", path.join(xdg, "Code", "User", "mcp.json"));
    add(
      "cline",
      "user",
      path.join(
        xdg,
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  }

  add("claude-code", "project", path.join(cwd, ".mcp.json"));
  add("claude-code", "user", path.join(home, ".claude.json"));
  add("cursor", "project", path.join(cwd, ".cursor", "mcp.json"));
  add("cursor", "user", path.join(home, ".cursor", "mcp.json"));
  add("vscode", "project", path.join(cwd, ".vscode", "mcp.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf", "mcp_config.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf-next", "mcp_config.json"));
  add("windsurf", "user", path.join(xdg, "devin", "mcp_config.json"));
  add("windsurf", "project", path.join(cwd, ".devin", "mcp_config.json"));
  add("cline", "user", path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json"));
  add("codex", "user", path.join(home, ".codex", "config.toml"));
  add("codex", "project", path.join(cwd, ".codex", "config.toml"));
  add("gemini-cli", "user", path.join(home, ".gemini", "settings.json"));
  add("gemini-cli", "project", path.join(cwd, ".gemini", "settings.json"));
  add("zed", "user", path.join(xdg, "zed", "settings.json"));
  add("zed", "project", path.join(cwd, ".zed", "settings.json"));
  return locations;
}

export function existingConfigs(ctx: DiscoveryContext): ConfigLocation[] {
  return candidatePaths(ctx).filter((location) => {
    try {
      return statSync(location.path).isFile();
    } catch {
      return false;
    }
  });
}
