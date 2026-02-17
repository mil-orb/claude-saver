---
disable-model-invocation: false
---

# /claudesaver:ask

Run a prompt entirely on the local Ollama model. The user's message after this command is the prompt.

## Instructions

1. Take whatever text the user provided after `/claudesaver:ask` as the prompt.
2. Call `claudesaver_complete` with that prompt as-is. Do not modify or rephrase it.
3. Return the local model's response directly to the user.
4. After the response, add a one-line footer: `[Local: {model} | {tokens_used} tokens | {duration_ms}ms]`

If the tool call fails (Ollama not running, model not loaded), tell the user the error and suggest running `ollama serve`.

This command exists so users can explicitly send any prompt to the local model without Claude deciding whether to delegate. Everything goes local, no exceptions.
