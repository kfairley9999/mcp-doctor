export { VERSION } from "./version.js";
export { CLIENT_IDS, PROFILES, parseClientId, clientList, dropReason } from "./clients.js";
export type { Profile } from "./clients.js";
export { analyzeConfig, catalog, type Analysis, type Conversion } from "./analyze.js";
export { emitConfig, serversEqual, type EmitResult } from "./emit.js";
export { adaptInterpolation, findTokens, isNative } from "./interpolate.js";
export { applySafeFixes, lintConfig, RULES, ruleFix, splitCommandLine } from "./lint.js";
export type { LintInput, RuleInfo } from "./lint.js";
export {
  claudeProjectServers,
  clientFromPath,
  detectClient,
  parseAs,
  parseConfig,
  resolveTransport,
  serverFromEntry,
  type ParseResult,
  type ResolvedTransport,
} from "./parse.js";
export { buildSchema, schemaDocument, validateAgainstSchema, type SchemaError } from "./schema.js";
export type {
  CanonicalConfig,
  CanonicalServer,
  CarryReport,
  ClientId,
  Diagnostic,
  EnvironmentProbe,
  FieldNote,
  Interpolation,
  Severity,
  Support,
  Transport,
  VersionManager,
} from "./types.js";
export { redact } from "./util.js";
