---
disable-model-invocation: true
---

# /claudesaver:status

Show ClaudeSaver status including Ollama connectivity, current delegation level, available models, and session stats.

Use the `claudesaver_models` tool with action "health" to check Ollama status, then `claudesaver_level` with action "get" to show the current level.

Display a concise summary:
- Ollama status (connected/disconnected, latency)
- Current delegation level and name
- Default model
- Available models count
