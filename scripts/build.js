import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const entryPoints = [
  { in: 'src/mcp-server/index.ts', out: 'mcp-server' },
  { in: 'src/hooks/session-start.ts', out: 'session-start-hook' },
  { in: 'src/hooks/subagent-stop.ts', out: 'subagent-stop-hook' },
];

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};

// MCP server → .cjs extension
const mcpBuild = {
  ...sharedOptions,
  entryPoints: ['src/mcp-server/index.ts'],
  outfile: 'scripts/mcp-server.cjs',
};

// Hooks → .cjs extension (must be CJS because package.json has "type": "module")
const sessionStartBuild = {
  ...sharedOptions,
  entryPoints: ['src/hooks/session-start.ts'],
  outfile: 'scripts/session-start-hook.cjs',
};

const subagentStopBuild = {
  ...sharedOptions,
  entryPoints: ['src/hooks/subagent-stop.ts'],
  outfile: 'scripts/subagent-stop-hook.cjs',
};

async function build() {
  if (watch) {
    const mcpCtx = await esbuild.context(mcpBuild);
    const hookCtx1 = await esbuild.context(sessionStartBuild);
    const hookCtx2 = await esbuild.context(subagentStopBuild);
    await Promise.all([mcpCtx.watch(), hookCtx1.watch(), hookCtx2.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(mcpBuild),
      esbuild.build(sessionStartBuild),
      esbuild.build(subagentStopBuild),
    ]);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
