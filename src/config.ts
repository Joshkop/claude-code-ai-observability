import type { PluginConfig, ResolvedPluginConfig } from "./types.js";

const DEFAULTS: Required<Omit<PluginConfig, 'dsn' | 'environment' | 'release'>> = {
  tracesSampleRate: 1,
  debug: false,
  recordInputs: true,
  recordOutputs: true,
  maxAttributeLength: 12000,
  tags: {},
};

export async function loadConfig(): Promise<ResolvedPluginConfig | null> {
  throw new Error("not implemented");
}

export function resolveDefaults(raw: PluginConfig): ResolvedPluginConfig {
  throw new Error("not implemented");
}
