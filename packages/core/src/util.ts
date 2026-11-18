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

let cachedText: string | undefined;
let cachedStarts: number[] = [];

/** Offsets where each line begins. Cached for the last text, so repeated lookups stay O(log n). */
function lineStarts(text: string): number[] {
  if (cachedText === text) return cachedStarts;
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  cachedText = text;
  cachedStarts = starts;
  return starts;
}

export function lineFromOffset(text: string, offset: number): number {
  const starts = lineStarts(text);
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= target) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

let keyedText: string | undefined;
let keyOffsets = new Map<string, number>();

/** First offset of every quoted string used as an object key. Built once per text. */
function keyIndex(text: string): Map<string, number> {
  if (keyedText === text) return keyOffsets;
  const offsets = new Map<string, number>();
  const pattern = /"((?:[^"\\\n]|\\.)*)"\s*:/g;
  for (const match of text.matchAll(pattern)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1] ?? ""}"`) as string;
    } catch {
      continue;
    }
    if (!offsets.has(key)) offsets.set(key, match.index);
  }
  keyedText = text;
  keyOffsets = offsets;
  return offsets;
}

/**
 * Line of a server name. Prefers the name used as an object key (`"name":`), so a string
 * value that happens to equal the name, earlier in the file, does not win. Falls back to the
 * TOML table header, then to the first quoted occurrence.
 */
export function lineOfName(text: string, name: string): number {
  const keyed = keyIndex(text).get(name);
  if (keyed !== undefined) return lineFromOffset(text, keyed);
  const needle = JSON.stringify(name);
  for (const header of [`.${name}]`, `.${needle}]`]) {
    const idx = text.indexOf(header);
    if (idx >= 0) return lineFromOffset(text, idx);
  }
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
