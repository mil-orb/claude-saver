import { loadConfig, type ClaudeSaverConfig } from './config.js';
import { ollamaChat, type OllamaChatResult } from './health.js';
import { classifyTask } from './router.js';
import { estimateOutputTokens } from './output-estimator.js';
import { extractFileRefs, packContext, expandContext, contextToPrompt, type PackedContext } from './context-pipeline.js';
import { runQualityGate, type QualityGateResult, type GateOptions } from './quality-gate.js';
import { logDelegation } from './delegation-metrics.js';

export interface LightPassOptions {
  tool: string;
  model?: string;
  system_prompt?: string;
  expectedLanguage?: string;
  allowedFiles?: string[];
  requiredSections?: string[];
  fileRefs?: string[];
}

export interface LightPassSuccess {
  escalated: false;
  response: string;
  thinking?: string;
  model: string;
  tokens_used: number;
  duration_ms: number;
  done_reason?: string;
  quality: {
    status: 'accepted' | 'retried_accepted';
    checks_passed: number;
    checks_total: number;
  };
  routing: Record<string, unknown>;
  attempt_count: number;
}

export interface LightPassEscalation {
  escalated: true;
  message: string;
  escalation: {
    task_intent: string;
    file_context: Array<{ file: string; outline: string }>;
    failure_reasons: string[];
    attempt_count: number;
    escalation_message: string;
  };
  routing: Record<string, unknown>;
}

export type LightPassResult = LightPassSuccess | LightPassEscalation;

function buildRoutingInfo(routing: Record<string, unknown>): Record<string, unknown> {
  return {
    route: routing.route,
    task_complexity: routing.task_complexity,
    confidence: routing.confidence,
    reason: routing.reason,
    classification_layer: routing.classification_layer,
  };
}

export async function executeLightPass(
  task: string,
  options: LightPassOptions
): Promise<LightPassResult> {
  const config = loadConfig();
  const lpConfig = config.light_pass;
  const qgConfig = config.quality_gate;
  const cpConfig = config.context_pipeline;

  // Classify the task via router
  const routing = await classifyTask(task);
  const routingInfo = buildRoutingInfo(routing as unknown as Record<string, unknown>);

  // Estimate output tokens to guide budget
  const estimate = estimateOutputTokens(options.tool, routing.task_complexity);

  // Extract file references from the task or use provided ones
  const fileRefs = options.fileRefs ?? extractFileRefs(task);

  // Build context within budget
  const packed = await packContext(task, fileRefs, lpConfig.max_input_tokens, cpConfig);
  const prompt = contextToPrompt(packed);

  // Attempt 1: constrained execution
  const attempt1 = await attemptExecution(prompt, config, options, estimate.estimated_tokens);

  if (!attempt1) {
    return buildEscalation(task, packed, ['Ollama request failed'], 1, routingInfo);
  }

  // Quality gate
  const gateOpts: GateOptions = {
    config: qgConfig,
    expectedLanguage: options.expectedLanguage,
    allowedFiles: options.allowedFiles,
    requiredSections: options.requiredSections,
    expectedOutputTokens: estimate.estimated_tokens,
  };

  const gate1 = qgConfig.enabled
    ? runQualityGate(attempt1.response, gateOpts)
    : acceptAll(attempt1.response);

  if (gate1.accepted) {
    logDelegation({
      tool: options.tool,
      quality_status: 'accepted',
      attempt_count: 1,
      tokens_used: attempt1.tokens_used,
      output_tokens: attempt1.tokens_used,
      duration_ms: attempt1.duration_ms,
      model: attempt1.model,
      resolved_locally: true,
    });

    return {
      escalated: false,
      response: attempt1.response,
      thinking: attempt1.thinking,
      model: attempt1.model,
      tokens_used: attempt1.tokens_used,
      duration_ms: attempt1.duration_ms,
      done_reason: attempt1.done_reason,
      quality: {
        status: 'accepted',
        checks_passed: gate1.checks_passed,
        checks_total: gate1.checks_total,
      },
      routing: routingInfo,
      attempt_count: 1,
    };
  }

  // Should we retry?
  if (!gate1.should_escalate && gate1.should_retry && lpConfig.allow_retry) {
    // Expand context for retry
    const expandedPacked = await expandContext(packed, lpConfig.retry_max_input_tokens, cpConfig);
    const retryPrompt = contextToPrompt(expandedPacked);

    const attempt2 = await attemptExecution(retryPrompt, config, {
      ...options,
    }, lpConfig.retry_max_output_tokens);

    if (!attempt2) {
      return buildEscalation(task, packed, ['Retry Ollama request failed'], 2, routingInfo);
    }

    const gate2 = runQualityGate(attempt2.response, gateOpts);

    if (gate2.accepted || (!gate2.should_escalate && gate2.soft_failures.length === 0)) {
      const totalDuration = attempt1.duration_ms + attempt2.duration_ms;
      const totalTokens = attempt1.tokens_used + attempt2.tokens_used;

      logDelegation({
        tool: options.tool,
        quality_status: 'retried_accepted',
        attempt_count: 2,
        tokens_used: totalTokens,
        output_tokens: attempt2.tokens_used,
        duration_ms: totalDuration,
        model: attempt2.model,
        resolved_locally: true,
      });

      return {
        escalated: false,
        response: attempt2.response,
        thinking: attempt2.thinking,
        model: attempt2.model,
        tokens_used: totalTokens,
        duration_ms: totalDuration,
        done_reason: attempt2.done_reason,
        quality: {
          status: 'retried_accepted',
          checks_passed: gate2.checks_passed,
          checks_total: gate2.checks_total,
        },
        routing: routingInfo,
        attempt_count: 2,
      };
    }

    // Second attempt also failed — escalate with combined failure info
    const failureReasons = [
      ...gate1.hard_failures.map(f => f.reason ?? f.name),
      ...gate1.soft_failures.map(f => f.reason ?? f.name),
      ...gate2.hard_failures.map(f => f.reason ?? f.name),
      ...gate2.soft_failures.map(f => f.reason ?? f.name),
    ].filter(Boolean);

    logDelegation({
      tool: options.tool,
      quality_status: 'escalated',
      attempt_count: 2,
      tokens_used: attempt1.tokens_used + attempt2.tokens_used,
      output_tokens: attempt2.tokens_used,
      duration_ms: attempt1.duration_ms + attempt2.duration_ms,
      model: attempt2.model,
      resolved_locally: false,
    });

    return buildEscalation(task, packed, failureReasons, 2, routingInfo);
  }

  // Hard failure — escalate immediately
  const failureReasons = [
    ...gate1.hard_failures.map(f => f.reason ?? f.name),
    ...gate1.soft_failures.map(f => f.reason ?? f.name),
  ].filter(Boolean);

  logDelegation({
    tool: options.tool,
    quality_status: 'escalated',
    attempt_count: 1,
    tokens_used: attempt1.tokens_used,
    output_tokens: attempt1.tokens_used,
    duration_ms: attempt1.duration_ms,
    model: attempt1.model,
    resolved_locally: false,
  });

  return buildEscalation(task, packed, failureReasons, 1, routingInfo);
}

