# agent-roundtable

`ask` is a small CLI for holding persistent discussions between you, [Codex CLI](https://github.com/openai/codex), [Claude Code](https://claude.com/claude-code) and [GitHub Copilot CLI](https://github.com/github/copilot-cli).

You decide which model speaks and when. Each model sees the whole discussion so far, so it can agree, disagree or revise its view. Discussions are saved as Markdown files.

## Requirements

- Node.js 24 or later
- `codex`, `claude` and/or `copilot` installed and logged in

## Install

```sh
npm install
npm link    # builds and puts `ask` on your PATH
```

## Usage

```sh
ask new "Should we introduce Qdrant?"
ask codex					# Codex answers
ask claude        # Claude responds, seeing Codex's answer
ask codex "Focus on the performance implications"
ask add "What if we only use it for file discovery?"
ask claude
ask codex -m gpt-6.2-sol    # a specific model; saved as codex/gpt-6.2-sol
ask claude -m opus-5.5 "Do you agree with Codex?"
ask copilot -m gpt-6.2-sol  # Copilot always needs -m

ask list        # all discussions, * marks the active one
ask show        # print the active discussion (or: ask show 2)
ask use 2       # switch the active discussion
```

Run `ask` from the repository you want the agents to look at. They can read files there and elsewhere on disk, but can't change anything: `ask` starts every CLI with read-only flags. Managed (admin) configuration still applies and can't be overridden by those flags, so if your setup has any, run the agents in a sandbox or container when you need a hard guarantee.

## Storage

Discussions are saved as `~/dev/tmp/1.md`, `2.md`, and so on, and `~/dev/tmp/.active` holds the current one. You can read or edit the files directly.

## Development

```sh
npm test            # run the tests
npm run typecheck   # type-check src and test
npm run build       # compile to dist/

# live Copilot check through ask
ASK_LIVE_COPILOT=gpt-6.2-sol node --test test/copilot.live.test.ts
```

See [docs/specs.md](docs/specs.md) and [docs/plan.md](docs/plan.md) for the design.
