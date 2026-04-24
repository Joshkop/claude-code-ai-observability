import type { HookEvent } from "./types.js";

export async function sendHookEvent(event: HookEvent, port: number): Promise<void> {
  throw new Error("not implemented");
}

export async function ensureServerRunning(port: number, configJson: string): Promise<void> {
  throw new Error("not implemented");
}
