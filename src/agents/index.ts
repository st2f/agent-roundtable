import { createClaudeAgent } from "./claude.ts";
import { createCodexAgent } from "./codex.ts";
import type { Agent } from "./types.ts";

export type { Agent, AgentPrompt, AgentRunOptions } from "./types.ts";

/** Agents available as `ask <name>`. */
export function defaultAgents(): Record<string, Agent> {
  return { codex: createCodexAgent(), claude: createClaudeAgent() };
}
