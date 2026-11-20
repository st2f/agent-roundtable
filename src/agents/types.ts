/** What an agent receives. Each adapter decides how to deliver the two parts. */
export interface AgentPrompt {
  rules: string; // role + rules (Claude: system prompt; Codex: top of stdin)
  input: string; // discussion block + current request
}

export interface AgentRunOptions {
  cwd: string; // the agent's working directory (where `ask` was run)
  signal?: AbortSignal; // aborting interrupts the agent (Ctrl-C)
}

export interface Agent {
  name: string;
  /** Resolves to the reply text; throws AskError on any failure. */
  run(prompt: AgentPrompt, options: AgentRunOptions): Promise<string>;
}
