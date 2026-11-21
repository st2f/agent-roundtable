import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AskError } from "../errors.ts";
import { cleanReply, runAgentProcess, withTempDir } from "./common.ts";
import type { Agent, AgentPrompt } from "./types.ts";

/**
 * Features reviewed as safe to leave on: model/protocol plumbing, and tools that run inside
 * the read-only sandbox (shell, view_image). Every other known feature is disabled per run,
 * so features added by a future Codex release are off until reviewed and listed here.
 * Reviewed against codex-cli 0.171.0.
 */
export const CODEX_ALLOWED_FEATURES: ReadonlySet<string> = new Set([
  // Tools that run inside the sandbox. Code mode is how tool calls (exec_command, etc.)
  // are dispatched; without it Codex can't inspect the workspace at all.
  "code_mode_host",
  "code_mode_host_grpc",
  "code_mode_host_output_truncation",
  "code_mode_interrupt",
  "shell_tool",
  "shell_snapshot",
  "unified_exec",
  "unified_exec_tty",
  "write_stdin_approval",
  "view_image",
  "sleep_tool",
  // Model, protocol and context handling.
  "api_key_model_discovery",
  "auth_elicitation",
  "compaction_image_budget",
  "content_item_kinds",
  "deferred_tool_world_state",
  "enable_request_compression",
  "fast_mode",
  "ultrafast_mode",
  "incremental_tools",
  "incremental_tools_legacy",
  "incremental_tools_legacy_gcp",
  "instant_interrupt",
  "mentions_v2",
  "prediction_preserve_parent_tools",
  "reasoning_effort_override",
  "retain_client_tool_outputs",
  "unified_image_budget",
  "untrusted_as_tool_output",
  "system_proxy_fallback",
  "unbounded_connection_retries",
]);

export interface CodexFeature {
  name: string;
  stage: string; // "stable", "under development", "deprecated", "removed", ...
  enabled: boolean;
}

/** Parses `codex features list`; throws if any line doesn't look like `name stage... true|false`. */
export function parseFeatures(output: string): CodexFeature[] {
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const features = lines.map((line) => {
    const m = /^(\S+)\s+(.+?)\s+(true|false)\s*$/.exec(line);
    if (!m) throw new AskError(`Unexpected line in "codex features list": ${JSON.stringify(line)}`);
    return { name: m[1] ?? "", stage: m[2] ?? "", enabled: m[3] === "true" };
  });
  if (features.length === 0) throw new AskError('"codex features list" returned no features.');
  return features;
}

/**
 * Every known feature that isn't allowlisted, whatever its probed state: the probe runs
 * without the user's config, but the signed-in workspace can still supply defaults at run
 * time. Removed features have no effect and are skipped.
 */
export function featuresToDisable(features: CodexFeature[]): string[] {
  return features.filter((f) => f.stage !== "removed" && !CODEX_ALLOWED_FEATURES.has(f.name)).map((f) => f.name);
}

/** TOML basic string; JSON string escapes are a valid subset. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Read-only by construction; nothing in the prompt can change these flags.
 * - --sandbox read-only + approval_policy=never: shell commands and patches can't write,
 *   and nothing can be escalated (there is nobody to approve it).
 * - --ignore-user-config: ~/.codex/config.toml is skipped, so no MCP servers (which run
 *   outside the sandbox), profiles or project trust entries; the inspected repo's .codex/
 *   config therefore isn't trusted either. Auth still works. Trade-off: Codex uses its
 *   default model rather than the one configured there.
 * - --ignore-rules: no user/project execpolicy rules.
 * - --disable for every known, non-allowlisted feature, and web_search=disabled: no
 *   app connectors, plugins, hooks, browser/computer control or network tools.
 * - --ephemeral: no session files; history lives in the discussion Markdown.
 *
 * Not covered: system and managed (admin) Codex configuration still apply and can't be
 * overridden here. A hard guarantee under such configuration needs OS-level isolation.
 */
export function codexArgs(options: { rules: string; disable: string[]; outputFile: string }): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    // Rules as developer instructions: higher priority than the discussion on stdin.
    "-c",
    `developer_instructions=${tomlString(options.rules)}`,
    ...options.disable.flatMap((feature) => ["--disable", feature]),
    "-o",
    options.outputFile,
    "-", // discussion + current request from stdin
  ];
}

export function createCodexAgent(command = "codex"): Agent {
  return {
    name: "codex",
    async run(prompt: AgentPrompt, { cwd, signal }) {
      const disable = await withTempDir("ask-codex-home-", async (emptyHome) => {
        // Effective feature state as `exec --ignore-user-config` sees it: an empty CODEX_HOME
        // has no user config (`features list` has no --ignore-user-config flag).
        const result = await runAgentProcess("codex", {
          command,
          args: ["features", "list"],
          input: "",
          cwd,
          env: { ...process.env, CODEX_HOME: emptyHome },
          signal,
        });
        return featuresToDisable(parseFeatures(result.stdout));
      });

      return withTempDir("ask-codex-", async (dir) => {
        // stdout is progress output; the final message is written to this file (-o).
        const outputFile = join(dir, "last-message.md");
        await runAgentProcess("codex", {
          command,
          args: codexArgs({ rules: prompt.rules, disable, outputFile }),
          input: prompt.input,
          cwd,
          signal,
        });
        let reply: string;
        try {
          reply = await readFile(outputFile, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AskError("codex finished without writing a reply.");
          throw err;
        }
        return cleanReply("codex", reply);
      });
    },
  };
}
