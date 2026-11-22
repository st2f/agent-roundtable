import { cleanReply, runAgentProcess } from "./common.ts";
import type { Agent } from "./types.ts";

/**
 * Read-only by construction; nothing in the prompt can change these flags.
 * - --tools: only read-only built-in tools exist in the session.
 * - --allowedTools: those tools may read anywhere (`//**` is the filesystem root), not just
 *   the cwd, so files the discussion mentions by path are readable, as they are for Codex
 *   in its read-only sandbox. Deny rules from user settings still take precedence.
 * - --permission-mode dontAsk: anything not pre-approved is denied, never prompted.
 * - --strict-mcp-config (with no --mcp-config): no MCP servers, since --tools only
 *   restricts built-in tools and user-configured MCP tools could otherwise write.
 * - --setting-sources user: the inspected repo's .claude/settings*.json are ignored, so a
 *   repository can't configure hooks, helpers or permissions for this session.
 * - --settings disableAllHooks: no user or plugin hooks (shell commands) run either.
 *   Hooks from managed policy settings can't be disabled here; guaranteeing read-only
 *   behavior under such a policy needs an external isolation boundary (e.g. a sandbox).
 */
export function claudeArgs(rules: string, model?: string): string[] {
  return [
    "-p",
    ...(model === undefined ? [] : ["--model", model]),
    "--tools",
    "Read,Grep,Glob",
    "--allowedTools", // variadic: the next flag ends the list
    "Read(//**)",
    "Grep(//**)",
    "Glob(//**)",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--no-session-persistence",
    "--output-format",
    "text",
    "--append-system-prompt",
    rules,
  ];
}

export function createClaudeAgent(command = "claude"): Agent {
  return {
    name: "claude",
    async run(prompt, { cwd, model, signal }) {
      const result = await runAgentProcess("claude", {
        command,
        args: claudeArgs(prompt.rules, model),
        input: prompt.input, // -p without a prompt argument reads it from stdin
        cwd,
        signal,
      });
      return cleanReply("claude", result.stdout);
    },
  };
}
