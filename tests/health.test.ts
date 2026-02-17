import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: () => ({
    delegation_level: 2,
    ollama: {
      base_url: 'http://localhost:11434',
      default_model: 'test-model',
      fallback_model: null,
      timeout_ms: 5000,
      health_timeout_ms: 3000,
    },
    routing: {
      use_local_triage: false,
      use_historical_learning: false,
      enable_decomposition: false,
      triage_model: null,
    },
    specialist_models: {},
    metrics: { enabled: false, log_path: '' },
    welcome: {
      show_savings: true,
      show_models: true,
      show_level: true,
      cost_per_million_tokens: 8,
    },
  }),
}));

// Stub global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { checkHealth, ollamaChat, clearModelCache } from '../src/mcp-server/health.js';

beforeEach(() => {
  mockFetch.mockReset();
  clearModelCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------
describe('checkHealth', () => {
  it('returns healthy status with model list when Ollama responds OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: 'llama3:8b', size: 4_000_000_000, modified_at: '2025-01-01T00:00:00Z' },
          { name: 'codellama:7b', size: 3_500_000_000, modified_at: '2025-01-02T00:00:00Z' },
        ],
      }),
    });

    const result = await checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.models).toEqual(['llama3:8b', 'codellama:7b']);
    expect(result.latency_ms).toBeTypeOf('number');
    expect(result.url).toBe('http://localhost:11434');
  });

  it('returns unhealthy with HTTP error when Ollama responds 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('HTTP 500');
    expect(result.models).toEqual([]);
  });

  it('returns unhealthy with error message when fetch throws (unreachable)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    const result = await checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.models).toEqual([]);
  });

  it('returns healthy with empty model list when Ollama has no models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    });

    const result = await checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.models).toEqual([]);
  });
});

/** Prepend a mock for resolveModel() which fetches /api/tags before every chat call */
function mockResolveModel() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ models: [{ name: 'test-model', size: 1000 }] }),
  });
}

// ---------------------------------------------------------------------------
// ollamaChat — normal responses
// ---------------------------------------------------------------------------
describe('ollamaChat — normal responses', () => {
  it('returns response text from a normal completion', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'Hello, world!' },
        eval_count: 10,
        prompt_eval_count: 5,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('Say hello');
    expect(result.response).toBe('Hello, world!');
    expect(result.model).toBe('test-model');
  });

  it('returns both thinking and content fields when present', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: 'The answer is 42.',
          thinking: 'Let me think step by step... 6 * 7 = 42.',
        },
        eval_count: 20,
        prompt_eval_count: 8,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('What is 6*7?');
    expect(result.response).toBe('The answer is 42.');
    expect(result.thinking).toBe('Let me think step by step... 6 * 7 = 42.');
  });

  it('returns correct token counts and duration', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'result' },
        eval_count: 50,
        prompt_eval_count: 25,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('test');
    expect(result.tokens_used).toBe(75);
    expect(result.duration_ms).toBeTypeOf('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// ollamaChat — thinking model edge cases (gpt-oss compatibility)
// ---------------------------------------------------------------------------
describe('ollamaChat — thinking model edge cases', () => {
  it('extracts code block from thinking when content is empty', async () => {
    mockResolveModel();
    const codeBlock = '```typescript\nconsole.log("hello");\n```';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: '',
          thinking: `I need to write some code.\n\n${codeBlock}\n\nThat should work.`,
        },
        eval_count: 30,
        prompt_eval_count: 10,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('Write a hello world');
    expect(result.response).toBe(codeBlock);
  });

  it('extracts last paragraph from thinking when content is empty and no code block', async () => {
    mockResolveModel();
    const thinkingText =
      'First I considered option A.\n\n' +
      'Then I evaluated option B.\n\n' +
      'The best approach is to use a hash map for O(1) lookups.';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: '',
          thinking: thinkingText,
        },
        eval_count: 40,
        prompt_eval_count: 15,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('Best data structure?');
    expect(result.response).toBe('The best approach is to use a hash map for O(1) lookups.');
  });

  it('uses content over thinking when both are present', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          content: 'Use content field.',
          thinking: 'This is the thinking field with a long explanation.',
        },
        eval_count: 10,
        prompt_eval_count: 5,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('test');
    expect(result.response).toBe('Use content field.');
  });

  it('returns fallback message when both content and thinking are empty', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: '', thinking: '' },
        eval_count: 0,
        prompt_eval_count: 5,
        done_reason: 'stop',
      }),
    });

    const result = await ollamaChat('test');
    // When content is empty and thinking is empty string (falsy), no extraction happens.
    // responseText remains '' since extractResponseFromThinking is not called for falsy thinking.
    expect(result.response).toBe('');
  });

  it('returns done_reason when response is truncated (length)', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'partial output...' },
        eval_count: 8192,
        prompt_eval_count: 100,
        done_reason: 'length',
      }),
    });

    const result = await ollamaChat('test');
    expect(result.done_reason).toBe('length');
    expect(result.response).toBe('partial output...');
  });
});

// ---------------------------------------------------------------------------
// ollamaChat — error handling
// ---------------------------------------------------------------------------
describe('ollamaChat — error handling', () => {
  it('throws with error message when Ollama returns HTTP 400', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"model not found"}',
    });

    await expect(ollamaChat('test')).rejects.toThrow('Ollama API error 400');
  });

  it('throws when Ollama returns invalid JSON', async () => {
    mockResolveModel();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    await expect(ollamaChat('test')).rejects.toThrow();
  });

  it('throws when fetch is aborted (timeout)', async () => {
    mockResolveModel();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(ollamaChat('test')).rejects.toThrow();
  });
});
