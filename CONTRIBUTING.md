# Contributing to Claude-Saver

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/mil-orb/claude-saver.git
cd claude-saver
npm install
npm run build
npm test
```

## Workflow

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure `npx tsc --noEmit` passes (no type errors)
4. Ensure `npm test` passes (all tests green)
5. Ensure `npm run build` succeeds (bundles compile)
6. Open a pull request

## Code Style

- TypeScript strict mode
- No runtime dependencies (everything bundled by esbuild)
- Tests use vitest
- Source in `src/`, compiled output in `scripts/`

## Testing

Run the full suite:
```bash
npm test
```

Run in watch mode:
```bash
npm run test:watch
```

## Architecture

- `src/mcp-server/` — MCP server tools and classification engine
- `src/hooks/` — SessionStart and SubagentStop lifecycle hooks
- `tests/` — Unit, integration, and simulation tests
- `scripts/` — Compiled CJS bundles (committed for plugin install)

## Reporting Issues

Use the [issue templates](https://github.com/mil-orb/claude-saver/issues/new/choose) for bugs and feature requests.
