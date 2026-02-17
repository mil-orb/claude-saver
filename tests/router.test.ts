import { describe, it, expect } from 'vitest';
import { classifyTask, LEVEL_CONFIGS } from '../src/mcp-server/router.js';

describe('Router', () => {
  describe('Level Gate', () => {
    it('Level 0 always returns cloud', async () => {
      const result = await classifyTask('write docstring', { delegationLevel: 0 });
      expect(result.route).toBe('cloud');
      expect(result.delegation_level).toBe(0);
      expect(result.classification_layer).toBe('level_gate');
      expect(result.escalation_policy).toBe('none');
    });

    it('Level 5 always returns local', async () => {
      const result = await classifyTask('architect a microservices system', { delegationLevel: 5 });
      expect(result.route).toBe('local');
      expect(result.delegation_level).toBe(5);
      expect(result.classification_layer).toBe('level_gate');
      expect(result.escalation_policy).toBe('never');
    });
  });

  describe('Level 1 — Conservative', () => {
    it('routes Level 1 tasks locally', async () => {
      const result = await classifyTask('write docstring for this function', { delegationLevel: 1 });
      expect(result.route).toBe('local');
      expect(result.task_complexity).toBe(1);
    });

    it('routes Level 0 tasks as no_llm', async () => {
      const result = await classifyTask('git status', { delegationLevel: 1 });
      expect(result.route).toBe('no_llm');
    });

    it('routes Level 3 tasks to cloud (exceeds ceiling 2)', async () => {
      const result = await classifyTask('create a crud endpoint', { delegationLevel: 1 });
      expect(result.route).toBe('cloud');
      expect(result.reason).toContain('exceeds ceiling');
    });

    it('routes Level 5 tasks to cloud', async () => {
      const result = await classifyTask('security audit of the auth module', { delegationLevel: 1 });
      expect(result.route).toBe('cloud');
    });
  });

  describe('Level 2 — Balanced (default)', () => {
    it('routes Level 2 tasks locally', async () => {
      const result = await classifyTask('convert json to yaml', { delegationLevel: 2 });
      expect(result.route).toBe('local');
      expect(result.task_complexity).toBe(2);
    });

    it('routes Level 3 tasks locally (ceiling is 3)', async () => {
      const result = await classifyTask('implement function to parse CSV', { delegationLevel: 2 });
      expect(result.route).toBe('local');
    });

    it('routes Level 5 tasks to cloud', async () => {
      const result = await classifyTask('debug this intermittent failure', { delegationLevel: 2 });
      expect(result.route).toBe('cloud');
    });
  });

  describe('Level 3 — Aggressive', () => {
    it('routes Level 3 tasks locally', async () => {
      const result = await classifyTask('create a crud endpoint', { delegationLevel: 3 });
      expect(result.route).toBe('local');
    });

    it('routes Level 5 cloud-recommended tasks to cloud (exceeds ceiling 4)', async () => {
      const result = await classifyTask('security audit of the auth module', { delegationLevel: 3 });
      expect(result.route).toBe('cloud');
    });
  });

  describe('Level 4 — Max Local', () => {
    it('routes Level 5 cloud-recommended tasks to cloud (ceiling 6)', async () => {
      // Level 4 has ceiling 6 but cloud_recommended level 5 still exceeds nothing at ceiling 6
      const result = await classifyTask('architect a microservices system', { delegationLevel: 4 });
      // At level 4, ceiling=6, pattern level=5, 5 <= 6 so it should route local
      // But the route is cloud_recommended which maps to cloud
      expect(result.route).toBe('cloud');
    });
  });

  describe('LEVEL_CONFIGS table', () => {
    it('has all 6 levels defined', () => {
      for (let i = 0; i <= 5; i++) {
        expect(LEVEL_CONFIGS[i]).toBeDefined();
      }
    });

    it('Level 0 has ceiling -1', () => {
      expect(LEVEL_CONFIGS[0].ceiling).toBe(-1);
    });

    it('ceilings increase with level', () => {
      expect(LEVEL_CONFIGS[1].ceiling).toBeLessThan(LEVEL_CONFIGS[2].ceiling);
      expect(LEVEL_CONFIGS[2].ceiling).toBeLessThanOrEqual(LEVEL_CONFIGS[3].ceiling);
    });

    it('Level 3+ has tryLocalFirst', () => {
      expect(LEVEL_CONFIGS[3].tryLocalFirst).toBe(true);
      expect(LEVEL_CONFIGS[4].tryLocalFirst).toBe(true);
      expect(LEVEL_CONFIGS[5].tryLocalFirst).toBe(true);
    });

    it('Level 1-2 does not have tryLocalFirst', () => {
      expect(LEVEL_CONFIGS[1].tryLocalFirst).toBe(false);
      expect(LEVEL_CONFIGS[2].tryLocalFirst).toBe(false);
    });
  });

  describe('Specialist key propagation', () => {
    it('includes specialist_key from pattern match', async () => {
      const result = await classifyTask('write docstring for this function', { delegationLevel: 2 });
      expect(result.specialist_key).toBeDefined();
    });
  });

  describe('Escalation policy by level', () => {
    it('Level 1 has immediate escalation', async () => {
      const result = await classifyTask('write docstring', { delegationLevel: 1 });
      expect(result.escalation_policy).toBe('immediate');
    });

    it('Level 2 has standard escalation', async () => {
      const result = await classifyTask('write docstring', { delegationLevel: 2 });
      expect(result.escalation_policy).toBe('standard');
    });

    it('Level 3 has tolerant escalation', async () => {
      const result = await classifyTask('write docstring', { delegationLevel: 3 });
      expect(result.escalation_policy).toBe('tolerant');
    });
  });
});
