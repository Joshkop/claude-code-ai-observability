/** N1: `mcp__<server>__<tool>` → { server, name }. Null when not an MCP tool. */
export function parseMcpTool(toolName) {
    if (typeof toolName !== "string" || !toolName.startsWith("mcp__"))
        return null;
    const rest = toolName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep <= 0 || sep + 2 >= rest.length)
        return null;
    return { server: rest.slice(0, sep), name: rest.slice(sep + 2) };
}
/** N2: the Skill tool input carries `skill: "[plugin:]name"`. */
export function parseSkillInput(input) {
    if (!input || typeof input !== "object")
        return null;
    const raw = input.skill;
    if (typeof raw !== "string" || raw.length === 0)
        return null;
    const colon = raw.indexOf(":");
    if (colon > 0) {
        return { plugin: raw.slice(0, colon), name: raw.slice(colon + 1) };
    }
    return { name: raw };
}
/** N2: a UserPromptSubmit prompt of form `/[plugin:]command ...`. */
export function parseSlashCommand(prompt) {
    if (typeof prompt !== "string")
        return null;
    const m = prompt.match(/^\/(?:([A-Za-z0-9_-]+):)?([A-Za-z0-9_-]+)/);
    if (!m)
        return null;
    return m[1] ? { plugin: m[1], name: m[2] } : { name: m[2] };
}
