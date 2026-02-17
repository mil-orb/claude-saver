---
disable-model-invocation: false
---

# /claudesaver:setup-statusline

Set up the Claude-Saver status line to show delegation level and model at the bottom of the terminal.

## What to do

1. Determine the absolute path to the statusline script. It is at `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.cjs` — if `CLAUDE_PLUGIN_ROOT` is not available, use the path relative to this plugin's installation.

2. Read `~/.claude/settings.json` (create it if it doesn't exist). Add or update the `statusLine` field:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/claude-saver/scripts/statusline.cjs"
  }
}
```

Make sure to preserve all other existing settings in the file.

3. Confirm to the user:
   - "Status line configured. You'll see your delegation level and model at the bottom of the terminal."
   - "Toggle local mode with `/claudesaver:local` — the status line updates automatically."
   - If the file already had a `statusLine` config, mention that the previous config was replaced.
