import { loadConfig } from './config.js';

export interface HealthStatus {
  healthy: boolean;
  url: string;
  models: string[];
  error?: string;
  latency_ms?: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

async function fetchWithTimeout(url: string, timeoutMs: number, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(baseUrl?: string, timeoutMs?: number): Promise<HealthStatus> {
  const config = loadConfig();
  const url = baseUrl ?? config.ollama.base_url;
  const timeout = timeoutMs ?? config.ollama.health_timeout_ms;
  const start = Date.now();

  try {
    const response = await fetchWithTimeout(`${url}/api/tags`, timeout);
    const latency = Date.now() - start;

    if (!response.ok) {
      return { healthy: false, url, models: [], error: `HTTP ${response.status}`, latency_ms: latency };
    }

    const data = await response.json() as { models?: OllamaModel[] };
    const models = (data.models ?? []).map((m: OllamaModel) => m.name);

    return { healthy: true, url, models, latency_ms: latency };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { healthy: false, url, models: [], error: message };
  }
}

export interface OllamaChatResult {
  response: string;
  thinking?: string;
  model: string;
  tokens_used: number;
  duration_ms: number;
  done_reason?: string;
}

export async function ollamaChat(
  prompt: string,
  options?: {
    model?: string;
    system_prompt?: string;
    temperature?: number;
    max_tokens?: number;
    baseUrl?: string;
    timeoutMs?: number;
    format?: 'json' | Record<string, unknown>;
  }
): Promise<OllamaChatResult> {
  const config = loadConfig();
  const model = options?.model ?? config.ollama.default_model;
  const fallbackModel = config.ollama.fallback_model;

  try {
    return await ollamaChatOnce(prompt, model, options);
  } catch (primaryError) {
    // If a fallback model is configured and we didn't already specify one, retry
    if (fallbackModel && !options?.model && fallbackModel !== model) {
      try {
        return await ollamaChatOnce(prompt, fallbackModel, options);
      } catch {
        // Fallback also failed — throw the primary error
      }
    }
    throw primaryError;
  }
}

async function ollamaChatOnce(
  prompt: string,
  model: string,
  options?: {
    system_prompt?: string;
    temperature?: number;
    max_tokens?: number;
    baseUrl?: string;
    timeoutMs?: number;
    format?: 'json' | Record<string, unknown>;
  }
): Promise<OllamaChatResult> {
  const config = loadConfig();
  const baseUrl = options?.baseUrl ?? config.ollama.base_url;
  const timeoutMs = options?.timeoutMs ?? config.ollama.timeout_ms;

  const messages: Array<{ role: string; content: string }> = [];

  if (options?.system_prompt) {
    messages.push({ role: 'system', content: options.system_prompt });
  }
  messages.push({ role: 'user', content: prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    options: {
      temperature: options?.temperature ?? 0.3,
      num_predict: options?.max_tokens ?? 8192,
    },
  };

  if (options?.format) {
    body.format = options.format;
  }

  const start = Date.now();
  const response = await fetchWithTimeout(`${baseUrl}/api/chat`, timeoutMs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    message?: { content?: string; thinking?: string };
    eval_count?: number;
    prompt_eval_count?: number;
    done_reason?: string;
  };

  const duration_ms = Date.now() - start;
  const content = data.message?.content ?? '';
  const thinking = data.message?.thinking;
  const tokens_used = (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0);

  // For thinking models (gpt-oss, qwen3, etc.): if content is empty but
  // thinking has the answer, extract the usable response from thinking.
  let responseText = content;
  if (!responseText.trim() && thinking) {
    responseText = extractResponseFromThinking(thinking);
  }

  return { response: responseText, thinking, model, tokens_used, duration_ms, done_reason: data.done_reason };
}

/**
 * When a thinking model puts the answer in the thinking field and content is empty
 * (e.g. ran out of tokens before generating content), try to salvage the answer.
 */
function extractResponseFromThinking(thinking: string): string {
  // Look for code blocks in the thinking
  const codeBlockMatch = thinking.match(/```[\w]*\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[0];
  }

  // Look for the last substantive paragraph (often the conclusion)
  const paragraphs = thinking.split('\n\n').filter(p => p.trim().length > 20);
  if (paragraphs.length > 0) {
    return paragraphs[paragraphs.length - 1].trim();
  }

  return `[Thinking model output — see thinking field]\n${thinking}`;
}
