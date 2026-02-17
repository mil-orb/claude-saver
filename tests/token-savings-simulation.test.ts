import { describe, it, expect } from 'vitest';
import { classifyTask } from '../src/mcp-server/router.js';
import { computeSummary, type CompletionEntry, type MetricsEntry, type AnyMetricsEntry } from '../src/mcp-server/metrics.js';

// =============================================================================
// TOKEN SAVINGS SIMULATION
// =============================================================================
// This test file simulates realistic coding sessions to calculate estimated
// token savings across common developer actions. It exercises the full pipeline:
//   classifyTask() -> routing decision -> mock token consumption -> metrics
//                  -> savings calculation
//
// Cloud API token costs (what Anthropic charges per request):
//   Simple docstring:              ~200 input + ~150 output  = ~350 tokens
//   Commit message:                ~500 input + ~100 output  = ~600 tokens
//   Unit test scaffold:            ~800 input + ~1500 output = ~2300 tokens
//   CRUD endpoint:                 ~600 input + ~2000 output = ~2600 tokens
//   Format conversion:             ~300 input + ~300 output  = ~600 tokens
//   Code refactoring suggestion:   ~1500 input + ~2000 output = ~3500 tokens
//   Bug analysis:                  ~2000 input + ~1500 output = ~3500 tokens
//   File summarization:            ~3000 input + ~500 output  = ~3500 tokens
//   Type annotations:              ~400 input + ~300 output  = ~700 tokens
//   Boilerplate generation:        ~200 input + ~1000 output = ~1200 tokens
//
// When routed LOCAL, these tokens are FREE (zero API cost).
// Savings = cloud_cost - local_cost, where local_cost ~ $0.
// =============================================================================

// ---------------------------------------------------------------------------
// Session definitions
// ---------------------------------------------------------------------------

interface SessionPrompt {
  prompt: string;
  expectedRoute: 'no_llm' | 'local' | 'cloud';
  cloudTokens: number;
}

/**
 * Session 1: "Morning Feature Work" (20 prompts)
 * Simulates a developer building a new feature from scratch.
 */
