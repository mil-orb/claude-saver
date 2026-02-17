import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fingerprint, getRecommendation, type HistoricalRecord } from '../src/mcp-server/learner.js';

vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    delegation_level: 2,
    ollama: { base_url: '', default_model: '', fallback_model: null, timeout_ms: 0, health_timeout_ms: 0 },
    routing: { use_local_triage: false, use_historical_learning: true, enable_decomposition: false, triage_model: null },
    specialist_models: {},
    metrics: { enabled: false, log_path: '' },
  })),
}));

// Mock fs to avoid real file I/O
vi.mock('fs', async () => {
  let historyData = '';
  return {
    existsSync: vi.fn(() => historyData.length > 0),
    readFileSync: vi.fn(() => historyData),
    appendFileSync: vi.fn((_, content: string) => { historyData += content; }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    __setHistory: (data: string) => { historyData = data; },
  };
});

describe('Learner (Layer 5)', () => {
  beforeEach(async () => {
    const fsMock = await import('fs');
    (fsMock as unknown as { __setHistory: (d: string) => void }).__setHistory('');
  });

  describe('fingerprint', () => {
    it('produces consistent output', () => {
      const fp1 = fingerprint('write a docstring');
      const fp2 = fingerprint('write a docstring');
      expect(fp1).toBe(fp2);
    });

    it('normalizes case', () => {
      const fp1 = fingerprint('Write A Docstring');
      const fp2 = fingerprint('write a docstring');
      expect(fp1).toBe(fp2);
    });

    it('normalizes word order', () => {
      const fp1 = fingerprint('write a docstring for function');
      const fp2 = fingerprint('function docstring for write a');
      expect(fp1).toBe(fp2);
    });

    it('produces different fingerprints for different tasks', () => {
      const fp1 = fingerprint('write a docstring');
      const fp2 = fingerprint('debug the authentication system');
      expect(fp1).not.toBe(fp2);
    });
  });

  describe('getRecommendation', () => {
    it('returns no adjustment with insufficient data', () => {
      const rec = getRecommendation('codegen', 2);
      expect(rec.confidence_adjustment).toBe(0);
      expect(rec.reason).toContain('Insufficient');
    });

    it('returns no adjustment when learning is disabled', async () => {
      const { loadConfig } = await import('../src/mcp-server/config.js');
      vi.mocked(loadConfig).mockReturnValueOnce({
        delegation_level: 2,
        ollama: { base_url: '', default_model: '', fallback_model: null, timeout_ms: 0, health_timeout_ms: 0 },
        routing: { use_local_triage: false, use_historical_learning: false, enable_decomposition: false, triage_model: null },
        specialist_models: {},
        metrics: { enabled: false, log_path: '' },
      });

      const rec = getRecommendation('codegen', 2);
      expect(rec.confidence_adjustment).toBe(0);
      expect(rec.reason).toContain('disabled');
    });

    it('provides recommendation with sufficient history', async () => {
      // Build 60 records with task_type=codegen at level 2 with 90% success
      const records: HistoricalRecord[] = [];
      for (let i = 0; i < 54; i++) {
        records.push({
          task_fingerprint: `fp${i}`, task_type: 'codegen', level_used: 2,
          outcome: 'success', timestamp: new Date().toISOString(),
        });
      }
      for (let i = 0; i < 6; i++) {
        records.push({
          task_fingerprint: `fp_fail${i}`, task_type: 'codegen', level_used: 2,
          outcome: 'escalated', timestamp: new Date().toISOString(),
        });
      }

      const fsMock = await import('fs');
      (fsMock as unknown as { __setHistory: (d: string) => void }).__setHistory(
        records.map(r => JSON.stringify(r)).join('\n') + '\n'
      );

      const rec = getRecommendation('codegen', 2);
      expect(rec.sample_size).toBe(60);
      expect(rec.confidence_adjustment).toBeGreaterThan(0);
      expect(rec.adjusted_level).toBe(1); // High success rate suggests lower level
    });
  });
});
