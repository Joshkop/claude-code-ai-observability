import { execFileSync } from "node:child_process";
import os from "node:os";
function tryRun(cmd, args, timeoutMs = 400) {
    try {
        const out = execFileSync(cmd, args, {
            encoding: "utf8",
            timeout: timeoutMs,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const v = out.trim();
        return v || undefined;
    }
    catch {
        return undefined;
    }
}
let cached;
/**
 * Detect dynamic context from the user's live shell. Cheap (<10ms typical):
 * one tmux fork at most, plus env-var reads. Cached per hook-client process.
 */
export function detectClientContext() {
    if (cached)
        return cached;
    const ctx = {
        captured_at_ms: Date.now(),
        cwd: process.cwd(),
        ppid: process.ppid,
    };
    // Session name: env override → managers with named sessions (zellij, tmux,
    // screen). Terminals without a "session name" concept (WezTerm, kitty,
    // iTerm, Windows Terminal, VS Code, Warp, Ghostty) only set a pane/window
    // id — captured below as terminal_session_id, NOT session_name.
    if (process.env.CLAUDE_SESSION_NAME) {
        ctx.session_name = process.env.CLAUDE_SESSION_NAME;
    }
    else if (process.env.ZELLIJ_SESSION_NAME) {
        // zellij exports the live session name directly — no fork required.
        ctx.session_name = process.env.ZELLIJ_SESSION_NAME;
    }
    else if (process.env.TMUX) {
        const name = tryRun("tmux", ["display-message", "-p", "#S"]);
        if (name)
            ctx.session_name = name;
        const win = tryRun("tmux", ["display-message", "-p", "#W"]);
        if (win)
            ctx.tmux_window = win;
        const pane = tryRun("tmux", ["display-message", "-p", "#D"]);
        if (pane)
            ctx.tmux_pane = pane;
    }
    else if (process.env.STY) {
        const parts = process.env.STY.split(".");
        if (parts.length > 1)
            ctx.session_name = parts.slice(1).join(".");
    }
    // Terminal program + opaque pane/session id. Lets users still group traces
    // per-window even when there's no human-readable session name to tag with.
    // Precedence: explicit TERM_PROGRAM, then per-terminal env signatures.
    if (process.env.TERM_PROGRAM) {
        ctx.terminal_program = process.env.TERM_PROGRAM;
    }
    else if (process.env.ZELLIJ)
        ctx.terminal_program = "zellij";
    else if (process.env.TMUX)
        ctx.terminal_program = "tmux";
    else if (process.env.STY)
        ctx.terminal_program = "screen";
    else if (process.env.WEZTERM_PANE)
        ctx.terminal_program = "WezTerm";
    else if (process.env.KITTY_WINDOW_ID)
        ctx.terminal_program = "kitty";
    else if (process.env.WT_SESSION)
        ctx.terminal_program = "WindowsTerminal";
    ctx.terminal_session_id =
        process.env.ITERM_SESSION_ID ||
            process.env.WT_SESSION ||
            process.env.WEZTERM_PANE ||
            process.env.KITTY_WINDOW_ID ||
            process.env.VSCODE_PID ||
            undefined;
    // Parent linkage for subagents (set by orchestrators that spawn child Claude
    // processes; harmless when absent).
    if (process.env.CLAUDE_PARENT_SESSION_ID) {
        ctx.parent_session_id = process.env.CLAUDE_PARENT_SESSION_ID;
    }
    if (process.env.CLAUDE_PARENT_AGENT_NAME) {
        ctx.parent_agent_name = process.env.CLAUDE_PARENT_AGENT_NAME;
    }
    try {
        const ui = os.userInfo();
        if (ui.username)
            ctx.username = ui.username;
        if (typeof ui.uid === "number" && ui.uid >= 0)
            ctx.user_id = String(ui.uid);
    }
    catch {
        // sandboxes without uid mapping
    }
    cached = ctx;
    return ctx;
}
/** Test seam — let unit tests reset the per-process cache. */
export function _resetClientContextCache() {
    cached = undefined;
}
