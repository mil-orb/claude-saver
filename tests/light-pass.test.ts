import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/mcp-server/config.js', () => ({
  loadConfig: vi.fn(),
}));
vi.mock('../src/mcp-server/health.js', () => ({
  ollamaChat: vi.fn(),
}));
vi.mock('../src/mcp-server/router.js', () => ({
  classifyTask: vi.fn(),
}));
vi.mock('../src/mcp-server/output-estimator.js', () => ({
  estimateOutputTokens: vi.fn(),
}));
vi.mock('../src/mcp-server/context-pipeline.js', () => ({
  extractFileRefs: vi.fn(),
  packContext: vi.fn(),
  expandContext: vi.fn(),
  contextToPrompt: vi.fn(),
}));
vi.mock('../src/mcp-server/quality-gate.js', () => ({
  runQualityGate: vi.fn(),
}));
vi.mock('../src/mcp-server/delegation-metrics.js', () => ({
  logDelegation: vi.fn(),
}));

import { executeLightPass } from '../src/mcp-server/light-pass.js';
import { loadConfig } from '../src/mcp-server/config.js';
import { ollamaChat } from '../src/mcp-server/health.js';
import { classifyTask } from '../src/mcp-server/router.js';
import { estimateOutputTokens } from '../src/mcp-server/output-estimator.js';
import {
  extractFileRefs,
  packContext,
  expandContext,
  contextToPrompt,
} from '../src/mcp-server/context-pipeline.js';
import { runQualityGate } from '../src/mcp-server/quality-gate.js';
import { logDelegation } from '../src/mcp-server/delegation-metrics.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.mocked(loadConfig);
const mockOllamaChat = vi.mocked(ollamaChat);
const mockClassifyTask = vi.mocked(classifyTask);
const mockEstimateOutputTokens = vi.mocked(estimateOutputTokens);
const mockExtractFileRefs = vi.mocked(extractFileRefs);
const mockPackContext = vi.mocked(packContext);
const mockExpandContext = vi.mocked(expandContext);
const mockContextToPrompt = vi.mocked(contextToPrompt);
const mockRunQualityGate = vi.mocked(runQualityGate);
const mockLogDelegation = vi.mocked(logDelegation);

// ---------------------------------------------------------------------------
// Default fixture values
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  light_pass: {
    enabled: true,
    max_input_tokens: 1500,
    max_output_tokens: 600,
    max_wall_time_ms: 5000,
    temperature: 0.1,
    allow_retry: true,
    retry_max_input_tokens: 3000,
    retry_max_output_tokens: 1200,
  },
  quality_gate: {
    enabled: true,
    check_completeness: true,
    check_code_parse: true,
    check_scope: true,
    check_hedging: true,
    check_proportionality: true,
    min_output_length: 20,
    max_output_length: 10000,
  },
  context_pipeline: {
    max_files: 3,
    max_lines_per_file: 120,
    max_diff_lines: 200,
  },
  metrics: {
    enabled: true,
    log_path: '~/.claude-saver/metrics.jsonl',
  },
};

const DEFAULT_ROUTING = {
  route: 'local' as const,
  task_complexity: 2,
  confidence: 0.8,
  reason: 'test',
  classification_layer: 'heuristic' as const,
  escalation_policy: 'standard',
  delegation_level: 2,
};

const DEFAULT_ESTIMATE = {
  estimated_tokens: 300,
  source: 'heuristic' as const,
  confidence: 0.4,
  sample_size: 0,
};

const DEFAULT_PACKED = {
  task: 'test',
  outlines: [],
  slices: [],
  totalTokens: 100,
  budget: 1500,
  filesIncluded: 0,
};

const GOOD_RESPONSE = 'A good answer that is clean and complete and meets the minimum output length requirement';

const DEFAULT_CHAT_RESULT = {
  response: GOOD_RESPONSE,
  model: 'test-model',
  tokens_used: 200,
  duration_ms: 1000,
};

const DEFAULT_GATE_PASS = {
  accepted: true,
  hard_failures: [],
  soft_failures: [],
  all_checks: [],
  checks_passed: 5,
  checks_total: 5,
  should_retry: false,
  should_escalate: false,
  failure_signals: [],
};

