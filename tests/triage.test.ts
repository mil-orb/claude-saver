import { describe, it, expect, vi } from 'vitest';
import { triageWithLocalModel } from '../src/mcp-server/triage.js';

// Mock the health module to avoid actual Ollama calls
vi.mock('../src/mcp-server/health.js', () => ({
  ollamaChat: vi.fn(),
}));

vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: vi.fn(() => ({
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'qwen3:8b',
      fallback_model: null,
      timeout_ms: 30000,
      health_timeout_ms: 3000,
    },
    routing: {
      use_local_triage: true,
      use_historical_learning: false,
      enable_decomposition: false,
      triage_model: null,
    },
    specialist_models: {},
    metrics: { enabled: false, log_path: '' },
  })),
}));

describe('Triage (Layer 3)', () => {
  it('classifies TRIVIAL response to Level 1', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'TRIVIAL',
      model: 'qwen3:8b',
      tokens_used: 50,
      duration_ms: 200,
    });

    const result = await triageWithLocalModel('write a docstring');
    expect(result.category).toBe('trivial');
    expect(result.level).toBe(1);
    expect(result.confidence).toBe(0.7);
  });

  it('classifies COMPLEX response to Level 5', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'COMPLEX',
      model: 'qwen3:8b',
      tokens_used: 50,
      duration_ms: 200,
    });

    const result = await triageWithLocalModel('debug multi-file issue');
    expect(result.category).toBe('complex');
    expect(result.level).toBe(5);
  });

  it('classifies MODERATE response to Level 3', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'MODERATE',
      model: 'qwen3:8b',
      tokens_used: 50,
      duration_ms: 200,
    });

    const result = await triageWithLocalModel('create CRUD endpoint');
    expect(result.category).toBe('moderate');
    expect(result.level).toBe(3);
  });

  it('defaults to Level 3 on garbled response', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'asdfghjkl random garbage',
      model: 'qwen3:8b',
      tokens_used: 50,
      duration_ms: 200,
    });

    const result = await triageWithLocalModel('something ambiguous');
    expect(result.level).toBe(3);
    expect(result.confidence).toBe(0.3);
  });

  it('defaults to Level 3 on Ollama failure', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockRejectedValueOnce(new Error('Connection refused'));

    const result = await triageWithLocalModel('some task');
    expect(result.category).toBe('moderate');
    expect(result.level).toBe(3);
    expect(result.confidence).toBe(0.3);
  });

  it('handles response with extra text around category', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: 'The category is SIMPLE because it is straightforward.',
      model: 'qwen3:8b',
      tokens_used: 80,
      duration_ms: 300,
    });

    const result = await triageWithLocalModel('create a type definition');
    expect(result.category).toBe('simple');
    expect(result.level).toBe(2);
  });
});
