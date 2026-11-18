import { parse, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { diagnostic, lineFromOffset } from "./util.js";
import type { Diagnostic } from "./types.js";

export interface JsonDocument {
  ok: true;
  value: unknown;
  /** True when JSON.parse rejected the text and the JSONC parser accepted it. */
  jsonc: boolean;
}

export interface FailedDocument {
  ok: false;
  diagnostics: Diagnostic[];
}

export function parseJsonDocument(text: string): JsonDocument | FailedDocument {
  const source = text.replace(/^\uFEFF/, "");
  if (source.trim() === "") {
    return {
      ok: false,
      diagnostics: [diagnostic("error", "empty", "The config is empty.")],
    };
  }
  try {
    return { ok: true, value: JSON.parse(source) as unknown, jsonc: false };
  } catch {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0 || parseTree(source) === undefined) {
      const first = errors[0];
      const detail =
        errors.length > 0
          ? errors.map((error) => printParseErrorCode(error.error)).join(", ")
          : "unable to parse";
      return {
        ok: false,
        diagnostics: [
          diagnostic("error", "invalid-json", `Invalid JSON (${detail}).`, {
            line: first ? lineFromOffset(source, first.offset) : 1,
          }),
        ],
      };
    }
    return { ok: true, value, jsonc: true };
  }
}

export function parseTomlDocument(text: string): JsonDocument | FailedDocument {
  if (text.trim() === "") {
    return { ok: false, diagnostics: [diagnostic("error", "empty", "The config is empty.")] };
  }
  try {
    return { ok: true, value: parseToml(text) as unknown, jsonc: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid TOML";
    return {
      ok: false,
      diagnostics: [diagnostic("error", "invalid-toml", message)],
    };
  }
}
