import { CLIENT_IDS, PROFILES } from "./clients.js";
import { emitConfig } from "./emit.js";
import { lintConfig, RULES } from "./lint.js";
import { parseConfig } from "./parse.js";
import { validateAgainstSchema, type SchemaError } from "./schema.js";
import type { CarryReport, ClientId, Diagnostic, EnvironmentProbe } from "./types.js";

export interface Conversion {
  client: ClientId;
  output: string;
  report: CarryReport;
}

export interface Analysis {
  client: ClientId;
  assumed: boolean;
  valid: boolean;
  schemaErrors: SchemaError[];
  parseDiagnostics: Diagnostic[];
  lint: Diagnostic[];
  conversions: Conversion[];
}

export function analyzeConfig(
  text: string,
  client?: ClientId | string,
  options?: { probe?: EnvironmentProbe; filePath?: string; convert?: boolean },
): Analysis {
  const parsed = parseConfig(text, client, options?.filePath);
  const schemaErrors =
    parsed.raw === undefined ? [] : validateAgainstSchema(parsed.client, parsed.raw);
  const lint = lintConfig({
    client: parsed.client,
    raw: parsed.raw,
    text,
    probe: options?.probe,
  });
  const conversions: Conversion[] =
    options?.convert === false
      ? []
      : CLIENT_IDS.map((target) => {
          const emitted = emitConfig(parsed.config, target, parsed.client);
          return { client: target, output: emitted.text, report: emitted.report };
        });
  const valid =
    schemaErrors.length === 0 && !parsed.diagnostics.some((item) => item.severity === "error");
  return {
    client: parsed.client,
    assumed: parsed.assumed,
    valid,
    schemaErrors,
    parseDiagnostics: parsed.diagnostics,
    lint,
    conversions,
  };
}

export function catalog(): {
  clients: {
    id: ClientId;
    label: string;
    doc: string;
    format: string;
    configFile: string;
    interpolation: string;
    summary: string;
    support: Record<string, boolean>;
  }[];
  rules: { id: string; severity: string; summary: string; fix: string }[];
} {
  return {
    clients: CLIENT_IDS.map((id) => {
      const profile = PROFILES[id];
      return {
        id,
        label: profile.label,
        doc: profile.doc,
        format: profile.format,
        configFile: profile.configFile,
        interpolation: profile.interpolation,
        summary: profile.summary,
        support: { ...profile.support, distinguishesRemote: profile.distinguishesRemote },
      };
    }),
    rules: RULES.map((rule) => ({ ...rule })),
  };
}
