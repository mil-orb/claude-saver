# Claude-Saver

[![CI](https://github.com/mil-orb/claude-saver/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/mil-orb/claude-saver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

**Run coding tasks on your local GPU. Save tokens. Use both models in one session.**

Claude-Saver is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that routes routine work to local [Ollama](https://ollama.com/) models running on your machine. Docstrings, commit messages, boilerplate, format conversions, file analysis, and simple code generation all run locally — while architecture decisions, debugging, and security review stay on the cloud API where they belong.

The result: lower API bills, faster responses for simple tasks, and file contents that never leave your machine.

---

## Why Claude-Saver?

**Save money.** Every token processed locally is a token you don't pay Anthropic for. Docstrings, commit messages, boilerplate, format conversions, file summaries — these routine tasks add up fast. Route them to your local GPU and keep your API budget for the work that actually needs it.

**Ask questions for free.** Type `cs ask` followed by any question — a hook intercepts it before Claude even sees it, runs the query on your local Ollama model, and hands back the answer. The heavy lifting is 100% local; Claude just displays the result. No terminal swapping, no copy-pasting. Your local GPU is one command away.

**Nothing breaks.** Claude-Saver is fail-open. If Ollama is down, if a model isn't loaded, if anything goes wrong — Claude works exactly as before. The plugin never blocks your session.

---

## Getting Started

### 1. Install Ollama

Download and install [Ollama](https://ollama.com/download) for your platform. Start it:

```bash
ollama serve
```

### 2. Pull a Model

Claude-Saver works with any Ollama model. Here's the recommended default:

```bash
# Recommended: strong coding model with 32K context
ollama pull slekrem/gpt-oss-claude-code-32k:latest
```

**Alternative models by GPU size:**

| Your GPU VRAM | Model | Pull Command | Notes |
|---|---|---|---|
| 4-6 GB | `qwen3:1.7b` | `ollama pull qwen3:1.7b` | Fast, good for docstrings and commits |
| 6-8 GB | `qwen3:8b` | `ollama pull qwen3:8b` | Good balance of speed and quality |
| 12-16 GB | `devstral:24b` | `ollama pull devstral:24b` | Strong code generation |
| 16+ GB | `slekrem/gpt-oss-claude-code-32k` | `ollama pull slekrem/gpt-oss-claude-code-32k:latest` | Recommended default, thinking model with 32K context |

Verify your model is loaded:
```bash
ollama list    # Should show your pulled model
ollama ps      # Shows running models and VRAM usage
```

### 3. Install the Plugin

```bash
# Via Claude Code plugin marketplace
/plugin marketplace add mil-orb/claude-saver
/plugin install claude-saver
```

**Or install manually:**

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

### 4. Start a Session

Launch Claude Code. You'll see the welcome message:

```
[Claude-Saver] Ollama connected (42ms) — Level 2 (Balanced)
Savings: No local completions yet — delegate 200+ token tasks to save.
Models: slekrem/gpt-oss-claude-code-32k:latest | Default: slekrem/gpt-oss-claude-code-32k:latest
```

Claude will now automatically route suitable tasks to your local model.

---

## What Gets Delegated

At the default level (Level 2 — Balanced):

| Runs locally (saves tokens) | Stays on cloud (keeps quality) |
|---|---|
| Docstrings and comments | Architecture decisions |
| Commit messages | Complex multi-file debugging |
| Format conversions (JSON/YAML/CSV) | Security review |
| Boilerplate and scaffolding | Novel problem-solving |
| File summaries and analysis | Multi-step reasoning across a codebase |
| Simple code generation with clear specs | Anything you ask Claude's opinion on |
| Unit test boilerplate | Design trade-off discussions |

**Break-even rule:** The mathematical break-even point is ~22 output tokens — below that, the tool-call overhead costs more than it saves. In practice, Claude-Saver skips delegation for tasks under ~200 tokens because the absolute savings are negligible (under $0.001 even at Opus pricing) and local models are more likely to produce low-quality output for very short tasks.

### Delegation Levels

| Level | Name | What goes local |
|---|---|---|
| 0 | Off | Nothing — manual MCP tool calls only |
| 1 | Conservative | Docstrings, commit messages, formatting |
| 2 | **Balanced** (default) | Above + boilerplate, scaffolding, summaries, simple codegen |
| 3 | Aggressive | Above + most code generation, tests, refactoring |
| 4 | Max Local | Everything attempted locally first, escalate on poor quality |
| 5 | Offline | All tasks local — no cloud fallback |

Change your level anytime via the interactive settings menu:
```
/claudesaver:settings
```

---

## Dashboard

Claude-Saver includes a local web dashboard for visualizing your token economics.

```
/claudesaver:dashboard
```

This opens `http://127.0.0.1:37888` in your browser with:

- **Net savings** — real savings after subtracting wrapper overhead
- **Efficiency score** — what percentage of local tokens are actual savings vs overhead
- **Savings over time** — line chart tracking local tokens and overhead per day
- **Token split** — donut chart showing net savings vs overhead
- **Tool usage** — which MCP tools you use most
- **Recent delegations** — per-call breakdown with model, tokens, overhead, and net impact

The dashboard auto-refreshes every 10 seconds and runs entirely on your machine.

---

## Ask Your Local Model — Without Leaving Claude Code

Every question you type in Claude Code costs API tokens. A simple "what does this function do?" can burn 500+ output tokens at $15-25/M. With Claude-Saver, that same question runs on your local GPU instead.

### Quick shorthand (hook-intercepted, near-zero cost)

```
cs ask what does this regex do: /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/
```

Type `cs ask` followed by your question directly in Claude Code. The **UserPromptSubmit hook** intercepts this before Claude processes it, spawns a local Claude Code instance pointed at Ollama (`ANTHROPIC_BASE_URL=http://localhost:11434`), and returns the answer. The heavy lifting is 100% local — Claude just relays the pre-computed result for ~50 output tokens instead of generating the answer itself.

Other hook shortcuts:
- `cs status` — health check and savings summary, handled locally
- `cs reset` — clear metrics history

### Slash command (uses some API tokens)

```
/claudesaver:ask explain the difference between mutex and semaphore
```

This routes through Claude's MCP tool system — still runs locally on Ollama, but Claude orchestrates the call, using more API tokens than the hook shorthand.

**Why this matters:**
- **Save tokens on simple questions** — "what's the syntax for X?", "explain this error", "convert this to YAML" — these don't need a $25/M model
- **Save context window** — questions answered locally don't add to Claude's conversation history, keeping your context window free for complex work
- **Compare answers** — ask the same question to both your local model and Claude to see when local is good enough

---

## Commands

### Hook shortcuts (near-zero tokens — intercepted before Claude processes)

| Shorthand | What happens |
|---|---|
| `cs ask <prompt>` | Runs prompt on Ollama via local `claude -p` — Claude just relays the result (~50 tokens) |
| `cs status` | Runs status check locally, returns pre-computed output |
| `cs reset` | Clears metrics history locally |

### Slash commands (uses API tokens — Claude orchestrates)

| Command | Description |
|---|---|
| `/claudesaver:ask` | Run any prompt on your local model via MCP tool call |
| `/claudesaver:settings` | Interactive dashboard — view status, change level, model, metrics, reset savings |
| `/claudesaver:dashboard` | Open the web metrics dashboard in your browser |

---

## MCP Tools

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

### Management

| Tool | What it does |
|---|---|
| `claudesaver_config` | Read, update, or reset plugin settings (dot-notation paths) |
| `claudesaver_models` | List available Ollama models, check health |
| `claudesaver_level` | Get, set, or describe delegation levels (0-5) |
| `claudesaver_metrics` | View savings metrics and overhead tracking, reset history |

---

## How Data Flows

- **`claudesaver_fs`** returns only metadata (file names, sizes, line counts). Raw file contents are never sent to the cloud.
- **`claudesaver_analyze_file`** reads and processes files locally on Ollama. The *analysis result* is returned to Claude as tool output, so a summary does flow through the cloud API — but the raw file contents stay local.
- **`cs ask` hook shortcuts** are the most private path — the question and answer are handled entirely by your local model. Claude only sees a short relay message (~50 tokens).
- **Metrics** are stored locally in `~/.claude-saver/metrics.jsonl`. No telemetry, no phone-home.
- **The dashboard** runs on `127.0.0.1` only.

---

## Configuration

Settings live in `~/.claude-saver/config.json`. The plugin creates this directory automatically. All fields have sensible defaults.

You can edit config via the MCP tool:
```
claudesaver_config set ollama.default_model "qwen3:8b"
claudesaver_config get delegation_level
claudesaver_config reset
```

Or via the interactive command:
```
/claudesaver:settings
```

### Full Config Reference

```json
{
  "delegation_level": 2,
  "ollama": {
    "base_url": "http://localhost:11434",
    "default_model": "slekrem/gpt-oss-claude-code-32k:latest",
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
    "log_path": "~/.claude-saver/metrics.jsonl"
  },
  "welcome": {
    "show_savings": true,
    "show_models": true,
    "show_level": true,
    "cost_per_million_tokens": 8
  }
}
```

| Field | Description |
|---|---|
| `delegation_level` | Routing aggressiveness (0-5). Start at 2, bump to 3 once you trust your model. |
| `ollama.default_model` | Which model handles delegated tasks. |
| `ollama.fallback_model` | Backup model if primary fails (OOM, not loaded). Set to a smaller model or `null`. |
| `ollama.timeout_ms` | Max wait for Ollama responses. Increase for large models on CPU. |
| `routing.use_local_triage` | Classify ambiguous tasks with your local model (~200 local tokens). Recommended on. |
| `routing.use_historical_learning` | Adjust routing based on past success rates. Needs `learner_min_records` entries first. |
| `metrics.enabled` | Set `false` to stop logging. Existing metrics remain readable. |
| `welcome.cost_per_million_tokens` | Used to estimate dollar savings. Default $8/M (blended estimate). Actual rates: Haiku $5/M, Sonnet $15/M, Opus $25/M output. |

---

## How It Works

```
Session Start
    |
    v
SessionStart hook checks Ollama health
    |
    +-- Ollama down? -> Plugin stays silent, Claude works normally
    |
    +-- Ollama up -> Injects delegation instructions + warms up model
    |
    v
During the session, Claude encounters a task
    |
    v
5-Layer Classification Engine decides routing:
    |
    +-- Layer 1: Static Patterns (24 regex rules, 0 tokens, instant)
    +-- Layer 2: Signal Heuristics (12 complexity signals, 0 tokens)
    +-- Layer 3: Local Model Triage (small LLM classifies, ~200 local tokens)
    +-- Layer 4: Try-Local-First (attempt local, escalate on failure)
    +-- Layer 5: Historical Learning (per-task success rates)
    |
    v
Task runs on Ollama or cloud API
    |
    v
Metrics logged with honest overhead tracking
```

**Layers 1-2 catch most tasks with zero token cost.** Pattern matching and heuristics handle clear-cut cases instantly. Only ambiguous tasks fall through to Layer 3 for local model triage.

---

## Troubleshooting

**"Ollama not available" on session start**
```bash
ollama serve                            # Start Ollama
curl http://localhost:11434/api/tags    # Should return JSON with models
```

**Claude isn't delegating anything**
- Check your level: `/claudesaver:settings` — Level 0 means manual only
- Verify models: `ollama list`
- Short tasks (<200 token output) are answered directly by design — the overhead isn't worth it

**Local model output is poor quality**
- Try a larger model: `devstral:24b` or `slekrem/gpt-oss-claude-code-32k` produce better results
- Lower your level to 1 or 2 so only trivial tasks go local
- Level 3+ uses try-local-first with automatic escalation on poor quality

**Ollama is slow**
- Check GPU: `ollama ps` shows VRAM usage — CPU inference is much slower
- Use smaller models for routine tasks
- Increase `ollama.timeout_ms` or switch to a lighter model

**Dashboard won't start**
- Port 37888 may be in use. Set `CLAUDE_SAVER_DASHBOARD_PORT=37889` and try again
- The dashboard only binds to `127.0.0.1` — it's not accessible externally

---

## Development

```bash
npm install
npm run build       # esbuild: TypeScript -> CJS bundles in scripts/
npm run dev         # Watch mode
npm test            # 570+ tests (unit + integration + E2E)
npm run typecheck   # tsc --noEmit
```

### Test Suite

| Category | Tests | Coverage |
|---|---|---|
| Unit tests | 430+ | Classification engine, config, metrics, fs tools, security, net savings accuracy |
| Integration | 89 | Full routing pipeline with 50+ realistic prompts |
| E2E (subprocess) | 57 | Compiled bundles as real subprocesses: hooks, MCP JSON-RPC, manifests, cross-component metrics |

The E2E suite spawns the actual `.cjs` bundles the way Claude Code does — testing stdio transport, hook exit codes, config persistence round-trips, and metrics flow. Ollama-dependent tests auto-skip when Ollama isn't available.

### Project Structure

```
.claude-plugin/           Plugin manifest
.mcp.json                 MCP server configuration
agents/                   local-worker subagent
commands/                 Slash commands (ask, settings, dashboard)
config/                   Default routing rules
hooks/                    hooks.json (SessionStart + UserPromptSubmit + SubagentStop)
scripts/
  build.js                esbuild bundler
  mcp-server.cjs          Compiled MCP server (9 tools)
  session-start-hook.cjs  SessionStart hook (health + welcome + model warm-up)
  prompt-submit-hook.cjs  UserPromptSubmit hook (cs ask / cs status / cs reset)
  subagent-stop-hook.cjs  SubagentStop hook (metrics logging)
  dashboard-server.cjs    Dashboard web server
  dashboard.html          Dashboard UI
skills/                   Smart delegation skill
src/
  dashboard/              Dashboard server + HTML source
  hooks/                  Hook TypeScript source
  mcp-server/             MCP server + 5-layer classification engine
tests/
  integration/            Routing E2E + plugin subprocess E2E
  *.test.ts               Unit tests per module
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git checkout -b feature/your-feature
npm install && npm run build
npm test                    # All tests must pass
npm run typecheck           # No type errors
```

## License

MIT
