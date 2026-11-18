import type { Interpolation } from "./types.js";

export interface Token {
  raw: string;
  form: "env-colon" | "input" | "file" | "special" | "default" | "shell" | "dollar" | "percent";
  name: string;
  def?: string;
}

export interface AdaptResult {
  value: string;
  rewrites: string[];
  unsupported: string[];
}

const TOKEN =
  /\$\{(?:env:[A-Za-z_][A-Za-z0-9_]*|input:[^}]+|file:[^}]+|workspaceFolderBasename|workspaceFolder|userHome|pathSeparator|\/)\}|\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%/g;

const SPECIAL = new Set([
  "workspaceFolder",
  "workspaceFolderBasename",
  "userHome",
  "pathSeparator",
  "/",
]);

export function findTokens(value: string): Token[] {
  const found: Token[] = [];
  for (const match of value.matchAll(TOKEN)) {
    const raw = match[0];
    const token = classify(raw);
    if (token) found.push(token);
  }
  return found;
}

function classify(raw: string): Token | undefined {
  const envColon = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (envColon?.[1]) return { raw, form: "env-colon", name: envColon[1] };
  const input = /^\$\{input:([^}]+)\}$/.exec(raw);
  if (input?.[1]) return { raw, form: "input", name: input[1] };
  const file = /^\$\{file:([^}]+)\}$/.exec(raw);
  if (file?.[1]) return { raw, form: "file", name: file[1] };
  const special =
    /^\$\{(workspaceFolderBasename|workspaceFolder|userHome|pathSeparator|\/)\}$/.exec(raw);
  if (special?.[1]) return { raw, form: "special", name: special[1] };
  const withDefault = /^\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}$/.exec(raw);
  if (withDefault?.[1] !== undefined) {
    return { raw, form: "default", name: withDefault[1], def: withDefault[2] ?? "" };
  }
  const shell = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (shell?.[1]) return { raw, form: "shell", name: shell[1] };
  const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  if (dollar?.[1]) return { raw, form: "dollar", name: dollar[1] };
  const percent = /^%([A-Za-z_][A-Za-z0-9_]*)%$/.exec(raw);
  if (percent?.[1]) return { raw, form: "percent", name: percent[1] };
  return undefined;
}

export function isNative(token: Token, target: Interpolation): boolean {
  switch (target) {
    case "preserve":
      return true;
    case "none":
      return false;
    case "shell":
      return token.form === "shell" || token.form === "default";
    case "env-colon":
      return token.form === "env-colon" || token.form === "special";
    case "vscode":
      return token.form === "env-colon" || token.form === "input" || token.form === "special";
    case "windsurf":
      return token.form === "env-colon" || token.form === "file" || token.form === "special";
    case "gemini":
      return token.form === "shell" || token.form === "dollar" || token.form === "percent";
    default:
      return false;
  }
}

function shellVar(name: string): string {
  return `\${${name}}`;
}

function envColon(name: string): string {
  return `\${env:${name}}`;
}

/**
 * Rewrite interpolation into the target client's syntax.
 * A second pass on the result does not change the string.
 * Tokens the target cannot represent are left in place and listed on `unsupported`.
 */
export function adaptInterpolation(value: string, target: Interpolation): AdaptResult {
  if (target === "preserve") return { value, rewrites: [], unsupported: [] };
  const rewrites: string[] = [];
  const unsupported: string[] = [];
  const next = value.replace(TOKEN, (raw) => {
    const token = classify(raw);
    if (!token) return raw;
    if (target === "none") {
      unsupported.push(
        `${raw} will be passed through as literal text. This client does not expand config variables.`,
      );
      return raw;
    }
    if (isNative(token, target)) return raw;
    const rewritten = rewrite(token, target);
    if (!rewritten) {
      unsupported.push(unsupportedReason(token, target));
      return raw;
    }
    if (rewritten.value !== raw) rewrites.push(rewritten.detail);
    if (rewritten.note) unsupported.push(rewritten.note);
    return rewritten.value;
  });
  return { value: next, rewrites, unsupported };
}

interface Rewrite {
  value: string;
  detail: string;
  note?: string;
}

function rewrite(token: Token, target: Interpolation): Rewrite | undefined {
  if (target === "shell") return rewriteShell(token);
  if (target === "gemini") return rewriteGemini(token);
  if (target === "env-colon" || target === "vscode" || target === "windsurf") {
    return rewriteEnvColon(token, target);
  }
  return undefined;
}

function rewriteShell(token: Token): Rewrite | undefined {
  if (token.form === "env-colon" || token.form === "dollar" || token.form === "percent") {
    return {
      value: shellVar(token.name),
      detail: `${token.raw} -> ${shellVar(token.name)}`,
    };
  }
  if (token.form === "special" && token.name === "workspaceFolder") {
    const value = "${CLAUDE_PROJECT_DIR:-.}";
    return {
      value,
      detail: `${token.raw} -> ${value}`,
      note: "Claude Code expands ${CLAUDE_PROJECT_DIR} only in some scopes. The :-. default keeps a relative fallback.",
    };
  }
  return undefined;
}

function rewriteGemini(token: Token): Rewrite | undefined {
  if (token.form === "env-colon") {
    return { value: shellVar(token.name), detail: `${token.raw} -> ${shellVar(token.name)}` };
  }
  if (token.form === "special" && token.name === "workspaceFolder") {
    return undefined;
  }
  return undefined;
}

function rewriteEnvColon(token: Token, target: Interpolation): Rewrite | undefined {
  if (token.form === "shell" || token.form === "dollar" || token.form === "percent") {
    if (SPECIAL.has(token.name) && token.form === "shell") {
      return { value: `\${${token.name}}`, detail: `${token.raw} kept as a client variable` };
    }
    return { value: envColon(token.name), detail: `${token.raw} -> ${envColon(token.name)}` };
  }
  if (token.form === "default") {
    return {
      value: envColon(token.name),
      detail: `${token.raw} -> ${envColon(token.name)}`,
      note: `${token.raw} lost its default (${token.def ?? ""}). ${target} has no :-default form.`,
    };
  }
  if (token.form === "input" && target === "vscode") return undefined;
  if (token.form === "file" && target === "windsurf") return undefined;
  return undefined;
}

function unsupportedReason(token: Token, target: Interpolation): string {
  if (token.form === "input") {
    return `${token.raw} is a VS Code input prompt. ${target} cannot ask for it. Put the value in the environment and reference that.`;
  }
  if (token.form === "file") {
    return `${token.raw} is a Windsurf file interpolation. ${target} cannot read a file from a config string.`;
  }
  if (token.form === "default") {
    return `${token.raw} uses a shell default. ${target} cannot express the default.`;
  }
  if (token.form === "special") {
    return `${token.raw} is filled by another client's runtime. ${target} will not substitute it.`;
  }
  return `${token.raw} is not a form ${target} expands.`;
}

export function adaptRecord(
  record: Record<string, string> | undefined,
  target: Interpolation,
): { value: Record<string, string> | undefined; rewrites: string[]; unsupported: string[] } {
  if (!record) return { value: undefined, rewrites: [], unsupported: [] };
  const value: Record<string, string> = {};
  const rewrites: string[] = [];
  const unsupported: string[] = [];
  for (const [key, entry] of Object.entries(record)) {
    const adapted = adaptInterpolation(entry, target);
    value[key] = adapted.value;
    rewrites.push(...adapted.rewrites);
    unsupported.push(...adapted.unsupported);
  }
  return { value, rewrites, unsupported };
}