const DEFAULT_OPTIONS = { tool: 'edit_file' };

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks and install defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  mockLoadConfig.mockReturnValue(DEFAULT_CONFIG as ReturnType<typeof loadConfig>);
  mockClassifyTask.mockResolvedValue(DEFAULT_ROUTING);
  mockEstimateOutputTokens.mockReturnValue(DEFAULT_ESTIMATE);
  mockExtractFileRefs.mockReturnValue([]);
  mockPackContext.mockResolvedValue(DEFAULT_PACKED as Awaited<ReturnType<typeof packContext>>);
  mockExpandContext.mockResolvedValue(DEFAULT_PACKED as Awaited<ReturnType<typeof expandContext>>);
  mockContextToPrompt.mockReturnValue('the task');
  mockOllamaChat.mockResolvedValue(DEFAULT_CHAT_RESULT);
  mockRunQualityGate.mockReturnValue(DEFAULT_GATE_PASS);
});

// ===========================================================================
// 1. Happy path — accepted on first attempt
// ===========================================================================

describe('Happy path — accepted on first attempt', () => {
  it('returns escalated: false', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(false);
  });

  it('returns the response from ollamaChat', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.response).toBe(GOOD_RESPONSE);
  });

  it('returns quality status "accepted"', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.quality.status).toBe('accepted');
  });

  it('returns attempt_count of 1', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.attempt_count).toBe(1);
  });

  it('includes routing info in the result', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.routing).toBeDefined();
    expect(result.routing.route).toBe('local');
    expect(result.routing.task_complexity).toBe(2);
  });

  it('propagates model and token fields from ollamaChat', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.model).toBe('test-model');
    expect(result.tokens_used).toBe(200);
    expect(result.duration_ms).toBe(1000);
  });

  it('propagates quality checks_passed and checks_total from gate result', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.quality.checks_passed).toBe(5);
    expect(result.quality.checks_total).toBe(5);
  });
});

// ===========================================================================
// 2. Retry path — soft failure then accepted
// ===========================================================================

describe('Retry path — soft failure then accepted', () => {
  beforeEach(() => {
    // First gate: soft fail with should_retry
    const softFailGate = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: true,
      should_escalate: false,
      soft_failures: [{ name: 'no_hedging', passed: false, hard: false, reason: 'Excessive hedging' }],
      checks_passed: 4,
      checks_total: 5,
    };
    // Second gate: pass
    const retryGate = {
      ...DEFAULT_GATE_PASS,
      checks_passed: 5,
      checks_total: 5,
    };
    mockRunQualityGate
      .mockReturnValueOnce(softFailGate)
      .mockReturnValueOnce(retryGate);

    // Retry ollamaChat returns a slightly different result
    const retryChat = { response: 'Retry response that is clean and complete', model: 'test-model', tokens_used: 180, duration_ms: 900 };
    mockOllamaChat
      .mockResolvedValueOnce(DEFAULT_CHAT_RESULT)
      .mockResolvedValueOnce(retryChat);
  });

  it('returns escalated: false after successful retry', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(false);
  });

  it('returns quality status "retried_accepted"', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.quality.status).toBe('retried_accepted');
  });

  it('returns attempt_count of 2', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.attempt_count).toBe(2);
  });

  it('sums tokens_used from both attempts', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    // attempt1: 200, attempt2: 180
    expect(result.tokens_used).toBe(380);
  });

  it('sums duration_ms from both attempts', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    // attempt1: 1000, attempt2: 900
    expect(result.duration_ms).toBe(1900);
  });

  it('calls expandContext for the retry', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockExpandContext).toHaveBeenCalledOnce();
  });

  it('calls ollamaChat twice', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockOllamaChat).toHaveBeenCalledTimes(2);
  });

  it('calls runQualityGate twice', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockRunQualityGate).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 3. Escalation — hard failure on first attempt
// ===========================================================================

