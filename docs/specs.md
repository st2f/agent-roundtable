# Ask CLI — Multi-Model Discussion Tool

## Goal

Build a lightweight Node.js/TypeScript CLI named ask to maintain persistent discussions between the user, Codex CLI, and Claude Code CLI.

The user decides which model contributes and when. Models can agree, disagree, challenge suggestions, and revise their conclusions.

The tool should work from any directory, with or without a Git repository.

## Commands

```sh
ask new "Should we introduce Qdrant?"
ask codex
ask claude
ask codex "Focus on the performance implications"
ask add "What if we only use it for file discovery?"
ask claude
ask list
ask show
ask use 2

```

## Storage

Discussions are stored as Markdown files in ~/dev/tmp.

```text
~/dev/tmp/
├── .active
├── 1.md
├── 2.md
└── 3.md
```

Each file contains the original question and subsequent contributions, attributed to the user or model.

The .active file identifies the current discussion, avoiding shell environment variables.

## Behavior

- Invoke installed Codex and Claude Code CLIs as subprocesses.
- Pass the original question and discussion history to the selected model.
- Allow models to inspect the repository when relevant.
- Append responses to the Markdown discussion and display them in the terminal.
- Support optional follow-up prompts.
- Preserve model attribution and disagreements.
- Keep responses concise without losing important technical details.
- Do not automatically alternate models or force consensus.
- Keep agent execution read-only initially.
- Handle subprocess failures without losing discussion history.

The discussion storage location is independent of the agent’s working directory.

## Initial Scope

Keep the implementation minimal: CLI, discussion management, Markdown persistence, and two coding-agent adapters.

No database, LangGraph, GitHub integration, automatic summarization, or autonomous debate loops.

## Future Experiments

- ask copilot with specific model
- Add single MCP server that all agents can use for github read-only
- GitHub Discussions as shared conversation storage.
- Context management for long discussions.
- Additional model providers.
- Usage and cost tracking.

## Principle

Automate context sharing between coding agents while keeping the user in control of the conversation.
