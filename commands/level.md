---
disable-model-invocation: true
---

# /claudesaver:level

Get or set the ClaudeSaver delegation level (0-5).

**Usage:**
- `/claudesaver:level` — show current level
- `/claudesaver:level 3` — set to level 3 (Aggressive)

If an argument is provided, use `claudesaver_level` with action "set" and the given level number.
If no argument, use `claudesaver_level` with action "get" to show current level.

**Levels:**
- 0: Off — nothing auto-routed
- 1: Conservative — only trivial tasks
- 2: Balanced (default) — simple-to-moderate tasks
- 3: Aggressive — most tasks go local
- 4: Max Local — all tasks attempted locally
- 5: Offline — everything local, no cloud fallback