describe('Escalation — hard failure', () => {
  beforeEach(() => {
    mockRunQualityGate.mockReturnValue({
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: false,
      should_escalate: true,
      hard_failures: [{ name: 'completeness', passed: false, hard: true, reason: 'Contains TODO marker' }],
    });
  });

  it('returns escalated: true', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(true);
  });

  it('includes failure_reasons in the escalation payload', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.failure_reasons).toContain('Contains TODO marker');
  });

  it('sets attempt_count to 1 in the escalation payload', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.attempt_count).toBe(1);
  });

  it('includes the task in task_intent', async () => {
    const result = await executeLightPass('my important task', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.task_intent).toBe('my important task');
  });

  it('includes a non-empty message on the escalation', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.message).toBeTruthy();
    expect(result.message).toContain('1 attempt');
  });

  it('does not call expandContext on a hard failure', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockExpandContext).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Escalation — retry also fails
// ===========================================================================

describe('Escalation — retry also fails', () => {
  beforeEach(() => {
    const softFailGate = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: true,
      should_escalate: false,
      soft_failures: [{ name: 'no_hedging', passed: false, hard: false, reason: 'Excessive hedging' }],
    };
    const hardFailAfterRetry = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: false,
      should_escalate: true,
      hard_failures: [{ name: 'length', passed: false, hard: true, reason: 'Output too short' }],
    };
    mockRunQualityGate
      .mockReturnValueOnce(softFailGate)
      .mockReturnValueOnce(hardFailAfterRetry);
  });

  it('returns escalated: true when both attempts fail', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(true);
  });

  it('sets attempt_count to 2 in the escalation payload', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.attempt_count).toBe(2);
  });

  it('combines failure reasons from both gate runs', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    // Reasons from gate1 soft_failures and gate2 hard_failures should be present
    expect(result.escalation.failure_reasons.length).toBeGreaterThan(0);
  });

  it('message references 2 attempts', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.message).toContain('2 attempt');
  });
});

// ===========================================================================
// 5. Ollama failure
// ===========================================================================

describe('Ollama failure', () => {
  it('escalates when ollamaChat throws an error', async () => {
    mockOllamaChat.mockRejectedValue(new Error('connection refused'));
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(true);
  });

  it('escalation includes "Ollama request failed" in failure_reasons', async () => {
    mockOllamaChat.mockRejectedValue(new Error('timeout'));
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.failure_reasons).toContain('Ollama request failed');
  });

  it('escalates with attempt_count 1 when the first ollamaChat fails', async () => {
    mockOllamaChat.mockRejectedValue(new Error('network error'));
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.attempt_count).toBe(1);
  });

  it('escalates with attempt_count 2 when retry ollamaChat fails', async () => {
    const softFailGate = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: true,
      should_escalate: false,
      soft_failures: [{ name: 'no_hedging', passed: false, hard: false, reason: 'Excessive hedging' }],
    };
    mockRunQualityGate.mockReturnValueOnce(softFailGate);
    // First call succeeds, second call (retry) throws
    mockOllamaChat
      .mockResolvedValueOnce(DEFAULT_CHAT_RESULT)
      .mockRejectedValueOnce(new Error('retry timeout'));

    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (!result.escalated) throw new Error('expected escalation');
    expect(result.escalation.attempt_count).toBe(2);
    expect(result.escalation.failure_reasons).toContain('Retry Ollama request failed');
  });
});

// ===========================================================================
// 6. Quality gate disabled
// ===========================================================================

describe('Quality gate disabled', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      quality_gate: { ...DEFAULT_CONFIG.quality_gate, enabled: false },
    } as ReturnType<typeof loadConfig>);
  });

  it('accepts the response without calling runQualityGate', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(result.escalated).toBe(false);
    expect(mockRunQualityGate).not.toHaveBeenCalled();
  });

  it('returns quality status "accepted" even when gate is disabled', async () => {
    const result = await executeLightPass('do a thing', DEFAULT_OPTIONS);
    if (result.escalated) throw new Error('unexpected escalation');
    expect(result.quality.status).toBe('accepted');
  });
});

// ===========================================================================
// 7. Delegation metrics
// ===========================================================================

