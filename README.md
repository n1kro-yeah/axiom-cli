# Axiom

**The agentic coding assistant for your terminal.**

Axiom is a production-grade terminal AI coding agent in the spirit of Claude Code and OpenCode.
It reads and edits files, runs shell commands, searches codebases, connects external tools over
MCP, delegates subtasks to isolated subagents, keeps resumable session history with file
checkpoints — all inside a fast Ink-based TUI that works natively on Windows, macOS and Linux.

```
   ╲ ╱
  ( o.o )   axiom
   > ^ <
```

## Feature overview

| Area | What you get |
| --- | --- |
| Providers | Anthropic (thinking + prompt caching), any OpenAI-compatible endpoint (OpenRouter, Groq, DeepSeek, Ollama, LM Studio), Google Gemini |
| Agent loop | Streaming SSE with reasoning blocks, tool-calls, retries with backoff, abort, queued messages |
| Tools | read, write, edit, patch (unified diff), bash, glob, grep, ls, fetch, todo_write, task (subagents), lsp_diagnostics |
| Permissions | normal / accept / plan / bypass modes, glob rules (allow/deny/ask), always-remember patterns, audit log |
| Sessions | JSONL persistence per project, resume/continue, rename, delete, Markdown export, usage+cost tracking |
| Checkpoints | Automatic file snapshots before every modification, `/undo` and `/redo` |
| Context | AGENTS.md / CLAUDE.md rules tiers, skills (`SKILL.md`), auto-compaction at configurable context threshold, manual `/compact` |
| Extensibility | MCP servers over stdio and Streamable HTTP, project hooks on lifecycle events, LSP diagnostics bridge |
| UI | Ink v5 TUI: markdown rendering, diff views, fuzzy `@file` references, slash-command autocomplete, input history, themes, EN/RU localization |

## Requirements

- Node.js **22+**
- npm

## Install from source

```shell
git clone <your-fork-url> axiom
cd axiom
npm install
npm run build
npm link
```

After linking, the `axiom` command is available globally. For development without linking:

```shell
npm run dev          # tsx src/index.ts
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

## First run

```shell
cd your-project
axiom
```

On first launch Axiom creates `~/.axiom/config.json`. Add a provider credential either by
setting the standard environment variable or by storing it:

```shell
set ANTHROPIC_API_KEY=sk-ant-...        # Windows cmd
axiom                                   # start the TUI
```

Recognized variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`; local servers (Ollama, LM Studio)
need no key.

## Command line

| Command | Purpose |
| --- | --- |
| `axiom` | Start the interactive TUI in the current directory |
| `axiom -p "prompt"` | Run one prompt headlessly (text output) |
| `axiom -p "prompt" --output-format json` | Headless with a JSON envelope |
| `axiom -p "prompt" --output-format stream-json` | Headless event stream |
| `axiom -c` | Continue the latest session of this project |
| `axiom -r <id>` | Resume a session by id |
| `axiom --model provider/model` | Override model for this run |
| `axiom --mode plan` | Start in a specific permission mode |
| `axiom sessions` | List saved sessions |
| `axiom trust [--revoke]` | (Un-)trust this project's config/skills/hooks |
| `axiom config` | Print effective configuration and paths |
| `axiom undo` / `axiom redo` | Checkpoint operations for the latest session |

Piped stdin is appended to `-p` prompts automatically:
`cat error.log | axiom -p "triage this" --output-format json`.

## Slash commands

Type `/` in the TUI. Highlights:

| Command | Purpose |
| --- | --- |
| `/model [provider/model]` | Switch model (picker when empty) |
| `/provider` | Show providers and credential status |
| `/login` · `/logout` · `/keys` | Manage stored credentials |
| `/effort low\|medium\|high` | Reasoning depth multiplier for thinking budget |
| `/thinking` | Toggle extended thinking |
| `/mode` · `/bypass` | Permission mode control (also Shift+Tab) |
| `/sessions` · `/resume <id>` | Browse or resume history |
| `/compact [instructions]` | Summarize older context now |
| `/undo` · `/redo` | Revert/reapply file checkpoints |
| `/usage` · `/checker` | Token/cost report; full environment diagnostics |
| `/prompt save\|list\|rm` | Reusable prompts |
| `/skills` | Discovered skills list |
| `/mcp add\|list\|enable\|disable\|delete` | Live MCP server management |
| `/export [name]` | Export conversation to `.axiom/exports/*.md` |
| `/theme` · `/lang` | Accent color; EN/RU interface language |
| `/help` · `/exit` | Help overlay; quit |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send message / accept autocomplete |
| `↑` / `↓` | Input history · navigate pickers |
| `Tab` | Accept popup completion |
| `Shift+Tab` | Cycle permission modes |
| `Esc` | Stop generation · close overlay · clear input |
| `Ctrl+T` | Expand last thinking block |
| `E` | Expand last tool output |
| `Ctrl+C` twice | Quit (single press stops generation first) |

## Permission modes

- **normal** — file edits, shell commands, MCP calls require approval; allow-once or
  always-for-this-pattern