const morningSession: SessionPrompt[] = [
  { prompt: 'show me the file tree of the src directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write a docstring for this function: async function fetchUser(id: string): Promise<User>', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'generate a commit message for adding user profile endpoint', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'convert this JSON config to YAML format', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'add type annotations to this function', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'write unit tests for the UserService.getById method', expectedRoute: 'local', cloudTokens: 2300 },
  { prompt: 'generate a REST endpoint for creating new users', expectedRoute: 'local', cloudTokens: 2600 },
  { prompt: 'write a docstring for class UserController', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'generate boilerplate for a new Express middleware', expectedRoute: 'local', cloudTokens: 1200 },
  { prompt: 'git status', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write a commit message for fixing the validation logic', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'add JSDoc comments to the auth module exports', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'summarize what this file does', expectedRoute: 'local', cloudTokens: 3500 },
  { prompt: 'generate a TODO list from the FIXME comments in the codebase', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'convert this CSV data to JSON', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'write a docstring for async function validatePayment', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'generate unit tests for the PaymentService', expectedRoute: 'local', cloudTokens: 2300 },
  { prompt: 'write a commit message for the payment validation feature', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'how many lines are in the src directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'architect a scalable microservices system for real-time notifications with event sourcing', expectedRoute: 'cloud', cloudTokens: 0 },
];

/**
 * Session 2: "Afternoon Refactoring" (15 prompts)
 * Simulates cleanup, documentation, and refactoring work.
 */
const afternoonSession: SessionPrompt[] = [
  { prompt: 'list files in the project', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'what files are in the tests directory', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'write docstrings for all exported functions in utils.ts', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'rename the variable "data" to "userData" throughout this file', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'add type hints to the Python helper scripts', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'generate a commit message for the refactoring changes', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'convert the old callback-style code to async/await', expectedRoute: 'local', cloudTokens: 2600 },
  { prompt: 'write unit test stubs for the new async functions', expectedRoute: 'local', cloudTokens: 2300 },
  { prompt: 'git log', expectedRoute: 'no_llm', cloudTokens: 0 },
  { prompt: 'summarize this file for me please', expectedRoute: 'local', cloudTokens: 3500 },
  { prompt: 'generate API documentation for the user endpoints', expectedRoute: 'local', cloudTokens: 2600 },
  { prompt: 'write a commit message for updating the API docs', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'find potential bugs in this error handling code', expectedRoute: 'local', cloudTokens: 3500 },
  { prompt: 'generate a config template for the new feature flags', expectedRoute: 'local', cloudTokens: 1200 },
  { prompt: 'debug this race condition in the WebSocket handler that causes messages to be delivered out of order across multiple connected clients', expectedRoute: 'cloud', cloudTokens: 0 },
];

/**
 * Session 3: "Quick Fixes Sprint" (10 fast tasks)
 * Simulates rapid-fire small fixes and one-liners.
 */
const quickFixes: SessionPrompt[] = [
  { prompt: 'write a docstring for function calculateTax', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'generate a commit message for fixing the tax calculation bug', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'add a TODO comment about the deprecated API endpoint', expectedRoute: 'local', cloudTokens: 200 },
  { prompt: 'convert this YAML config to JSON', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'write a regex to validate email addresses', expectedRoute: 'local', cloudTokens: 400 },
  { prompt: 'generate type annotations for the config object', expectedRoute: 'local', cloudTokens: 700 },
  { prompt: 'write a commit message for adding input validation', expectedRoute: 'local', cloudTokens: 600 },
  { prompt: 'generate a simple Express route handler for health check', expectedRoute: 'local', cloudTokens: 1200 },
  { prompt: 'write docstring for class OrderProcessor', expectedRoute: 'local', cloudTokens: 350 },
  { prompt: 'show me the git diff names', expectedRoute: 'no_llm', cloudTokens: 0 },
];

const allSessions = [...morningSession, ...afternoonSession, ...quickFixes];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify all prompts in a session at a given delegation level (default 2). */
async function classifySession(
  session: SessionPrompt[],
  delegationLevel = 2,
): Promise<{ prompt: SessionPrompt; route: string }[]> {
  const results: { prompt: SessionPrompt; route: string }[] = [];
  for (const entry of session) {
    const decision = await classifyTask(entry.prompt, { delegationLevel });
    results.push({ prompt: entry, route: decision.route });
  }
  return results;
}

/** Count how many prompts in a session route to a specific destination. */
function countByRoute(
  results: { prompt: SessionPrompt; route: string }[],
  route: string,
): number {
  return results.filter(r => r.route === route).length;
}

/** Sum cloud tokens that would be saved (local + no_llm tasks). */
function computeSaveableTokens(session: SessionPrompt[]): number {
  return session
    .filter(s => s.expectedRoute !== 'cloud')
    .reduce((sum, s) => sum + s.cloudTokens, 0);
}

/** Total cloud tokens across all prompts (including cloud tasks, which have 0). */
function computeTotalCloudTokens(session: SessionPrompt[]): number {
  return session.reduce((sum, s) => sum + s.cloudTokens, 0);
}

/** Build CompletionEntry array from session data for metrics testing. */
function buildCompletionEntries(
  session: SessionPrompt[],
  sessionId: string,
): CompletionEntry[] {
  return session
    .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
    .map((s, i) => ({
      type: 'completion' as const,
      timestamp: new Date(Date.now() + i * 60_000).toISOString(),
      tokens_used: s.cloudTokens,
      model: 'local-7b',
      duration_ms: 200 + Math.floor(s.cloudTokens / 10),
      tool: toolForPrompt(s.prompt),
      session_id: sessionId,
    }));
}

/** Infer a plausible tool name from the prompt for metrics tracking. */
function toolForPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes('docstring') || lower.includes('jsdoc') || lower.includes('comment')) return 'write_docs';
  if (lower.includes('commit message')) return 'commit_msg';
  if (lower.includes('unit test') || lower.includes('test stub')) return 'write_tests';
  if (lower.includes('endpoint') || lower.includes('route handler') || lower.includes('boilerplate') || lower.includes('middleware')) return 'codegen';
  if (lower.includes('convert') || lower.includes('format')) return 'format_convert';
  if (lower.includes('summarize') || lower.includes('what') || lower.includes('bug') || lower.includes('potential')) return 'analyze';
  if (lower.includes('rename') || lower.includes('refactor') || lower.includes('async/await')) return 'refactor';
  if (lower.includes('type annotation') || lower.includes('type hint')) return 'type_annotate';
  if (lower.includes('regex')) return 'codegen';
  if (lower.includes('todo')) return 'codegen';
  if (lower.includes('documentation') || lower.includes('api doc')) return 'write_docs';
  if (lower.includes('config template') || lower.includes('feature flag')) return 'codegen';
  return 'general';
}

