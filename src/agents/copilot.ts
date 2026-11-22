import { AskError } from "../errors.ts";
import { cleanReply, runAgentProcess } from "./common.ts";
import type { Agent } from "./types.ts";

/** The Copilot CLI version these flags were reviewed against (`copilot version`). */
export const COPILOT_REVIEWED_VERSION = "1.0.114";

/**
 * Model names that make Copilot choose a model per request ("fusion" is an alias of auto).
 * Rejected: replies from different models would all be saved under one voice.
 */
export const COPILOT_AUTO_MODELS: readonly string[] = ["auto", "fusion"];

const USAGE = 'Usage: ask copilot -m <model> ["<prompt>"]';

/** Copilot needs one specific model per voice. */
export function checkCopilotModel(model: string | undefined): asserts model is string {
  if (model === undefined) throw new AskError(`copilot needs a model. ${USAGE}`);
  if (COPILOT_AUTO_MODELS.includes(model.toLowerCase())) {
    throw new AskError(
      `copilot needs a specific model, not "${model}": with automatic selection, replies from different models would share one voice. ${USAGE}`,
    );
  }
}

/** Read-only built-in tools; every other tool, including MCP tools, is hidden from the model. */
export const COPILOT_TOOLS: readonly string[] = ["view", "grep", "glob"];

/**
 * Read-only by construction, using flags only: the user's Copilot settings are left as they
 * are. Nothing in the prompt can change these flags.
 * - --available-tools: the model only sees the read-only tools above, so shell, edit, web,
 *   memory, MCP and tools added by future releases are not offered at all.
 * - --deny-tool: second layer; deny rules win over every allow, including approvals saved
 *   with "don't ask again". Prompt mode denies anything not pre-approved anyway.
 * - --allow-tool read + --allow-all-paths: reads anywhere, like Claude and Codex.
 * - --disable-builtin-mcps: no GitHub MCP servers.
 * - --no-custom-instructions: the inspected repo's AGENTS.md, CLAUDE.md, etc. aren't loaded.
 * - --no-ask-user, -s, --no-color, --stream off: a plain reply on stdout, no questions.
 * - --no-auto-update: runs the installed (reviewed) version.
 *
 * Not covered (no flag for it): hooks from the user's settings, and from repositories the
 * user has trusted, still run as in any Copilot session; sessions are saved in
 * ~/.copilot/session-state. Managed (organization) policy applies too.
 */
export function copilotArgs(model: string): string[] {
  return [
    `--model=${model}`, // one argument, so the value can never be read as a flag
    `--available-tools=${COPILOT_TOOLS.join(",")}`,
    "--allow-tool=read",
    "--allow-all-paths",
    "--deny-tool=shell,write,memory,url",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-auto-update",
    "--no-color",
    "--stream",
    "off",
    "-s",
  ];
}

/** Copilot has no system-prompt flag: the rules go first on stdin, then the discussion. */
export function copilotInput(rules: string, input: string): string {
  return `${rules}\n\n${input}`;
}

export function createCopilotAgent(command = "copilot"): Agent {
  return {
    name: "copilot",
    checkModel: checkCopilotModel,
    async run(prompt, { cwd, model, signal }) {
      checkCopilotModel(model); // askAgent checks first; this guards direct callers
      const result = await runAgentProcess("copilot", {
        command,
        args: copilotArgs(model),
        input: copilotInput(prompt.rules, prompt.input), // no -p: the prompt comes from stdin
        cwd,
        signal,
      });
      return cleanReply("copilot", result.stdout);
    },
  };
}