- **accept** — file edits are auto-approved; commands still ask; high-risk always asks
- **plan** — read-only exploration; the agent produces an implementation plan instead of changes
- **bypass** — nothing asks; intended for containers and CI

Rules can be preconfigured in `~/.axiom/config.json`:

```json
{
  "permissions": [
    { "tool": "bash", "pattern": "git status", "decision": "allow" },
    { "tool": "bash", "pattern": "git push*", "decision": "deny" },
    { "tool": "write", "pattern": ".axiom/*", "decision": "allow" }
  ]
}
```

## Configuration layout

| Path | Contents |
| --- | --- |
| `~/.axiom/config.json` | Global settings (model, mode, effort, theme, providers, mcp, hooks, permissions) |
| `~/.axiom/auth.json` | Provider API keys (created with restrictive permissions) |
| `~/.axiom/sessions/` | Session transcripts (JSONL) + sidecar metadata |
| `~/.axiom/checkpoints/` | File snapshots backing `/undo` |
| `~/.axiom/prompts/` | Saved prompts |
| `~/.axiom/skills/` | Global skills |
| `./.axiom/config.json` | Project config (requires `axiom trust`) |
| `./.axiom/skills/` | Project skills |
| `./AGENTS.md` / `CLAUDE.md` / `AXIOM.local.md` | Rules tiers injected into the system prompt |

Minimal custom provider example:

```json
{
  "version": 1,
  "model": "openrouter/anthropic/claude-sonnet-4.5",
  "providers": {
    "openrouter": {
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "keyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

MCP servers support `${env:NAME}` expansion so secrets never land in config files:

```json
{
  "mcp": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" },
      "enabled": true
    }
  }
}
```

## Skills

A skill is a directory containing `SKILL.md` with optional YAML frontmatter:

```markdown
---
name: release-checklist
description: Steps to cut a release safely
allowed-tools: [bash, read]
---
1. Run the full test suite...
```

Global skills live in `~/.axiom/skills/<name>/SKILL.md`, project skills in
`.axiom/skills/<name>/SKILL.md` (project wins on name conflicts). Bodies load into the system
prompt only while relevant-sized; use `disable-model-invocation: true` for manual-only skills.

## Hooks

Hooks are shell commands fired at lifecycle points. Stdin receives a JSON payload; exit code
`2` or `{"decision":"block","reason":"..."}` blocks the action (`pre_tool_use`):

```json
{
  "hooks": [
    { "event": "pre_tool_use", "command": "node scripts/guard.js", "matcher": "write", "timeoutMs": 15000 },
    { "event": "session_end", "command": "node scripts/archive-session.js" }
  ]
}
```

Events: `session_start`, `session_end`, `pre_tool_use`, `post_tool_use`, `stop`,
`pre_compact`, `post_compact`.

## Architecture

```
src/
├── index.ts           entrypoint: runtime guards → cli/program.main()
├── types.ts           central domain types (messages, parts, stream events, tools)
├── util/              sse parser + async queue, myers diff, unified patch engine,
│                      fuzzy matcher + globs, gitignore walker, partial-json repair,
│                      ring-buffer logger, retry-aware errors
├── config/            zod schemas, path resolution, global/project/trust loader
├── auth/              credential store with env fallbacks and ${env:} expansion
├── providers/         wire mappers + streaming adapters: anthropic, openai-compatible,
│                      gemini; model catalog with pricing; registry
├── agent/             the loop (stream → tools → permissions → repeat), context builder,
│                      compaction, token/cost accounting, title generation
├── tools/             12 built-in tools + registry + external tool sources (MCP, LSP)
├── permissions/       rule engine (modes, globs, memory) + decision audit
├── hooks/             lifecycle hook runner with blocking semantics
├── session/           JSONL store + checkpoint manager (undo/redo)
├── mcp/               JSON-RPC 2.0 core, stdio transport, Streamable HTTP transport,
│                      connection manager and tool bridge
├── lsp/               Content-Length framed LSP client, server auto-detection
├── skills/ rules/     SKILL.md and AGENTS.md loaders
├── commands/          slash-command registry + handlers
├── i18n/              en + ru dictionaries
├── cli/               bootstrap runtime bundle, headless runner, argv program
└── ui/                Ink v5 app: components, hooks, markdown renderer, themes
```

Design notes:

- The agent loop is provider-agnostic: adapters translate a single `StreamEvent` union, so
  tool-call accumulation, reasoning blocks and stop reasons behave identically across vendors.
- Completed chat output commits through Ink's `<Static>` into native terminal scrollback; only
  the live area re-renders, keeping streaming smooth even for long sessions.
- File mutations snapshot before writing, so `/undo` is always available — including files the
  agent deleted.
- Everything is Windows-first: shell selection, process-tree kills, path sandboxing and ANSI
  capability detection are handled explicitly.

## Development

```shell
npm run dev         # run from TypeScript via tsx
npm run typecheck   # strict TS, zero errors expected
npm test            # vitest suite covering sse, diffs, permissions, sessions, tools…
npm run build       # esbuild bundle → dist/index.js (bin/axiom.js loads it)
```

Logs land in `~/.axiom/logs/axiom.log` (rotated); set `AXIOM_LOG_LEVEL=debug` for verbose runs.

## License

MIT
