---
disable-model-invocation: false
---

# /claudesaver:local

Toggle Local Model Mode on/off.

Call `claudesaver_level` with action `"toggle_local"`.

- **If currently at Level 5 (Offline):** restores your previous delegation level and confirms "Local Mode OFF — back to Level N (Name)"
- **If at any other level:** saves your current level and switches to Level 5, confirming "Local Mode ON — all tasks routed to Ollama"

Display the result concisely in one line.
