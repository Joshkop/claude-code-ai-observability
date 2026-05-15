import { describe, it, expect } from "vitest";
import { parseMcpTool, parseSkillInput, parseSlashCommand } from "../src/attribution.js";
import { deriveSubagentSource } from "../src/attribution.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("N1 — MCP tool name parsing", () => {
  it("parses mcp__server__tool", () => {
    expect(parseMcpTool("mcp__claude_ai_Linear__list_issues")).toEqual({
      server: "claude_ai_Linear",
      name: "list_issues",
    });
  });
  it("returns null for non-mcp tools", () => {
    expect(parseMcpTool("Bash")).toBeNull();
  });
  it("keeps remaining __ in the tool name", () => {
    expect(parseMcpTool("mcp__srv__a__b")).toEqual({ server: "srv", name: "a__b" });
  });
});

describe("N2 — skill input parsing", () => {
  it("splits a namespaced skill", () => {
    expect(parseSkillInput({ skill: "superpowers:brainstorming" })).toEqual({
      name: "brainstorming",
      plugin: "superpowers",
    });
  });
  it("bare skill omits plugin", () => {
    expect(parseSkillInput({ skill: "review" })).toEqual({ name: "review" });
  });
  it("returns null for non-skill input", () => {
    expect(parseSkillInput({ foo: 1 })).toBeNull();
  });
});

describe("N2 — slash command parsing", () => {
  it("parses a namespaced command", () => {
    expect(parseSlashCommand("/superpowers:writing-plans go")).toEqual({
      name: "writing-plans",
      plugin: "superpowers",
    });
  });
  it("parses a bare command without plugin", () => {
    expect(parseSlashCommand("/review")).toEqual({ name: "review" });
  });
  it("returns null when prompt is not a slash command", () => {
    expect(parseSlashCommand("hello there")).toBeNull();
  });
});

describe("N3 — subagent source-class", () => {
  it("namespaced subagent_type is authoritative (not inferred)", () => {
    expect(deriveSubagentSource("superpowers:planner", undefined)).toEqual({
      source: "plugin:superpowers",
      inferred: false,
    });
  });

  it("infers plugin from an agent file under a plugin dir", () => {
    const root = mkdtempSync(join(tmpdir(), "n3-"));
    const agentFile = join(root, "plugins", "cache", "acme", "agents", "explorer.md");
    mkdirSync(join(root, "plugins", "cache", "acme", "agents"), { recursive: true });
    writeFileSync(agentFile, "# explorer", "utf8");
    const r = deriveSubagentSource("explorer", agentFile);
    expect(r.source).toBe("plugin:acme");
    expect(r.inferred).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("project .claude/agents → source=project, inferred", () => {
    const root = mkdtempSync(join(tmpdir(), "n3p-"));
    const agentFile = join(root, ".claude", "agents", "myagent.md");
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(agentFile, "x", "utf8");
    expect(deriveSubagentSource("myagent", agentFile)).toEqual({
      source: "project",
      inferred: true,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("unknown when no namespace and no resolvable path", () => {
    expect(deriveSubagentSource("explorer", undefined)).toEqual({
      source: "unknown",
      inferred: false,
    });
  });

  it("built-in style names map to built-in", () => {
    expect(deriveSubagentSource("general-purpose", undefined).source).toBe("unknown");
  });
});