describe('Delegation metrics', () => {
  it('calls logDelegation with quality_status "accepted" on first-attempt success', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockLogDelegation).toHaveBeenCalledOnce();
    expect(mockLogDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ quality_status: 'accepted' }),
    );
  });

  it('calls logDelegation with quality_status "retried_accepted" after successful retry', async () => {
    const softFailGate = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: true,
      should_escalate: false,
      soft_failures: [{ name: 'no_hedging', passed: false, hard: false, reason: 'Excessive hedging' }],
    };
    mockRunQualityGate
      .mockReturnValueOnce(softFailGate)
      .mockReturnValueOnce(DEFAULT_GATE_PASS);
    mockOllamaChat
      .mockResolvedValueOnce(DEFAULT_CHAT_RESULT)
      .mockResolvedValueOnce({ ...DEFAULT_CHAT_RESULT, tokens_used: 150, duration_ms: 800 });

    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockLogDelegation).toHaveBeenCalledOnce();
    expect(mockLogDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ quality_status: 'retried_accepted' }),
    );
  });

  it('calls logDelegation with quality_status "escalated" on hard failure', async () => {
    mockRunQualityGate.mockReturnValue({
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: false,
      should_escalate: true,
      hard_failures: [{ name: 'completeness', passed: false, hard: true, reason: 'Contains TODO marker' }],
    });

    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockLogDelegation).toHaveBeenCalledOnce();
    expect(mockLogDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ quality_status: 'escalated' }),
    );
  });

  it('does not call logDelegation when ollamaChat throws (no chat result)', async () => {
    mockOllamaChat.mockRejectedValue(new Error('fail'));
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    // buildEscalation is called directly without a logDelegation call when there is no chat result
    expect(mockLogDelegation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8. Context pipeline
// ===========================================================================

describe('Context pipeline', () => {
  it('uses fileRefs option directly when provided, skipping extractFileRefs', async () => {
    await executeLightPass('do a thing', { ...DEFAULT_OPTIONS, fileRefs: ['src/foo.ts'] });
    expect(mockExtractFileRefs).not.toHaveBeenCalled();
    expect(mockPackContext).toHaveBeenCalledWith(
      expect.anything(),
      ['src/foo.ts'],
      expect.anything(),
      expect.anything(),
    );
  });

  it('calls extractFileRefs when no fileRefs option is provided', async () => {
    mockExtractFileRefs.mockReturnValue(['auto-detected.ts']);
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockExtractFileRefs).toHaveBeenCalledOnce();
    expect(mockPackContext).toHaveBeenCalledWith(
      expect.anything(),
      ['auto-detected.ts'],
      expect.anything(),
      expect.anything(),
    );
  });

  it('calls contextToPrompt with the packed context', async () => {
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockContextToPrompt).toHaveBeenCalledWith(DEFAULT_PACKED);
  });

  it('passes the contextToPrompt result as the prompt to ollamaChat', async () => {
    mockContextToPrompt.mockReturnValue('formatted prompt text');
    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockOllamaChat).toHaveBeenCalledWith(
      'formatted prompt text',
      expect.anything(),
    );
  });

  it('calls expandContext with retry_max_input_tokens during retry', async () => {
    const softFailGate = {
      ...DEFAULT_GATE_PASS,
      accepted: false,
      should_retry: true,
      should_escalate: false,
      soft_failures: [{ name: 'no_hedging', passed: false, hard: false, reason: 'Excessive hedging' }],
    };
    mockRunQualityGate
      .mockReturnValueOnce(softFailGate)
      .mockReturnValueOnce(DEFAULT_GATE_PASS);
    mockOllamaChat
      .mockResolvedValueOnce(DEFAULT_CHAT_RESULT)
      .mockResolvedValueOnce({ ...DEFAULT_CHAT_RESULT, tokens_used: 150, duration_ms: 800 });

    await executeLightPass('do a thing', DEFAULT_OPTIONS);
    expect(mockExpandContext).toHaveBeenCalledWith(
      DEFAULT_PACKED,
      DEFAULT_CONFIG.light_pass.retry_max_input_tokens,
      expect.anything(),
    );
  });
});
