import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ENGINE_KINDS, type EngineKind } from "./engine/types";
import { PI_THINKING_LEVELS, type PiProviderConfig, type PiThinkingLevel, type ProviderConfig } from "./provider";

/**
 * The connector always runs with permissions bypassed, and this is not
 * configurable.
 *
 * Every other mode can raise a permission prompt, and a headless connector has
 * nobody to answer one: the phone has no approval round-trip, so a prompted turn
 * would hang until the session aged out.
 *
 * Every turn therefore has unrestricted power over the project directory. That
 * exposure is bounded elsewhere instead: a turn only ever starts while the
 * developer's machine is reachable and someone is there to watch it begin.
 */
export const PERMISSION_MODE = "bypassPermissions" as const;

export interface InactivityCompactConfig {
  afterMinutes: number;
}

/** Below this, a misconfigured value would fire Auto-compact on almost every Turn instead of after a genuine idle stretch. */
export const MIN_INACTIVITY_COMPACT_MINUTES = 5;

/** Applied when `contextWarningThresholdPercent` is absent -- the warning is always on, only its value is configurable. */
export const DEFAULT_CONTEXT_WARNING_THRESHOLD_PERCENT = 70;

interface ConnectorConfigBase {
  relayBaseUrl: string;
  connectorCredential: string;
  projectDir: string;
  /**
   * Absent means the feature is off. When set, the connector submits its own
   * `/compact` Command after this many minutes of no real Command completing --
   * safe to run unattended specifically because `/compact` is a Local command
   * that never reaches the model or the working tree.
   */
  inactivityCompact?: InactivityCompactConfig;
  /**
   * The percent of the model's context window in use at which a
   * Context-window warning fires. Unlike `inactivityCompact`,
   * this feature has no off switch -- only its threshold is configurable, so
   * this is a plain percent rather than a nested config object.
   */
  contextWarningThresholdPercent?: number;
}

export type ConnectorConfig = ConnectorConfigBase &
  (
    | {
        engine?: Exclude<EngineKind, "pi">;
        provider: ProviderConfig;
      }
    | { engine: "pi"; provider: PiProviderConfig }
  );

export function relayProvider(config: ConnectorConfig): {
  providerType: ProviderConfig["type"];
  providerModel?: string;
  providerRegion?: string;
} {
  if (config.engine === "pi") return { providerType: config.provider.type, providerModel: config.provider.model };
  switch (config.provider.type) {
    case "anthropic":
      return { providerType: "anthropic" };
    case "bedrock":
      return { providerType: "bedrock", providerModel: config.provider.model, providerRegion: config.provider.region };
    case "copilot":
      return { providerType: "copilot", providerModel: config.provider.model };
  }
}

const ENGINE_PROVIDERS: Record<EngineKind, readonly ProviderConfig["type"][]> = {
  claude: ["anthropic", "bedrock"],
  copilot: ["copilot"],
  pi: ["anthropic", "bedrock", "copilot"],
};

function impliedEngine(provider: ProviderConfig): EngineKind {
  switch (provider.type) {
    case "anthropic":
    case "bedrock":
      return "claude";
    case "copilot":
      return "copilot";
  }
}

export function engineKindFor(config: ConnectorConfig): EngineKind {
  if (config.engine) return config.engine;
  return impliedEngine(config.provider);
}

