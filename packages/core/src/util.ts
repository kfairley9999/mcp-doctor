import type { Diagnostic } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diagnostic(
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  extra?: Partial<Pick<Diagnostic, "path" | "server" | "suggestion" | "line">>,
): Diagnostic {
  return { severity, code, message, ...extra };
}

export function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function lineOfName(text: string, name: string): number {
  const needle = `"${name}"`;
  const idx = text.indexOf(needle);
  if (idx < 0) return 1;
  return lineFromOffset(text, idx);
}

export function basename(command: string): string {
  const trimmed = command.trim();
  const parts = trimmed.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? trimmed;
  return last
    .replace(/\.cmd$/i, "")
    .replace(/\.exe$/i, "")
    .replace(/\.bat$/i, "");
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function cloneConfigServers<T>(value: T): T {
  return structuredClone(value);
}

const SECRET_SHAPES: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/** Scrub credential-shaped substrings before they reach a report or a terminal. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_SHAPES) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

export function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
