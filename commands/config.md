---
disable-model-invocation: false
---

# /claudesaver:config

Configure Claude-Saver settings interactively.

Show the current configuration by reading `~/.claude-saver/config.json` (or defaults if it doesn't exist). Ask the user what they'd like to change:

1. **Delegation level** (0-5)
2. **Ollama URL** (default: http://localhost:11434)
3. **Default model** (e.g., qwen3:8b, llama3.2:3b)
4. **Fallback model** (optional)
5. **Specialist model mappings** (model per task category)

Use `claudesaver_level` and `claudesaver_models` tools to validate settings before saving.
