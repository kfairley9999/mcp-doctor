export const CLIENT_IDS = [
  "canonical",
  "claude-desktop",
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "cline",
  "codex",
  "gemini-cli",
  "zed",
] as const;

export type ClientId = (typeof CLIENT_IDS)[number];

export const TRANSPORTS = ["stdio", "http", "sse", "ws"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** How a client expands variables inside config strings. `preserve` means "leave the text alone". */
export type Interpolation =
  "preserve" | "none" | "shell" | "env-colon" | "vscode" | "windsurf" | "gemini";

export interface Support {
  stdio: boolean;
  http: boolean;
  sse: boolean;
  ws: boolean;
  command: boolean;
  args: boolean;
  env: boolean;
  cwd: boolean;
  envFile: boolean;
  headers: boolean;
  timeoutMs: boolean;
  disabled: boolean;
  autoApprove: boolean;
  trust: boolean;
  description: boolean;
}

export interface CanonicalServer {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  envFile?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  disabled?: boolean;
  autoApprove?: string[];
  trust?: boolean;
  description?: string;
  /** Keys this client stores that no other client has. Re-emitted only to the same client. */
  extensions?: Record<string, unknown>;
}

export interface CanonicalConfig {
  servers: CanonicalServer[];
  /** Top-level keys other than the server map. Re-emitted only to the same client. */
  extras?: Record<string, unknown>;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** JSON-pointer-ish path into the source document. */
  path?: string;
  server?: string;
  suggestion?: string;
  line?: number;
}

export interface FieldNote {
  server?: string;
  field: string;
  reason: string;
}

export interface CarryReport {
  from: ClientId;
  to: ClientId;
  dropped: FieldNote[];
  rewritten: FieldNote[];
}

export interface VersionManager {
  id: "nvm" | "volta" | "fnm" | "asdf";
  root: string;
  /** Absolute shim for the command under inspection, when one can be named without a shell. */
  shim?: string;
}

/**
 * What the local machine can see. Omitted in the playground and in pure unit tests
 * that are not about the environment. `doctor` and `lint` on a laptop fill this in.
 */
export interface EnvironmentProbe {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  which(command: string): string | undefined;
  versionManagers(command: string): VersionManager[];
}
