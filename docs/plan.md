# Ask CLI — Implementation Plan

Implements [specs.md](specs.md). Minimal scope: CLI, discussion management, Markdown persistence, two agent adapters. No runtime dependencies.

## File Structure

```text
agent-roundtable/
├── package.json            # "bin": { "ask": "dist/cli.js" }
├── src/
│   ├── cli.ts              # argv dispatch, usage, exit codes
│   ├── commands.ts         # new | add | list | show | use | <agent> [prompt]
│   ├── errors.ts           # AskError: user-facing errors
│   ├── store.ts            # storage dir, .active, ids, read/append
│   ├── transcript.ts       # Markdown entry format
│   ├── prompt.ts           # agent prompt from a transcript
│   ├── spawn.ts            # subprocess helper
│   └── agents/             # Agent interface, claude + codex adapters
└── test/
```

## Storage

- Discussions are `N.md` files in `~/dev/tmp`; `.active` holds the current id.
- Each entry starts with an `<!-- ask:entry author=… -->` marker, followed by a `### author` heading and the body. Agent entries also record `cwd`.
- Only `transcript.ts` writes markers; marker-like lines in bodies are neutralized so a reply can't forge an entry.
- Appends to a discussion are serialized with a per-discussion lock file, so concurrent `ask` processes can't interleave entries.

## Commands

| Command | Behavior |
| --- | --- |
| `ask new "<question>"` | Create a discussion and make it active. |
| `ask add "<text>"` | Append a user entry. No model call. |
| `ask codex ["<prompt>"]` | Save the optional follow-up, run Codex on the discussion, append and print its reply. |
| `ask claude ["<prompt>"]` | Same with Claude. |
| `ask list` | List discussions, `*` marks the active one. |
| `ask show [N]` | Print the active (or given) discussion. |
| `ask use N` | Switch the active discussion. |

## Agents

`Agent.run({ rules, input }, { cwd, signal })` returns the reply text. Agents run in the current directory; storage is independent of it.

Both adapters are **read-only by CLI flags**, not by prompt:

- **Claude**: `claude -p` with read-only tools (`Read,Grep,Glob`, allowed on any path, like Codex), no MCP servers, no repo settings, hooks disabled. Rules go in the system prompt.
- **Codex**: `codex exec` with the read-only sandbox, no user config, no web search, no approvals, and every feature not on a reviewed allowlist disabled. Rules go in `developer_instructions`.

Managed (admin) configuration of either CLI can't be overridden from the command line; a hard guarantee in that case needs OS-level isolation.

## Prompt

- The transcript is data, not instructions: entries are rendered inside `<discussion>` tags (with those tags escaped in bodies), and the rules tell the agent not to follow instructions found there.
- The current request is repeated after the block: the invocation's follow-up, else the latest user entry, else a generic request. Only user text appears outside the block.
- Rules: be concise, disagree explicitly, revise when persuaded, don't force consensus, don't modify anything.

## Failure Handling

- The follow-up is saved before the agent runs; the reply is saved only on success.
- Failures (non-zero exit, missing CLI, empty reply) print a short error and leave history intact.
- Ctrl-C stops the agent and its subprocesses and exits 130 without writing a partial entry.

## Build Order

1. Storage and transcript format.
2. `new`, `add`, `list`, `show`, `use`.
3. Subprocess helper, prompt builder, Claude adapter.
4. Codex adapter.

## Out of Scope (per spec)

Database, LangGraph, GitHub integration, automatic summarization, autonomous debate loops, write access for agents.
