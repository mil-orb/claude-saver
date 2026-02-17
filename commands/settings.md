---
disable-model-invocation: false
---

# /claudesaver:settings

Unified ClaudeSaver dashboard. Shows current status and lets the user change settings interactively.

## Step 1: Gather current state

Call these MCP tools in parallel to build the dashboard:

1. `claudesaver_models` with action `"health"` — get Ollama connectivity, latency, URL
2. `claudesaver_models` with action `"list"` — get available models and default
3. `claudesaver_level` with action `"get"` — get current delegation level, name, description
4. `claudesaver_metrics` with action `"summary"` — get total tasks, local tasks, tokens saved, cost saved

## Step 2: Display the dashboard

Format the results as a clear dashboard. Use this layout:

```
ClaudeSaver Dashboard
─────────────────────
Connection:  {healthy ? "Connected" : "Disconnected"} ({latency}ms) — {url}
Level:       {level} ({name}) — {description}
Model:       {default_model}
Models:      {count} available ({model_names, comma-separated, max 5})

Savings
  Tasks:     {total_tasks} total, {local_tasks} local
  Tokens:    {total_local_tokens} processed locally
  Saved:     ~${estimated_cost_saved}
```

If Ollama is disconnected, show the connection error and suggest `ollama serve`.

## Step 3: Offer options

After displaying the dashboard, ask the user what they'd like to do using numbered options:

1. **Change delegation level** — "Route more or fewer tasks locally"
2. **Change default model** — "Switch which Ollama model handles tasks"
3. **Set fallback model** — "Backup model if primary fails"
4. **Toggle metrics logging** — "Currently {enabled/disabled}"
5. **Reset savings history** — "Clear metrics.jsonl and start fresh"
6. **View all levels** — "See what each level (0-5) does"
7. **Done** — "Exit settings"

Use the `AskUserQuestion` tool to present these options. Wait for the user's choice.

## Step 4: Handle the choice

### Option 1 — Change delegation level
Use `AskUserQuestion` with these options:
- "0 — Off (manual only)"
- "1 — Conservative (docstrings, commits)"
- "2 — Balanced (default, routine tasks)"
- "3 — Aggressive (most tasks local)"
- "4 — Max Local (try everything locally)"
- "5 — Offline (no cloud fallback)"

After selection, call `claudesaver_level` with action `"set"` and the chosen level. Confirm the change.

### Option 2 — Change default model
Call `claudesaver_models` with action `"list"` to get available models. Present them as options via `AskUserQuestion`. After selection, read `~/.claudesaver/config.json`, update `ollama.default_model`, and write it back. Confirm the change.

### Option 3 — Set fallback model
Same as option 2, but update `ollama.fallback_model`. Explain that this model is used when the primary model fails (e.g., model not loaded, OOM).

### Option 4 — Toggle metrics
Read `~/.claudesaver/config.json`, flip `metrics.enabled`, write back. Confirm whether metrics are now enabled or disabled.

### Option 5 — Reset savings
Call `claudesaver_metrics` with action `"reset"`. Confirm the reset.

### Option 6 — View all levels
Call `claudesaver_level` with action `"describe"`. Display the full table of levels with their names and descriptions. Highlight the current level.

### Option 7 — Done
Say "Settings saved." and end.

## Loop

After handling any option (except "Done"), return to Step 2 — redisplay the updated dashboard and offer options again. This lets users make multiple changes in one session.
