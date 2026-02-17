---
disable-model-invocation: false
---

# /claudesaver:dashboard

Open the Claude-Saver metrics dashboard in the browser.

## Instructions

1. Start the dashboard server by running: `node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-server.cjs`
   - Run this in the background (it stays running to serve the page).
   - The server listens on `http://127.0.0.1:37888` by default.
   - If port 37888 is busy, set `CLAUDE_SAVER_DASHBOARD_PORT` to another port.

2. Open the dashboard URL in the user's browser:
   - On macOS: `open http://127.0.0.1:37888`
   - On Windows: `start http://127.0.0.1:37888`
   - On Linux: `xdg-open http://127.0.0.1:37888`

3. Tell the user: "Dashboard is running at http://127.0.0.1:37888 — it auto-refreshes every 10 seconds."

The dashboard shows:
- Net savings (after honest overhead accounting)
- Local token count and efficiency percentage
- Savings over time chart
- Token split between savings and overhead
- Tool usage breakdown
- Recent delegation history with per-call net analysis

To stop the dashboard, the user can close the terminal or press Ctrl+C.
