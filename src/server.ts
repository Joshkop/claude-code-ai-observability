import type * as Sentry from "@sentry/node";
import type { ResolvedPluginConfig } from "./types.js";
import type { AutoTags } from "./types.js";

export function startServer(
  sentry: typeof Sentry,
  config: ResolvedPluginConfig,
  context: AutoTags,
): void {
  throw new Error("not implemented");
}