export function loadConfig(path: string): ConnectorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to read config at ${path}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config at ${path} must be a JSON object`);
  }
  const c = raw as Record<string, unknown>;

  const relayBaseUrl = requireRelayBaseUrl(c);
  const connectorCredential = requireConnectorCredential(c, path);
  const projectDir = typeof c.projectDir === "string" && c.projectDir.length > 0
    ? c.projectDir
    : process.cwd();
  // Accepted for backwards compatibility with existing config files, but it no
  // longer selects anything -- say so rather than letting someone believe a
  // stricter mode is in force.
  if (typeof c.permissionMode === "string" && c.permissionMode !== PERMISSION_MODE) {
    console.warn(
      `Ignoring 'permissionMode': "${c.permissionMode}" -- the connector always runs ` +
        `with ${PERMISSION_MODE}. Remove the field from your config to silence this.`,
    );
  }

  const providerRaw = c.provider;
  if (typeof providerRaw !== "object" || providerRaw === null) {
    throw new Error("'provider' is required and must be an object");
  }
  const p = providerRaw as Record<string, unknown>;
  const providerType = requireString(p, "type");
  if (!(PROVIDER_TYPES as readonly string[]).includes(providerType)) {
    throw new Error("'provider.type' must be 'anthropic', 'bedrock' or 'copilot'");
  }

  const engine = optionalEngine(c, providerType as ProviderConfig["type"]);

  let provider: ProviderConfig | PiProviderConfig;
  if (engine === "pi") {
    const model = optionalString(p, "model");
    const thinkingLevel = optionalThinkingLevel(p);
    provider = {
      type: providerType as ProviderConfig["type"],
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  } else if (providerType === "anthropic") {
    provider = {
      type: "anthropic",
      apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : undefined,
    };
  } else if (providerType === "bedrock") {
    // Both optional -- the Claude adapter's provider environment falls back to the ambient AWS_REGION /
    // ANTHROPIC_MODEL, so `{"type":"bedrock"}` alone is a valid config.
    provider = {
      type: "bedrock",
      region: optionalString(p, "region"),
      model: optionalString(p, "model"),
    };
  } else {
    provider = {
      type: "copilot",
      model: optionalString(p, "model") ?? "auto",
      cliPath: optionalString(p, "cliPath"),
    };
  }

  let inactivityCompact: InactivityCompactConfig | undefined;
  if (c.inactivityCompact !== undefined) {
    if (typeof c.inactivityCompact !== "object" || c.inactivityCompact === null) {
      throw new Error("'inactivityCompact' must be an object if present");
    }
    const ic = c.inactivityCompact as Record<string, unknown>;
    const afterMinutes = ic.afterMinutes;
    if (
      typeof afterMinutes !== "number" ||
      !Number.isFinite(afterMinutes) ||
      afterMinutes < MIN_INACTIVITY_COMPACT_MINUTES
    ) {
      throw new Error(
        `'inactivityCompact.afterMinutes' must be a number >= ${MIN_INACTIVITY_COMPACT_MINUTES} if present`,
      );
    }
    inactivityCompact = { afterMinutes };
  }

  let contextWarningThresholdPercent: number | undefined;
  if (c.contextWarningThresholdPercent !== undefined) {
    const pct = c.contextWarningThresholdPercent;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error("'contextWarningThresholdPercent' must be a number between 1 and 100 if present");
    }
    contextWarningThresholdPercent = pct;
  }

  return {
    relayBaseUrl: relayBaseUrl.replace(/\/+$/, ""),
    connectorCredential,
    projectDir: resolve(projectDir),
    ...(engine ? { engine } : {}),
    provider,
    ...(inactivityCompact ? { inactivityCompact } : {}),
    ...(contextWarningThresholdPercent !== undefined ? { contextWarningThresholdPercent } : {}),
  } as ConnectorConfig;
}

const PROVIDER_TYPES = ["anthropic", "bedrock", "copilot"] as const satisfies readonly ProviderConfig["type"][];

function optionalThinkingLevel(obj: Record<string, unknown>): PiThinkingLevel | undefined {
  const value = obj.thinkingLevel;
  if (value === undefined) return undefined;
  if (!(PI_THINKING_LEVELS as readonly unknown[]).includes(value)) {
    throw new Error(
      `'provider.thinkingLevel' must be one of: ${PI_THINKING_LEVELS.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value as PiThinkingLevel;
}

function optionalEngine(obj: Record<string, unknown>, providerType: ProviderConfig["type"]): EngineKind | undefined {
  const value = obj.engine;
  if (value === undefined) return undefined;
  if (!(ENGINE_KINDS as readonly unknown[]).includes(value)) {
    throw new Error(`'engine' must be one of: ${ENGINE_KINDS.join(", ")} (got ${JSON.stringify(value)})`);
  }
  const engine = value as EngineKind;
  const providers = ENGINE_PROVIDERS[engine];
  if (!providers.includes(providerType)) {
    throw new Error(
      `'engine' is "${engine}", which cannot run on provider.type '${providerType}'; ` +
        `use provider.type ${providers.map((p) => `'${p}'`).join(" or ")}`,
    );
  }
  return engine;
}

/** Reads an optional string field. An empty string is treated as absent. */
function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`'${key}' must be a string if present`);
  }
  return value.length > 0 ? value : undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function requireRelayBaseUrl(obj: Record<string, unknown>): string {
  const value = requireString(obj, "relayBaseUrl");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`'relayBaseUrl' is not a valid URL: ${value}`);
  }
  const isLoopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error(
      `'relayBaseUrl' must start with https:// (got ${value}); plain http:// is only accepted for localhost.`,
    );
  }
  return value;
}

/** Mirrors the relay's `generateCredential`; a value of any other shape can never verify, so it is rejected before any request is made. */
const CONNECTOR_CREDENTIAL_FORMAT = /^[0-9A-Za-z]{12}$/;

function requireConnectorCredential(obj: Record<string, unknown>, path: string): string {
  const value = obj.connectorCredential;
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `'connectorCredential' is missing from ${path}. The connector will not start without one: ` +
        "ask whoever runs your relay to mint a Connector credential " +
        "(`npm run mint-credential -- <label> connector <environment>` in the relay repo) " +
        "and set it as 'connectorCredential'.",
    );
  }
  if (typeof value !== "string" || !CONNECTOR_CREDENTIAL_FORMAT.test(value)) {
    throw new Error(
      `'connectorCredential' in ${path} is not a valid Connector credential: ` +
        "a minted credential is exactly 12 letters and digits, with no spaces or quotes.",
    );
  }
  return value;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return value;
}
