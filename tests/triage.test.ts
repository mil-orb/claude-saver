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
  // ── Structured JSON responses (primary path) ──

  it('parses structured JSON with category and confidence', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "TRIVIAL", "confidence": 0.92}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('write a docstring');
    expect(result.category).toBe('trivial');
    expect(result.level).toBe(1);
    expect(result.confidence).toBe(0.92);
  });

  it('parses JSON with COMPLEX category', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "COMPLEX", "confidence": 0.85}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('debug multi-file issue');
    expect(result.category).toBe('complex');
    expect(result.level).toBe(5);
    expect(result.confidence).toBe(0.85);
  });

  it('parses JSON with MODERATE category', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "MODERATE", "confidence": 0.75}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('create CRUD endpoint');
    expect(result.category).toBe('moderate');
    expect(result.level).toBe(3);
  });

  it('defaults confidence to 0.7 when not provided in JSON', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "SIMPLE"}',
      model: 'qwen3:8b',
      tokens_used: 25,
      duration_ms: 120,
    });

    const result = await triageWithLocalModel('create a type definition');
    expect(result.category).toBe('simple');
    expect(result.level).toBe(2);
    expect(result.confidence).toBe(0.7);
  });

  it('clamps overconfident model response to 0.95', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "EXPERT", "confidence": 1.0}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('design system architecture');
    expect(result.category).toBe('expert');
    expect(result.level).toBe(6);
    expect(result.confidence).toBe(0.95);
  });

  it('clamps underconfident model response to 0.3', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "MODERATE", "confidence": 0.05}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('something ambiguous');
    expect(result.confidence).toBe(0.3);
  });

  // ── Text fallback (for models that ignore format) ──

  it('falls back to text parsing for plain TRIVIAL response', async () => {
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

  it('falls back to text parsing for verbose response', async () => {
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

  it('rejects JSON with unknown category and falls back to text', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "MEDIUM", "confidence": 0.8}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    const result = await triageWithLocalModel('something');
    // "MEDIUM" is not a valid category, text fallback won't match either
    expect(result.level).toBe(3); // defaults to moderate
    expect(result.confidence).toBe(0.3);
  });

  // ── Error handling ──

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

  // ── Format option is passed ──

  it('passes format schema to ollamaChat', async () => {
    const { ollamaChat } = await import('../src/mcp-server/health.js');
    vi.mocked(ollamaChat).mockResolvedValueOnce({
      response: '{"category": "SIMPLE", "confidence": 0.8}',
      model: 'qwen3:8b',
      tokens_used: 30,
      duration_ms: 150,
    });

    await triageWithLocalModel('write tests');

    expect(vi.mocked(ollamaChat)).toHaveBeenCalledWith(
      expect.stringContaining('write tests'),
      expect.objectContaining({
        format: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            category: expect.objectContaining({ enum: expect.any(Array) }),
          }),
        }),
      }),
    );
  });
});
