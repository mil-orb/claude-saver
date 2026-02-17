# Claude-Saver

**Route routine coding tasks to local Ollama models. Keep cloud tokens for work that needs them.**

Claude-Saver is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that adds an intelligent delegation layer between Claude and your local GPU. Docstrings, commit messages, boilerplate, format conversions, and file analysis run locally via [Ollama](https://ollama.com/) — architecture decisions, debugging, and security review stay on the cloud API. A 5-layer classification engine handles routing automatically; you just set a delegation level and code normally.

## Quick Start

**Prerequisites:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, [Ollama](https://ollama.com/) running locally, Node.js >= 18

```bash
# 1. Pull a model (any model works — here are two good starting points)
ollama pull qwen3:8b           # 5GB, fast, good for most tasks
ollama pull devstral:24b       # 14GB, stronger code generation

# 2. Install the plugin
/plugin marketplace add mil-orb/claude-saver
/plugin install claude-saver

# 3. Start a Claude Code session — you'll see:
#    [ClaudeSaver] Ollama connected (42ms) — Level 2 (Balanced)
#    Models: qwen3:8b, devstral:24b | Default: qwen3:8b
#    Savings: No local completions yet — start delegating to save tokens!
```

That's it. Claude will start routing suitable tasks locally.

### Manual Installation

```bash
git clone https://github.com/mil-orb/claude-saver.git
cd claude-saver
npm install && npm run build
```

Then add to `.claude/settings.json`:
```json
{
  "plugins": ["path/to/claude-saver"]
}
```

## What Gets Delegated

At the default level (Level 2 — Balanced), here's the split:

| Runs locally (saves tokens) | Stays on cloud (keeps quality) |
|---|---|
| Docstrings and comments | Architecture decisions |
| Commit messages | Complex multi-file debugging |
| Format conversions (JSON/YAML/CSV) | Security review |
| Boilerplate and scaffolding | Novel problem-solving |
| File summaries and analysis | Anything you ask Claude's opinion on |
| Simple code generation with clear specs | Multi-step reasoning across a codebase |
| Unit test boilerplate | Design trade-off discussions |

The boundary shifts based on your delegation level:

| Level | Name | What goes local |
|---|---|---|
| 0 | Off | Nothing — manual MCP tool calls only |
| 1 | Conservative | Docstrings, commit messages, formatting |
| 2 | **Balanced** (default) | Above + boilerplate, scaffolding, summaries, simple codegen |
| 3 | Aggressive | Above + most code generation, tests, refactoring |
| 4 | Max Local | Everything attempted locally first, escalate on poor quality |
| 5 | Offline | All tasks local — no cloud fallback |

Change the level anytime:
```
/claudesaver:level
```

## Estimated Savings

How much does routing locally actually save? It depends on your delegation level and workload. Here are projections based on measured token counts from real Ollama completions, priced against Claude Opus 4 ($15/M input, $75/M output):

| Level | Tasks/Day | Daily Tokens | Monthly Tokens | Monthly Savings |
|---|---|---|---|---|
| 1 — Conservative | 12 | 7K | 158K | ~$9 |
| **2 — Balanced** (default) | **30** | **30K** | **660K** | **~$40** |
| 3 — Aggressive | 55 | 77K | 1.7M | ~$102 |
| 4 — Max Local | 80 | 144K | 3.2M | ~$190 |

At the default level, a typical day saves **~30K cloud tokens** — roughly **$40/month**. Bump to Level 3 and most code generation runs locally, pushing savings to **~$100/month**.

> **Note:** Assumes 5 work days/week, 22 days/month, single developer. Using Sonnet instead of Opus? Divide by ~4. Token counts from measured Ollama completions across docstrings, commit messages, boilerplate, and code generation tasks.

To check your actual savings anytime:
```
/claudesaver:status
```

## How It Works

```
Session Start
    │
    ▼
SessionStart hook checks Ollama health
    │
    ├─ Ollama down? → Plugin stays silent, Claude works normally
    │
    └─ Ollama up → Injects delegation instructions into Claude's context
                    based on your configured level
    │
    ▼
During the session, Claude encounters a task
    │
    ▼
5-Layer Classification Engine decides routing:
    │
    ├─ Layer 1: Static Patterns — 24 regex rules (0 tokens, instant)
    ├─ Layer 2: Signal Heuristics — 12 complexity signals (0 tokens)
    ├─ Layer 3: Local Model Triage — small LLM classifies ambiguous tasks (~200 tokens)
    ├─ Layer 4: Try-Local-First — attempt local, escalate on failure (Level 3+)
    └─ Layer 5: Historical Learning — per-task success rates after 50+ records
    │
    ▼
Task runs on Ollama or cloud API
    │
    ▼
SubagentStop hook logs metrics to ~/.claudesaver/metrics.jsonl
```

Key design choices:
- **Fail-open** — If Ollama is down or a hook errors, Claude works exactly as before. Nothing breaks.
- **Zero file content to cloud** — The `claudesaver_fs` tools return metadata only (tree, stat, line counts). File contents never leave your machine through the MCP server.
- **Classification costs almost nothing** — Layers 1-2 use zero tokens. Layer 3 uses ~200 local tokens. Most tasks are classified by Layer 1 or 2.

## MCP Tools (9 tools)

### Tier 0: Filesystem (zero tokens, no LLM)

| Tool | What it does |
|---|---|
| `claudesaver_fs` | Tree, list, find, stat, count_lines, git_status, git_log, git_diff_names |
| `claudesaver_fs_preview` | File structure: function names, imports, exports, signatures (never raw content) |

### Tier 1: Local LLM (Ollama, zero cloud tokens)

| Tool | What it does |
|---|---|
| `claudesaver_complete` | General completion with routing metadata |
| `claudesaver_generate_code` | Structured code generation with language-specific prompts |
| `claudesaver_analyze_file` | Summarize, find bugs, explain, or suggest refactors for a file |
| `claudesaver_batch` | Run up to 100 prompts in parallel (configurable concurrency) |

### Management (zero tokens)

| Tool | What it does |
|---|---|
| `claudesaver_models` | List available Ollama models, check health |
| `claudesaver_level` | Get, set, or describe delegation levels (0-5) |
| `claudesaver_metrics` | View cumulative savings, reset history |

## Slash Commands

| Command | Description |
|---|---|
| `/claudesaver:settings` | Integrated dashboard — view status, change level, switch models, toggle metrics, reset savings |
| `/claudesaver:local` | Toggle Local Model Mode — switch between your current level and Level 5 (all tasks local) |
| `/claudesaver:status` | Quick Ollama health and savings check |
| `/claudesaver:level` | Get or set delegation level (`/claudesaver:level 3`) |
| `/claudesaver:config` | Edit configuration interactively |
| `/claudesaver:setup-statusline` | Add delegation level and model to your terminal status bar |
| `/claudesaver:benchmark` | Compare local vs cloud output for a task |

## Configuration

Settings live in `~/.claudesaver/config.json`. The plugin creates this directory automatically. All fields have sensible defaults — you only need to configure what you want to change.

```json
{
  "delegation_level": 2,
  "ollama": {
    "base_url": "http://localhost:11434",
    "default_model": "qwen3:8b",
    "fallback_model": null,
    "timeout_ms": 120000,
    "health_timeout_ms": 3000
  },
  "routing": {
    "use_local_triage": true,
    "use_historical_learning": false,
    "learner_min_records": 50,
    "enable_decomposition": false
  },
  "metrics": {
    "enabled": true,
    "log_path": "~/.claudesaver/metrics.jsonl"
  },
  "welcome": {
    "show_savings": true,
    "show_models": true,
    "show_level": true,
    "cost_per_million_tokens": 8
  }
}
```

**`delegation_level`** — Controls routing aggressiveness (0-5). Start at 2, bump to 3 once you trust your model.

**`ollama.default_model`** — Which model handles delegated tasks. Thinking models like `qwen3:8b` or `devstral:24b` work well.

**`ollama.fallback_model`** — Backup model used when the primary fails (e.g., model not loaded, OOM). Set to a smaller model like `qwen3:1.7b` for resilience, or leave `null` to disable.

**`ollama.timeout_ms`** — How long to wait for Ollama responses. Increase if you're running large models on CPU.

**`routing.use_local_triage`** — When true, ambiguous tasks (not caught by patterns or heuristics) get classified by your local model before routing. Costs ~200 local tokens per ambiguous task. Recommended.

**`routing.use_historical_learning`** — When true, the learner adjusts routing confidence based on past success rates per task type. Requires `learner_min_records` history entries before activating.

**`routing.learner_min_records`** — How many history records the learner needs before it starts adjusting routing decisions. Default 50. Lower to 20-30 if you want faster adaptation.

**`metrics.enabled`** — Set `false` to stop writing completion metrics to disk. Metrics are still readable (for existing data) but no new entries are logged.

**`metrics.log_path`** — Where metrics JSONL is stored. Supports `~` for home directory. Change this to keep metrics in a project-specific location.

**`welcome.cost_per_million_tokens`** — Used to estimate dollar savings in the status display. Defaults to $8/M (approximate Claude output token cost).

## Troubleshooting

**"[ClaudeSaver] Ollama not available" on session start**
Ollama isn't running or isn't reachable at the configured URL. Check:
```bash
curl http://localhost:11434/api/tags    # Should return JSON with models list
ollama serve                            # Start Ollama if not running
```

**Plugin installed but Claude isn't delegating anything**
- Check your delegation level: `/claudesaver:level` — Level 0 means manual only
- Verify Ollama has models: `ollama list`
- Check the session start message — if you don't see `[ClaudeSaver]`, the hook isn't running

**Local model output is poor quality**
- Try a larger model: `devstral:24b` or `qwen3:14b` produce better code than smaller variants
- Lower your delegation level to 1 or 2 so only trivial tasks go local
- The classification engine is designed to escalate to cloud when local quality is insufficient (Level 3+ with try-local-first)

**Ollama is slow**
- GPU acceleration: ensure Ollama is using your GPU (`ollama ps` shows VRAM usage)
- Reduce `ollama.timeout_ms` if you'd rather fail fast than wait
- Use smaller models for routine tasks — `qwen3:8b` is fast even on modest GPUs

**How do I see what was delegated?**
```
/claudesaver:status
```
Or use the MCP tool directly:
```
claudesaver_metrics summary
```
This shows total tasks, local task count, tokens used locally, and estimated savings.

## Related Projects

Claude-Saver is part of a growing ecosystem of Claude Code plugins:

- **[superpowers](https://github.com/obra/superpowers)** — Agentic workflow skills (brainstorming, TDD, code review, git worktrees). Complements Claude-Saver well: superpowers adds workflow structure, Claude-Saver reduces the token cost of executing those workflows.
- **[claude-mem](https://github.com/thedotmack/claude-mem)** — Persistent memory across Claude Code sessions via lifecycle hooks and MCP tools. Similar hook-based architecture to Claude-Saver.
- **[Claude Plugins Official Directory](https://github.com/anthropics/claude-plugins-official)** — Anthropic's curated plugin marketplace.

## Development

```bash
npm install
npm run build       # esbuild: TypeScript → CJS bundles in scripts/
npm run dev         # Watch mode
npm test            # 508 tests (unit + integration + E2E)
npm run typecheck   # tsc --noEmit
```

### Test Suite

| Category | Tests | What's covered |
|---|---|---|
| Unit tests | 445 | Classification engine, config, metrics, fs tools, security |
| Integration | 89 | Full routing pipeline with 50+ realistic prompts |
| E2E (subprocess) | 57 | Compiled bundles as real subprocesses: hooks, MCP JSON-RPC, manifest validation, cross-component metrics |

The E2E suite spawns the actual `.cjs` bundles the way Claude Code does — testing stdio transport, hook exit codes, config persistence round-trips, and metrics flow between hooks and MCP server. Ollama-dependent tests (9) auto-skip when Ollama isn't available.

### Project Structure

```
.claude-plugin/           Plugin manifest (plugin.json, marketplace.json)
.mcp.json                 MCP server configuration
agents/                   local-worker subagent definition
commands/                 Slash command definitions
config/                   Default configuration
hooks/                    hooks.json (SessionStart + SubagentStop)
scripts/
  build.js                esbuild bundler
  mcp-server.cjs          Compiled MCP server
  session-start-hook.cjs  Compiled SessionStart hook
  subagent-stop-hook.cjs  Compiled SubagentStop hook
skills/                   Smart delegation skill
src/
  hooks/                  Hook TypeScript source
  mcp-server/             MCP server + 5-layer classification engine
    index.ts              Server entry point (9 tools)
    router.ts             Task classification pipeline
    patterns.ts           Layer 1: static pattern matching
    signals.ts            Layer 2: signal heuristics
    triage.ts             Layer 3: local model triage
    escalation.ts         Layer 4: try-local-first
    learner.ts            Layer 5: historical learning
    config.ts             Config loading and persistence
    metrics.ts            JSONL metrics logging
    health.ts             Ollama health checks and chat
    fs-tools.ts           Filesystem operations
tests/
  integration/            Routing E2E + plugin subprocess E2E
  *.test.ts               Unit tests per module
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Fork, clone, branch
git checkout -b feature/your-feature
npm install && npm run build
npm test                    # All tests must pass
npm run typecheck           # No type errors
# Submit PR
```

## License

MIT
