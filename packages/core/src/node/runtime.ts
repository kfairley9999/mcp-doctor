import { constants } from "node:fs";
import { accessSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { EnvironmentProbe, VersionManager } from "../types.js";

export interface RuntimeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
}

export function nodeProbe(options: RuntimeOptions = {}): EnvironmentProbe {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const platform = options.platform ?? process.platform;
  return {
    platform,
    env,
    home,
    which(command: string) {
      return which(command, env, platform);
    },
    versionManagers(command: string) {
      return detectVersionManagers(home, command);
    },
  };
}

export function which(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string,
): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command, platform) ? command : undefined;
  }
  const pathEnv = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(
        dir,
        ext && command.toLowerCase().endsWith(ext.toLowerCase()) ? command : command + ext,
      );
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(file: string, platform: NodeJS.Platform | string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function detectVersionManagers(home: string, command: string): VersionManager[] {
  if (!home) return [];
  const found: VersionManager[] = [];
  const nvm = path.join(home, ".nvm");
  if (existsDir(nvm)) {
    const alias = readText(path.join(nvm, "alias", "default"));
    let shim: string | undefined;
    if (alias && !alias.includes("/") && !alias.startsWith("lts")) {
      const version = alias.startsWith("v") ? alias : `v${alias}`;
      const candidate = path.join(nvm, "versions", "node", version, "bin", command);
      if (existsFile(candidate)) shim = candidate;
    }
    found.push({ id: "nvm", root: nvm, ...(shim ? { shim } : {}) });
  }
  const volta = path.join(home, ".volta");
  if (existsDir(volta)) {
    const shim = path.join(volta, "bin", command);
    found.push({ id: "volta", root: volta, ...(existsFile(shim) ? { shim } : {}) });
  }
  for (const root of [path.join(home, ".local", "share", "fnm"), path.join(home, ".fnm")]) {
    if (!existsDir(root)) continue;
    const shim = path.join(root, "aliases", "default", "bin", command);
    found.push({ id: "fnm", root, ...(existsFile(shim) ? { shim } : {}) });
    break;
  }
  const asdf = path.join(home, ".asdf");
  if (existsDir(asdf)) {
    const shim = path.join(asdf, "shims", command);
    found.push({ id: "asdf", root: asdf, ...(existsFile(shim) ? { shim } : {}) });
  }
  return found;
}

function existsDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
