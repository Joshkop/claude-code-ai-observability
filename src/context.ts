import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AutoTags } from "./types.js";

function run(args: string[], timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const child = exec(
      [cmd, ...rest].map((a) => JSON.stringify(a)).join(" "),
      { signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      }
    );
    void child;
  });
}

function normalizeGitUrl(url: string): string {
  // git@github.com:user/repo.git → https://github.com/user/repo
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  return url.replace(/\.git$/, "");
}

function repoNameFromUrl(url: string): string {
  return path.basename(url.replace(/\.git$/, ""));
}

export async function detectContext(sessionId: string, cwd?: string): Promise<AutoTags> {
  const effectiveCwd = cwd ?? process.cwd();
  const gitArgs = (subcmd: string[]) => ["git", "-C", effectiveCwd, ...subcmd];

  // All detections run in parallel; each is isolated in its own try/catch.
  const [
    sessionNameResult,
    versionResult,
    remoteUrlResult,
    repoRootResult,
    branchResult,
    revisionResult,
  ] = await Promise.allSettled([
    // claude_code.session_name
    (async (): Promise<string | undefined> => {
      if (process.env.CLAUDE_SESSION_NAME) return process.env.CLAUDE_SESSION_NAME;
      if (process.env.TMUX_PANE) {
        try {
          return await run(["tmux", "display-message", "-p", "#S"]);
        } catch {
          // tmux not available or failed
        }
      }
      if (process.env.STY) {
        // screen session name is the part after the PID dot
        const parts = process.env.STY.split(".");
        if (parts.length > 1) return parts.slice(1).join(".");
      }
      return undefined;
    })(),

    // claude_code.version
    (async (): Promise<string | undefined> => {
      if (process.env.CLAUDE_CODE_VERSION) return process.env.CLAUDE_CODE_VERSION;
      try {
        const out = await run(["claude", "--version"]);
        return out || undefined;
      } catch {
        return undefined;
      }
    })(),

    // vcs.repository.url (raw)
    (async (): Promise<string | undefined> => {
      try {
        return await run(gitArgs(["config", "--get", "remote.origin.url"]));
      } catch {
        return undefined;
      }
    })(),

    // repo root fallback for vcs.repository.name
    (async (): Promise<string | undefined> => {
      try {
        return await run(gitArgs(["rev-parse", "--show-toplevel"]));
      } catch {
        return undefined;
      }
    })(),

    // vcs.ref.head.name
    (async (): Promise<string | undefined> => {
      try {
        return await run(gitArgs(["rev-parse", "--abbrev-ref", "HEAD"]));
      } catch {
        return undefined;
      }
    })(),

    // vcs.ref.head.revision
    (async (): Promise<string | undefined> => {
      try {
        return await run(gitArgs(["rev-parse", "--short=12", "HEAD"]));
      } catch {
        return undefined;
      }
    })(),
  ]);

  const sessionName = sessionNameResult.status === "fulfilled" ? sessionNameResult.value : undefined;
  const version = versionResult.status === "fulfilled" ? versionResult.value : undefined;
  const rawUrl = remoteUrlResult.status === "fulfilled" ? remoteUrlResult.value : undefined;
  const repoRoot = repoRootResult.status === "fulfilled" ? repoRootResult.value : undefined;
  const branch = branchResult.status === "fulfilled" ? branchResult.value : undefined;
  const revision = revisionResult.status === "fulfilled" ? revisionResult.value : undefined;

  const repoUrl = rawUrl ? normalizeGitUrl(rawUrl) : undefined;
  const repoName = rawUrl
    ? repoNameFromUrl(rawUrl)
    : repoRoot
    ? path.basename(repoRoot)
    : undefined;

  const tags: AutoTags = {
    "claude_code.session_id": sessionId,
    ...(sessionName !== undefined && { "claude_code.session_name": sessionName }),
    ...(version !== undefined && { "claude_code.version": version }),
    ...(repoName !== undefined && { "vcs.repository.name": repoName }),
    ...(repoUrl !== undefined && { "vcs.repository.url": repoUrl }),
    ...(branch !== undefined && { "vcs.ref.head.name": branch }),
    ...(revision !== undefined && { "vcs.ref.head.revision": revision }),
    "host.name": os.hostname(),
    "os.type": os.platform(),
    "process.cwd": effectiveCwd,
    "process.pid": process.pid,
  };

  return tags;
}

if (process.argv[2] === "--dump") {
  detectContext("test").then((tags) => {
    console.log(JSON.stringify(tags, null, 2));
  });
}