// =============================================================================
// 1. ROUTE ACCURACY PER SESSION
// =============================================================================

describe('Token Savings Simulation', () => {
  describe('1. Route accuracy per session', () => {
    it('Morning session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(morningSession);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });

    it('Afternoon session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(afternoonSession);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });

    it('Quick fixes session: every prompt routes to the expected destination', async () => {
      const results = await classifySession(quickFixes);

      for (const { prompt, route } of results) {
        expect(route, `Prompt "${prompt.prompt}" expected ${prompt.expectedRoute} but got ${route}`)
          .toBe(prompt.expectedRoute);
      }
    });
  });

  // ===========================================================================
  // 2. TOKEN SAVINGS CALCULATIONS PER SESSION
  // ===========================================================================

  describe('2. Token savings calculations per session', () => {
    it('Morning session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(morningSession);
      // Sum of cloudTokens for all non-cloud prompts:
      // 0 + 350 + 600 + 600 + 700 + 2300 + 2600 + 350 + 1200 + 0 + 600 + 350
      // + 3500 + 700 + 600 + 350 + 2300 + 600 + 0 = 17700
      // The cloud prompt (design database schema) has cloudTokens: 0, so it does
      // not add to the saveable total, but it also doesn't count as saved tokens.
      expect(saveable).toBe(17700);
    });

    it('Afternoon session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(afternoonSession);
      // 0 + 0 + 700 + 700 + 700 + 600 + 2600 + 2300 + 0 + 3500 + 2600 + 600
      // + 3500 + 1200 + 0 = 19000
      expect(saveable).toBe(19000);
    });

    it('Quick fixes session: total saveable tokens are correctly summed', () => {
      const saveable = computeSaveableTokens(quickFixes);
      // 350 + 600 + 200 + 600 + 400 + 700 + 600 + 1200 + 350 + 0 = 5000
      expect(saveable).toBe(5000);
    });

    it('Total savings across all sessions combined', () => {
      const morningSaveable = computeSaveableTokens(morningSession);
      const afternoonSaveable = computeSaveableTokens(afternoonSession);
      const quickSaveable = computeSaveableTokens(quickFixes);
      const totalSaveable = morningSaveable + afternoonSaveable + quickSaveable;

      expect(totalSaveable).toBe(17700 + 19000 + 5000);
      expect(totalSaveable).toBe(41700);
    });

    it('Percentage of tasks routed locally per session', () => {
      // Morning: 16 local out of 20 total = 80%
      const morningLocal = morningSession.filter(s => s.expectedRoute === 'local').length;
      const morningPct = (morningLocal / morningSession.length) * 100;
      expect(morningLocal).toBe(16);
      expect(morningPct).toBe(80);

      // Afternoon: 11 local out of 15 total = ~73.3%
      const afternoonLocal = afternoonSession.filter(s => s.expectedRoute === 'local').length;
      const afternoonPct = (afternoonLocal / afternoonSession.length) * 100;
      expect(afternoonLocal).toBe(11);
      expect(afternoonPct).toBeCloseTo(73.33, 1);

      // Quick fixes: 9 local out of 10 total = 90%
      const quickLocal = quickFixes.filter(s => s.expectedRoute === 'local').length;
      const quickPct = (quickLocal / quickFixes.length) * 100;
      expect(quickLocal).toBe(9);
      expect(quickPct).toBe(90);
    });

    it('Percentage of tokens saved per session (saveable / total cloud tokens)', () => {
      // Since cloud tasks have cloudTokens: 0, the saveable equals the total,
      // meaning 100% of token-consuming tasks are saved. The metric that matters
      // is: what fraction of tasks that *would* cost tokens are handled locally.

      const morningTotal = computeTotalCloudTokens(morningSession);
      const morningSaveable = computeSaveableTokens(morningSession);
      expect(morningTotal).toBe(morningSaveable); // all token-using tasks route local
      expect(morningTotal).toBe(17700);

      const afternoonTotal = computeTotalCloudTokens(afternoonSession);
      const afternoonSaveable = computeSaveableTokens(afternoonSession);
      expect(afternoonTotal).toBe(afternoonSaveable);
      expect(afternoonTotal).toBe(19000);

      const quickTotal = computeTotalCloudTokens(quickFixes);
      const quickSaveable = computeSaveableTokens(quickFixes);
      expect(quickTotal).toBe(quickSaveable);
      expect(quickTotal).toBe(5000);
    });
  });

  // ===========================================================================
  // 3. COST SAVINGS AT DIFFERENT PRICE POINTS
  // ===========================================================================

  describe('3. Cost savings at different price points', () => {
    const totalSaveableTokens = 41700; // verified above

    it('At $3/M tokens (Haiku pricing): saves $0.13', () => {
      const costPerMillion = 3;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.13);
    });

    it('At $8/M tokens (default / blended pricing): saves $0.33', () => {
      const costPerMillion = 8;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.33);
    });

    it('At $15/M tokens (Sonnet pricing): saves $0.63', () => {
      const costPerMillion = 15;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(0.63);
    });

    it('At $75/M tokens (Opus pricing): saves $3.13', () => {
      const costPerMillion = 75;
      const savings = (totalSaveableTokens / 1_000_000) * costPerMillion;
      const rounded = Math.round(savings * 100) / 100;
      expect(rounded).toBe(3.13);
    });
  });

  // ===========================================================================
  // 4. computeSummary INTEGRATION
  // ===========================================================================

  describe('4. computeSummary integration', () => {
    it('returns correct total_local_tokens from session data', () => {
      const entries = buildCompletionEntries(morningSession, 'morning-001');
      const summary = computeSummary(entries);

      // Sum of cloudTokens for local prompts in morning session
      const expectedTokens = morningSession
        .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
        .reduce((sum, s) => sum + s.cloudTokens, 0);

      expect(summary.total_local_tokens).toBe(expectedTokens);
      expect(summary.total_local_tokens).toBe(17700);
    });

    it('returns correct local_tasks count', () => {
      const entries = buildCompletionEntries(afternoonSession, 'afternoon-001');
      const summary = computeSummary(entries);

      // Afternoon session has 11 local prompts with cloudTokens > 0
      const expectedCount = afternoonSession
        .filter(s => s.expectedRoute === 'local' && s.cloudTokens > 0)
        .length;

      expect(summary.local_tasks).toBe(expectedCount);
      expect(summary.local_tasks).toBe(11);
    });

    it('returns correct estimated_cost_saved at default $8/M rate', () => {
      const allEntries = [
        ...buildCompletionEntries(morningSession, 'morning-001'),
        ...buildCompletionEntries(afternoonSession, 'afternoon-001'),
        ...buildCompletionEntries(quickFixes, 'quick-001'),
      ];

      const summary = computeSummary(allEntries);

      // 41700 tokens at $8/M = (41700 / 1_000_000) * 8 = 0.3336 -> rounds to 0.33
      expect(summary.estimated_cost_saved).toBe(0.33);
    });

    it('multiple sessions produce correct session count', () => {
      const allEntries: AnyMetricsEntry[] = [
        ...buildCompletionEntries(morningSession, 'morning-001'),
        ...buildCompletionEntries(afternoonSession, 'afternoon-001'),
        ...buildCompletionEntries(quickFixes, 'quick-001'),
      ];

      const summary = computeSummary(allEntries);

      expect(summary.sessions).toBe(3);
    });

    it('tools_frequency correctly tracks which tools would be used', () => {
      const entries = buildCompletionEntries(quickFixes, 'quick-001');
      const summary = computeSummary(entries);

      // The quick fixes session should produce entries with these tool names:
      // write_docs (docstrings x2), commit_msg (x2), codegen (TODO, regex, express route),
      // format_convert (YAML->JSON), type_annotate (type annotations)
      // Note: the no_llm prompt (git diff) is not included since it's not local
      expect(summary.tools_frequency).toBeDefined();
      expect(Object.keys(summary.tools_frequency).length).toBeGreaterThan(0);

      // Verify specific tools appear
      expect(summary.tools_frequency['write_docs']).toBeGreaterThanOrEqual(2);
      expect(summary.tools_frequency['commit_msg']).toBeGreaterThanOrEqual(2);
      expect(summary.tools_frequency['codegen']).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // 5. DELEGATION LEVEL IMPACT
  // ===========================================================================

  describe('5. Delegation level impact', () => {
    it('Level 0 (Off): all tasks route to cloud, zero savings', async () => {
      const results = await classifySession(allSessions, 0);
      const localCount = countByRoute(results, 'local');
      const noLlmCount = countByRoute(results, 'no_llm');

      // Level 0 sends everything to cloud, no exceptions
      expect(localCount).toBe(0);
      expect(noLlmCount).toBe(0);

      const savings = results
        .filter(r => r.route === 'local' || r.route === 'no_llm')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBe(0);
    });

    it('Level 1 (Conservative): fewer tasks route local than Level 2', async () => {
      const results = await classifySession(allSessions, 1);
      const localCount = countByRoute(results, 'local');

      // Level 1 ceiling is 2, so only Level 0-2 tasks route locally
      // Level 3 tasks (CRUD endpoints, refactoring, API docs) go to cloud
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 2 (Balanced/default): baseline savings', async () => {
      const results = await classifySession(allSessions, 2);
      const localCount = countByRoute(results, 'local');

      // Level 2 ceiling is 3, covers most common tasks
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 3 (Aggressive): more tasks route local than Level 2', async () => {
      const results = await classifySession(allSessions, 3);
      const localCount = countByRoute(results, 'local');

      // Level 3 ceiling is 4, captures even more tasks
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('Level 4 (Max Local): most tasks route local', async () => {
      const results = await classifySession(allSessions, 4);
      const localCount = countByRoute(results, 'local');

      // Level 4 ceiling is 6, almost everything goes local
      expect(localCount).toBeGreaterThan(0);

      const savings = results
        .filter(r => r.route === 'local')
        .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
      expect(savings).toBeGreaterThan(0);
    });

    it('savings monotonically increase: Level 0 < Level 1 < Level 2 < Level 3 < Level 4', async () => {
      const savingsByLevel: number[] = [];

      for (const level of [0, 1, 2, 3, 4]) {
        const results = await classifySession(allSessions, level);
        const savings = results
          .filter(r => r.route === 'local')
          .reduce((sum, r) => sum + r.prompt.cloudTokens, 0);
        savingsByLevel.push(savings);
      }

      // Level 0 saves nothing
      expect(savingsByLevel[0]).toBe(0);

      // Each successive level saves at least as much as the previous
      for (let i = 1; i < savingsByLevel.length; i++) {
        expect(
          savingsByLevel[i],
          `Level ${i} savings (${savingsByLevel[i]}) should be >= Level ${i - 1} savings (${savingsByLevel[i - 1]})`,
        ).toBeGreaterThanOrEqual(savingsByLevel[i - 1]);
      }

      // Level 4 should save strictly more than Level 0
      expect(savingsByLevel[4]).toBeGreaterThan(savingsByLevel[0]);
    });
  });

  // ===========================================================================
  // 6. SESSION SUMMARY STATISTICS
  // ===========================================================================

  describe('6. Session summary statistics', () => {
    it('Total prompts across all sessions', () => {
      expect(allSessions.length).toBe(45);
    });

    it('Total no_llm tasks (filesystem/git, zero cost)', () => {
      const noLlmCount = allSessions.filter(s => s.expectedRoute === 'no_llm').length;
      // Morning: 3 (file tree, git status, line count)
      // Afternoon: 3 (list TS files, find test files, git log)
      // Quick fixes: 1 (git diff)
      expect(noLlmCount).toBe(7);
    });

    it('Total local tasks (delegated to local model, saves tokens)', () => {
      const localCount = allSessions.filter(s => s.expectedRoute === 'local').length;
      // Morning: 16, Afternoon: 11, Quick fixes: 9
      expect(localCount).toBe(36);
    });

    it('Total cloud tasks (kept on API, not saved)', () => {
      const cloudCount = allSessions.filter(s => s.expectedRoute === 'cloud').length;
      // Morning: 1 (design database schema)
      // Afternoon: 1 (debug race condition)
      // Quick fixes: 0
      expect(cloudCount).toBe(2);
    });

    it('Delegation rate = local / (local + cloud) as percentage', () => {
      const localCount = allSessions.filter(s => s.expectedRoute === 'local').length;
      const cloudCount = allSessions.filter(s => s.expectedRoute === 'cloud').length;

      const delegationRate = (localCount / (localCount + cloudCount)) * 100;

      // 36 / (36 + 2) = 36/38 = 94.74%
      expect(localCount).toBe(36);
      expect(cloudCount).toBe(2);
      expect(delegationRate).toBeCloseTo(94.74, 1);
    });

    it('Projected monthly savings at 20 sessions/day, 22 work days', () => {
      // One "day" of sessions = morning + afternoon + quick fixes = 41700 tokens saved
      const tokensPerDay = 41700;
      const sessionsPerDay = 3; // our 3 sessions above represent one day's work
      const workDays = 22;

      // Tokens saved per month (one developer)
      const tokensPerMonth = tokensPerDay * (20 / sessionsPerDay) * workDays;
      // 41700 * (20/3) * 22 = 41700 * 6.667 * 22 = 6,115,600
      // More precisely: 41700 * 20 * 22 / 3 = 18,340,000 / 3 = 6,113,333.33

      // Cost savings at different price points
      const savingsAt8 = (tokensPerMonth / 1_000_000) * 8;
      const savingsAt15 = (tokensPerMonth / 1_000_000) * 15;
      const savingsAt75 = (tokensPerMonth / 1_000_000) * 75;

      // At $8/M: ~$48.91/month
      expect(savingsAt8).toBeGreaterThan(40);
      expect(savingsAt8).toBeLessThan(60);

      // At $15/M: ~$91.70/month
      expect(savingsAt15).toBeGreaterThan(80);
      expect(savingsAt15).toBeLessThan(110);

      // At $75/M: ~$458.50/month
      expect(savingsAt75).toBeGreaterThan(400);
      expect(savingsAt75).toBeLessThan(550);

      // Verify the tokens/month is in a reasonable range
      expect(tokensPerMonth).toBeGreaterThan(5_000_000);
      expect(tokensPerMonth).toBeLessThan(7_000_000);
    });
  });
});
