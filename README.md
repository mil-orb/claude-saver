# Claude-Saver

**Save on Claude API tokens by intelligently routing tasks to local Ollama models.**

Claude-Saver is a Claude Code plugin that adds a local model delegation layer. Routine coding tasks (docstrings, commit messages, boilerplate, format conversions) run on your local GPU via Ollama, while complex work stays on the cloud API. Claude decides what to delegate based on a 5-layer classification engine — no manual intervention needed.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Ollama](https://ollama.com/) running locally with at least one model pulled
- Node.js >= 18.0.0

## Installation

```bash
/plugin marketplace add mil-orb/claude-saver
/plugin install claude-saver
```

Or install manually:

```bash
git clone https://github.com/mil-orb/claude-saver.git
cd claude-saver
npm install
npm run build
```

Then add to your Claude Code settings:
```json
{
  "plugins": ["path/to/claude-saver"]
}
```

## How It Works

On every session start, Claude-Saver checks if Ollama is running and injects delegation instructions into Claude's context. Claude then automatically routes suitable tasks to your local model.

### What gets delegated (Level 2 — Balanced, default)

| Local (saves tokens) | Cloud (keeps quality) |
|---|---|
| Docstrings, comments | Architecture decisions |
| Commit messages | Complex debugging |
| Format conversions (JSON/YAML/CSV) | Security review |
| Boilerplate & scaffolding | Multi-file reasoning |
| File summaries | Novel problem-solving |
| Simple code generation | Anything you ask Claude's opinion on |

### Delegation Levels

| Level | Name | Behavior |
|---|---|---|
| 0 | Off | Manual delegation only |
| 1 | Conservative | Only trivial tasks (docstrings, commit messages) |
| 2 | **Balanced** | Routine coding tasks |
| 3 | Aggressive | Most tasks go local |
| 4 | Max Local | Try everything locally first |
| 5 | Offline | All tasks local, no cloud processing |

Change the level:
```
/claudesaver:level
```

## MCP Tools

| Tool | Purpose | Tokens |
|---|---|---|
| `claudesaver_fs` | File tree, stat, find, git status/log | Zero |
| `claudesaver_fs_preview` | File structure, signatures, imports | Zero |
| `claudesaver_complete` | Send prompts to local model | Local only |
| `claudesaver_generate_code` | Code generation with templates | Local only |
| `claudesaver_analyze_file` | File analysis (summarize, bugs, explain) | Local only |
| `claudesaver_batch` | Parallel multi-prompt execution | Local only |
| `claudesaver_models` | List models, health check | Zero |
| `claudesaver_level` | Get/set delegation level | Zero |
| `claudesaver_metrics` | Token savings statistics | Zero |

## Classification Engine

Tasks are classified through 5 layers, each adding intelligence at minimal cost:

1. **Static Patterns** — Regex matching against 24 known task patterns (0 tokens, instant)
2. **Signal Heuristics** — Complexity scoring from 12 extracted signals (0 tokens)
3. **Local Model Triage** — Small local model classifies ambiguous tasks (~200 tokens)
4. **Try-Local-First** — Attempts local, escalates on failure signals (Level 3+)
5. **Historical Learning** — Per-task-type success rates after 50+ records

## Configuration

Settings live in `~/.claudesaver/config.json`:

```json
{
  "delegation_level": 2,
  "ollama": {
    "base_url": "http://localhost:11434",
    "default_model": "your-model:latest",
    "timeout_ms": 120000
  },
  "welcome": {
    "show_savings": true,
    "show_models": true,
    "show_level": true,
    "cost_per_million_tokens": 8
  }
}
```

## Slash Commands

| Command | Description |
|---|---|
| `/claudesaver:status` | Show Ollama health and statistics |
| `/claudesaver:level` | Get or set delegation level |
| `/claudesaver:config` | Configure settings |
| `/claudesaver:benchmark` | Compare local vs cloud output |

## Development

```bash
npm install
npm run build       # Bundle TypeScript to CJS
npm run dev         # Watch mode
npm test            # Run 139 tests
npm run typecheck   # TypeScript validation
```

### Project Structure

```
.claude-plugin/       Plugin manifest
agents/               local-worker subagent
commands/             Slash command definitions
config/               Default configuration
hooks/                SessionStart + SubagentStop hooks
scripts/              Build script + compiled bundles
skills/               Smart delegation skill
src/
  hooks/              Hook TypeScript source
  mcp-server/         MCP server + classification engine
tests/                Unit tests (139 cases)
```

## License

MIT
