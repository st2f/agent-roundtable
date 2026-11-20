import { createClaudeAgent } from "./claude.ts";
import type { Agent } from "./types.ts";

export type { Agent, AgentPrompt, AgentRunOptions } from "./types.ts";

/** Agents available as `ask <name>`. Codex is added in step 4. */
export function defaultAgents(): Record<string, Agent> {
  return { claude: createClaudeAgent() };
}