async function attemptExecution(
  prompt: string,
  config: ClaudeSaverConfig,
  options: LightPassOptions,
  maxTokens: number,
): Promise<OllamaChatResult | null> {
  try {
    return await ollamaChat(prompt, {
      model: options.model,
      system_prompt: options.system_prompt,
      temperature: config.light_pass.temperature,
      max_tokens: maxTokens,
      timeoutMs: config.light_pass.max_wall_time_ms,
    });
  } catch {
    return null;
  }
}

function buildEscalation(
  task: string,
  packed: PackedContext,
  failureReasons: string[],
  attemptCount: number,
  routing: Record<string, unknown>,
): LightPassEscalation {
  const fileContext = packed.outlines.map(o => ({
    file: o.filePath,
    outline: `${o.language}, ${o.totalLines} lines. Classes: [${o.structure.classes.join(', ')}]. Functions: [${o.structure.functions.join(', ')}]`,
  }));

  const uniqueReasons = [...new Set(failureReasons)];

  return {
    escalated: true,
    message: `Local model failed after ${attemptCount} attempt${attemptCount > 1 ? 's' : ''}. Reasons: ${uniqueReasons.join('; ')}`,
    escalation: {
      task_intent: task,
      file_context: fileContext,
      failure_reasons: uniqueReasons,
      attempt_count: attemptCount,
      escalation_message: `Local model failed after ${attemptCount} attempt${attemptCount > 1 ? 's' : ''}. ${uniqueReasons.join('. ')}.`,
    },
    routing,
  };
}

function acceptAll(_output: string): QualityGateResult {
  return {
    accepted: true,
    hard_failures: [],
    soft_failures: [],
    all_checks: [],
    checks_passed: 0,
    checks_total: 0,
    should_retry: false,
    should_escalate: false,
    failure_signals: [],
  };
}
