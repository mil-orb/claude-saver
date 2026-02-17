import { describe, it, expect, vi } from 'vitest';
import { decomposeTask } from '../src/mcp-server/decomposer.js';

vi.mock('../src/mcp-server/health.js', () => ({
  ollamaChat: vi.fn(),
}));

vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    delegation_level: 2,
    ollama: { base_url: '', default_model: 'qwen3:8b', fallback_model: null, timeout_ms: 30000, health_timeout_ms: 3000 },
    routing: { use_local_triage: false, use_historical_learning: false, enable_decomposition: true, triage_model: null },
    specialist_models: {},
    metrics: { enabled: false, log_path: '' },
  })),
}));

describe('Decomposer', () => {
  it('decomposes a complex task into subtasks', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: JSON.stringify({
        subtasks: [
          { id: '1', description: 'Create User model', level: 2, depends_on: [] },
          { id: '2', description: 'Create user API routes', level: 3, depends_on: ['1'] },
          { id: '3', description: 'Write unit tests', level: 2, depends_on: ['1', '2'] },
        ],
      }),
      model: 'qwen3:8b',
      tokens_used: 200,
      duration_ms: 1000,
    });

    const result = await decomposeTask('Build a complete user management system');
    expect(result.decomposed).toBe(true);
    expect(result.subtasks).toHaveLength(3);
    expect(result.subtasks[0].description).toBe('Create User model');
    expect(result.subtasks[1].depends_on).toContain('1');
  });

  it('returns not decomposed for single subtask', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: JSON.stringify({
        subtasks: [{ id: '1', description: 'Add docstring', level: 1, depends_on: [] }],
      }),
      model: 'qwen3:8b',
      tokens_used: 100,
      duration_ms: 500,
    });

    const result = await decomposeTask('Add a docstring');
    expect(result.decomposed).toBe(false);
    expect(result.reason).toBe('Task is atomic');
  });

  it('handles garbled response', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'This is not valid JSON at all',
      model: 'qwen3:8b',
      tokens_used: 50,
      duration_ms: 300,
    });

    const result = await decomposeTask('Do something');
    expect(result.decomposed).toBe(false);
  });

  it('handles Ollama failure gracefully', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockRejectedValueOnce(new Error('timeout'));

    const result = await decomposeTask('Build a system');
    expect(result.decomposed).toBe(false);
    expect(result.reason).toBe('Decomposition failed');
  });

  it('returns not decomposed when feature is disabled', async () => {
    const { loadConfig } = await import('../src/mcp-server/config.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      delegation_level: 2,
      ollama: { base_url: '', default_model: '', fallback_model: null, timeout_ms: 0, health_timeout_ms: 0 },
      routing: { use_local_triage: false, use_historical_learning: false, enable_decomposition: false, triage_model: null },
      specialist_models: {},
      metrics: { enabled: false, log_path: '' },
    });

    const result = await decomposeTask('Build a system');
    expect(result.decomposed).toBe(false);
    expect(result.reason).toBe('Decomposition disabled');
  });

  it('clamps subtask levels to valid range', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: JSON.stringify({
        subtasks: [
          { id: '1', description: 'Step 1', level: 0, depends_on: [] },
          { id: '2', description: 'Step 2', level: 99, depends_on: [] },
        ],
      }),
      model: 'qwen3:8b',
      tokens_used: 100,
      duration_ms: 500,
    });

    const result = await decomposeTask('Complex task');
    expect(result.decomposed).toBe(true);
    expect(result.subtasks[0].estimated_level).toBeGreaterThanOrEqual(1);
    expect(result.subtasks[1].estimated_level).toBeLessThanOrEqual(6);
  });
});
