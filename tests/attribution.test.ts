import { describe, it, expect } from "vitest";
import { parseMcpTool, parseSkillInput, parseSlashCommand } from "../src/attribution.js";

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
