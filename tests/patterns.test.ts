import { describe, it, expect } from 'vitest';
import { matchPatterns, STATIC_PATTERNS } from '../src/mcp-server/patterns.js';

describe('Static Pattern Matching (Layer 1)', () => {
  describe('TIER 0 — No LLM needed', () => {
    const tier0Cases = [
      ['list files in the src directory', 'no_llm', 0],
      ['show directory structure', 'no_llm', 0],
      ['what files are in the project', 'no_llm', 0],
      ['show me the tree', 'no_llm', 0],
      ['project structure overview', 'no_llm', 0],
      ['how many lines in this file', 'no_llm', 0],
      ['file size of package.json', 'no_llm', 0],
      ['file exists check for config.ts', 'no_llm', 0],
      ['disk usage of the src folder', 'no_llm', 0],
      ['git status', 'no_llm', 0],
      ['recent commits on main', 'no_llm', 0],
      ['which files changed', 'no_llm', 0],
      ['show imports in this file', 'no_llm', 0],
      ['list functions in router.ts', 'no_llm', 0],
      ['function signatures for the module', 'no_llm', 0],
    ] as const;

    it.each(tier0Cases)('"%s" → route=%s, level=%d', (desc, expectedRoute, expectedLevel) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.rule.route).toBe(expectedRoute);
        expect(result.rule.level).toBe(expectedLevel);
      }
    });
  });

  describe('Level 1 — Micro local model', () => {
    const level1Cases = [
      ['write docstring for this function', 'local', 1],
      ['add jsdoc comments', 'local', 1],
      ['generate a commit message', 'local', 1],
      ['format this code', 'local', 1],
      ['fix indentation', 'local', 1],
      ['sort imports alphabetically', 'local', 1],
      ['write a regex for email validation', 'local', 1],
      ['rename variable foo to bar', 'local', 1],
      ['add type hints to this function', 'local', 1],
      ['changelog entry for the new feature', 'local', 1],
    ] as const;

    it.each(level1Cases)('"%s" → route=%s, level=%d', (desc, expectedRoute, expectedLevel) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.rule.route).toBe(expectedRoute);
        expect(result.rule.level).toBe(expectedLevel);
      }
    });
  });

  describe('Level 2 — Small local model', () => {
    const level2Cases = [
      ['convert json to yaml', 'local', 2],
      ['explain this function to me', 'local', 2],
      ['summarize this file', 'local', 2],
      ['write a unit test for the login function', 'local', 2],
      ['add error handling to this endpoint', 'local', 2],
      ['create interface for UserProfile', 'local', 2],
      ['create a type definition for the config', 'local', 2],
      ['create fixture for the test', 'local', 2],
    ] as const;

    it.each(level2Cases)('"%s" → route=%s, level=%d', (desc, expectedRoute, expectedLevel) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.rule.route).toBe(expectedRoute);
        expect(result.rule.level).toBe(expectedLevel);
      }
    });
  });

  describe('Level 3 — Medium local model', () => {
    const level3Cases = [
      ['create a crud endpoint for users', 'local', 3],
      ['implement function to parse CSV', 'local', 3],
      ['extract function from this long method', 'local', 3],
      ['add logging to the authentication service', 'local', 3],
      ['write a readme for this project', 'local', 3],
      ['create a dockerfile for the app', 'local', 3],
      ['create a github action for CI', 'local', 3],
    ] as const;

    it.each(level3Cases)('"%s" → route=%s, level=%d', (desc, expectedRoute, expectedLevel) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.rule.route).toBe(expectedRoute);
        expect(result.rule.level).toBe(expectedLevel);
      }
    });
  });

  describe('Cloud — Level 5+', () => {
    const cloudCases = [
      ['architect a microservices system', 'cloud_recommended', 5],
      ['security audit of the auth module', 'cloud_recommended', 5],
      ['refactor entire codebase to use new pattern', 'cloud_recommended', 5],
      ['optimize algorithm for graph traversal', 'cloud_recommended', 5],
      ['debug this intermittent failure', 'cloud_recommended', 5],
      ['threat model for the API', 'cloud_recommended', 5],
      ['migrate from Express to Fastify', 'cloud_recommended', 5],
    ] as const;

    it.each(cloudCases)('"%s" → route=%s, level=%d', (desc, expectedRoute, expectedLevel) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.rule.route).toBe(expectedRoute);
        expect(result.rule.level).toBe(expectedLevel);
      }
    });
  });

  describe('No match — falls through', () => {
    const noMatchCases = [
      'what is the meaning of life',
      'tell me a joke',
      'hello world',
      'calculate the fibonacci sequence using dynamic programming',
    ];

    it.each(noMatchCases)('"%s" → no match', (desc) => {
      const result = matchPatterns(desc);
      expect(result.matched).toBe(false);
    });
  });

  it('all patterns have valid fields', () => {
    for (const rule of STATIC_PATTERNS) {
      expect(rule.patterns.length).toBeGreaterThan(0);
      expect(['no_llm', 'local', 'cloud', 'cloud_recommended']).toContain(rule.route);
      expect(rule.level).toBeGreaterThanOrEqual(0);
      expect(rule.level).toBeLessThanOrEqual(6);
      expect(rule.confidence).toBeGreaterThan(0);
      expect(rule.confidence).toBeLessThanOrEqual(1);
      expect(['trivial', 'low', 'medium', 'high', 'critical']).toContain(rule.cost_of_wrong);
    }
  });

  it('case insensitive matching', () => {
    const result1 = matchPatterns('GIT STATUS');
    const result2 = matchPatterns('git status');
    const result3 = matchPatterns('Git Status');
    expect(result1.matched).toBe(true);
    expect(result2.matched).toBe(true);
    expect(result3.matched).toBe(true);
  });
});
