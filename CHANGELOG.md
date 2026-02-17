# Changelog

All notable changes to ClaudeSaver will be documented in this file.

## [0.1.0] - Unreleased

### Added
- MCP server with `claudesaver_complete`, `claudesaver_models`, `claudesaver_fs`, `claudesaver_fs_preview` tools
- Session-start hook for Ollama health checks
- Subagent-stop hook for metrics logging
- `local-worker` subagent definition
- `smart-delegation` skill
- Slash commands: `/claudesaver:status`, `/claudesaver:level`, `/claudesaver:config`, `/claudesaver:benchmark`
- esbuild pipeline compiling TypeScript to standalone CJS bundles
- Config system with `~/.claudesaver/config.json` and defaults
