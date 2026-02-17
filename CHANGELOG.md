# Changelog

All notable changes to Claude-Saver will be documented in this file.

## [0.1.0] - Unreleased

### Added
- MCP server with `claudesaver_complete`, `claudesaver_models`, `claudesaver_fs`, `claudesaver_fs_preview` tools
- Session-start hook for Ollama health checks
- Subagent-stop hook for metrics logging
- `local-worker` subagent definition
- `smart-delegation` skill
- Slash commands: `/claudesaver:ask`, `/claudesaver:settings`, `/claudesaver:dashboard`
- esbuild pipeline compiling TypeScript to standalone CJS bundles
- Config system with `~/.claude-saver/config.json` and defaults
