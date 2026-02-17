import { describe, it, expect } from 'vitest';
import { extractSignals, computeComplexityScore, scoreToLevel } from '../src/mcp-server/signals.js';

describe('Signal Extraction (Layer 2)', () => {
  describe('extractSignals', () => {
    it('detects file references', () => {
      const signals = extractSignals('Update the config in src/config.ts and src/utils.ts');
      expect(signals.files_referenced).toBeGreaterThanOrEqual(2);
    });

    it('infers function scope for single-function tasks', () => {
      const signals = extractSignals('add docstring to this function');
      expect(signals.scope).toBe('function');
    });

    it('infers file scope', () => {
      const signals = extractSignals('refactor this file');
      expect(signals.scope).toBe('file');
    });

    it('infers module scope', () => {
      const signals = extractSignals('update multiple files in the auth module');
      expect(signals.scope).toBe('module');
    });

    it('infers system scope', () => {
      const signals = extractSignals('refactor across the entire codebase');
      expect(signals.scope).toBe('system');
    });

    it('detects tool chain requirements', () => {
      const signals = extractSignals('debug this issue and fix it');
      expect(signals.requires_tool_chain).toBe(true);
    });

    it('detects no tool chain for simple tasks', () => {
      const signals = extractSignals('write a docstring');
      expect(signals.requires_tool_chain).toBe(false);
    });

    it('detects boilerplate novelty', () => {
      const signals = extractSignals('create a boilerplate React component');
      expect(signals.novelty).toBe('boilerplate');
    });

    it('detects known_pattern novelty', () => {
      const signals = extractSignals('create a REST API endpoint');
      expect(signals.novelty).toBe('known_pattern');
    });

    it('detects novel tasks', () => {
      const signals = extractSignals('design a novel algorithm for graph partitioning');
      expect(signals.novelty).toBe('novel');
    });

    it('detects critical cost_of_wrong for security', () => {
      const signals = extractSignals('review the authentication security');
      expect(signals.cost_of_wrong).toBe('critical');
    });

    it('detects trivial cost_of_wrong for docs', () => {
      const signals = extractSignals('add a comment explaining this function');
      expect(signals.cost_of_wrong).toBe('trivial');
    });

    it('detects examples in task', () => {
      const signals = extractSignals('create a function like this example: function add(a, b)');
      expect(signals.has_examples).toBe(true);
    });

    it('detects existing tests', () => {
      const signals = extractSignals('add more cases to the existing test suite');
      expect(signals.has_tests).toBe(true);
    });

    it('detects Python language', () => {
      const signals = extractSignals('write a python decorator for caching');
      expect(signals.language_familiarity).toBe(0.9);
    });

    it('detects TypeScript by extension', () => {
      const signals = extractSignals('update the handler in routes.ts');
      expect(signals.language_familiarity).toBe(0.85);
    });

    it('computes reasoning depth for multi-step tasks', () => {
      const simple = extractSignals('write a docstring');
      const complex = extractSignals('first analyze the code, then refactor it, and finally ensure all tests pass');
      expect(complex.reasoning_depth).toBeGreaterThan(simple.reasoning_depth);
    });

    it('detects data_transform output type', () => {
      const signals = extractSignals('convert this JSON to YAML');
      expect(signals.output_type).toBe('data_transform');
    });

    it('detects analysis output type', () => {
      const signals = extractSignals('explain what this function does');
      expect(signals.output_type).toBe('analysis');
    });

    it('detects code_mod output type', () => {
      const signals = extractSignals('refactor this method to use async/await');
      expect(signals.output_type).toBe('code_mod');
    });
  });

  describe('computeComplexityScore', () => {
    it('returns low score for trivial tasks', () => {
      const signals = extractSignals('write a docstring for this function');
      const score = computeComplexityScore(signals);
      expect(score).toBeLessThan(0.3);
    });

    it('returns high score for complex tasks', () => {
      const signals = extractSignals('architect a new microservices system across the entire codebase with security considerations');
      const score = computeComplexityScore(signals);
      expect(score).toBeGreaterThan(0.5);
    });

    it('score is between 0 and 1', () => {
      const tasks = [
        'add a comment',
        'write a function',
        'refactor the entire codebase with security in mind',
        'implement a novel distributed consensus algorithm',
      ];
      for (const task of tasks) {
        const signals = extractSignals(task);
        const score = computeComplexityScore(signals);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('examples reduce the score', () => {
      const withoutExample = extractSignals('create a utility function');
      const withExample = extractSignals('create a utility function like this example: function add(a, b)');
      const scoreWithout = computeComplexityScore(withoutExample);
      const scoreWith = computeComplexityScore(withExample);
      expect(scoreWith).toBeLessThan(scoreWithout);
    });
  });

  describe('scoreToLevel', () => {
    it('maps low scores to Level 1', () => {
      expect(scoreToLevel(0.0)).toBe(1);
      expect(scoreToLevel(0.10)).toBe(1);
    });

    it('maps medium-low scores to Level 2', () => {
      expect(scoreToLevel(0.20)).toBe(2);
    });

    it('maps medium scores to Level 3', () => {
      expect(scoreToLevel(0.35)).toBe(3);
    });

    it('maps ambiguous zone to Level 4', () => {
      expect(scoreToLevel(0.55)).toBe(4);
    });

    it('maps high scores to Level 5', () => {
      expect(scoreToLevel(0.70)).toBe(5);
    });

    it('maps very high scores to Level 6', () => {
      expect(scoreToLevel(0.85)).toBe(6);
    });
  });
});
