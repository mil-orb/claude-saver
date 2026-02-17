import * as esbuild from 'esbuild';

import * as fs from 'fs';
import * as path from 'path';

const watch = process.argv.includes('--watch');

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

const promptSubmitBuild = {
  ...sharedOptions,
  entryPoints: ['src/hooks/prompt-submit.ts'],
  outfile: 'scripts/prompt-submit-hook.cjs',
};

const dashboardBuild = {
  ...sharedOptions,
  entryPoints: ['src/dashboard/server.ts'],
  outfile: 'scripts/dashboard-server.cjs',
};

async function copyDashboardHTML() {
  const src = path.resolve('src/dashboard/dashboard.html');
  const dest = path.resolve('scripts/dashboard.html');
  fs.copyFileSync(src, dest);
}

async function build() {
  if (watch) {
    const mcpCtx = await esbuild.context(mcpBuild);
    const hookCtx1 = await esbuild.context(sessionStartBuild);
    const hookCtx2 = await esbuild.context(subagentStopBuild);
    const dashCtx = await esbuild.context(dashboardBuild);
    const promptCtx = await esbuild.context(promptSubmitBuild);
    await Promise.all([mcpCtx.watch(), hookCtx1.watch(), hookCtx2.watch(), dashCtx.watch(), promptCtx.watch()]);
    await copyDashboardHTML();
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(mcpBuild),
      esbuild.build(sessionStartBuild),
      esbuild.build(subagentStopBuild),
      esbuild.build(dashboardBuild),
      esbuild.build(promptSubmitBuild),
    ]);
    await copyDashboardHTML();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
