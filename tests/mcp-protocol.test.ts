import { describe, it, expect, vi, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Capture tool registrations and server config
// ---------------------------------------------------------------------------

const registeredTools: Array<{
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: Function;
}> = [];

let serverConfig: { name: string; version: string } | null = null;
let mockConnectCalled = false;

// Mock MCP SDK — capture every .tool() call
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    constructor(config: { name: string; version: string }) {
      serverConfig = config;
    }
    tool(name: string, description: string, schema: Record<string, unknown>, handler: Function) {
      registeredTools.push({ name, description, schema, handler });
    }
    connect() {
      mockConnectCalled = true;
      return Promise.resolve();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport {},
}));

// Mock internal deps so the module loads without side-effects
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
  saveConfig: vi.fn(),
}));

vi.mock('../src/mcp-server/health.js', () => ({
  checkHealth: vi.fn().mockResolvedValue({
    healthy: true,
    models: ['test-model'],
    latency_ms: 10,
    url: 'http://localhost:11434',
  }),
  ollamaChat: vi.fn().mockResolvedValue({
    response: 'mocked',
    model: 'test-model',
    tokens_used: 10,
    duration_ms: 50,
    thinking: null,
    done_reason: 'stop',
  }),
}));

vi.mock('../src/mcp-server/fs-tools.js', () => ({
  handleFs: vi.fn().mockResolvedValue({ files: [] }),
  handleFsPreview: vi.fn().mockResolvedValue({ structure: [] }),
}));

vi.mock('../src/mcp-server/router.js', () => ({
  classifyTask: vi.fn().mockResolvedValue({
    route: 'local',
    task_complexity: 1,
    confidence: 0.95,
    reason: 'mock',
    classification_layer: 'keyword',
  }),
}));

vi.mock('../src/mcp-server/metrics.js', () => ({
  computeSummary: vi.fn().mockReturnValue({ total_tokens: 0 }),
  resetMetrics: vi.fn(),
  logCompletion: vi.fn(),
}));

// Import the index module — this triggers tool registrations and main()
beforeAll(async () => {
  await import('../src/mcp-server/index.js');
  // Give the async main() a tick to settle
  await new Promise((r) => setTimeout(r, 50));
});

// ---------------------------------------------------------------------------
// Helper: find a registered tool by name
// ---------------------------------------------------------------------------
function findTool(name: string) {
  return registeredTools.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------
describe('Tool Registration', () => {
  it('registers exactly 9 tools', () => {
    expect(registeredTools).toHaveLength(9);
  });

  it('all tool names start with "claudesaver_"', () => {
    for (const tool of registeredTools) {
      expect(tool.name).toMatch(/^claudesaver_/);
    }
  });

  it('each tool has a description string', () => {
    for (const tool of registeredTools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('each tool has a handler function (3rd argument)', () => {
    for (const tool of registeredTools) {
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------
describe('Server Configuration', () => {
  it('server name is "claudesaver"', () => {
    expect(serverConfig).not.toBeNull();
    expect(serverConfig!.name).toBe('claudesaver');
  });

  it('server version is "0.1.0"', () => {
    expect(serverConfig).not.toBeNull();
    expect(serverConfig!.version).toBe('0.1.0');
  });
});

// ---------------------------------------------------------------------------
// Tool Schema Validation
// ---------------------------------------------------------------------------
describe('Tool Schema Validation', () => {
  // Helpers to extract Zod schema shape metadata.
  // Zod schemas stored in the `schema` object are raw z.* instances keyed by param name.
  // We inspect them via their ._def property.

  function getSchemaKeys(toolName: string): string[] {
    const tool = findTool(toolName);
    expect(tool).toBeDefined();
    return Object.keys(tool!.schema);
  }

  function getZodTypeName(zodObj: any): string {
    // Walk through optional wrappers to get the inner type
    let def = zodObj?._def;
    while (def?.typeName === 'ZodOptional' || def?.typeName === 'ZodDefault') {
      def = def.innerType?._def;
    }
    return def?.typeName ?? 'unknown';
  }

  function isOptional(zodObj: any): boolean {
    return zodObj?._def?.typeName === 'ZodOptional' || zodObj?._def?.typeName === 'ZodDefault';
  }

  function getEnumValues(zodObj: any): string[] | undefined {
    let def = zodObj?._def;
    while (def?.typeName === 'ZodOptional' || def?.typeName === 'ZodDefault') {
      def = def.innerType?._def;
    }
    if (def?.typeName === 'ZodEnum') {
      return def.values;
    }
    return undefined;
  }

  // --- claudesaver_fs ---
  describe('claudesaver_fs', () => {
    it('has "operation" as a required enum with 8 values', () => {
      const tool = findTool('claudesaver_fs')!;
      const opSchema = tool.schema.operation;
      expect(isOptional(opSchema)).toBe(false);
      const values = getEnumValues(opSchema);
      expect(values).toBeDefined();
      expect(values).toHaveLength(8);
      expect(values).toEqual(
        expect.arrayContaining([
          'tree', 'list', 'find', 'stat', 'count_lines',
          'git_status', 'git_log', 'git_diff_names',
        ])
      );
    });

    it('has "path" as a required string', () => {
      const tool = findTool('claudesaver_fs')!;
      expect(isOptional(tool.schema.path)).toBe(false);
      expect(getZodTypeName(tool.schema.path)).toBe('ZodString');
    });
  });

  // --- claudesaver_fs_preview ---
  describe('claudesaver_fs_preview', () => {
    it('has "file_path" and "mode" as required', () => {
      const tool = findTool('claudesaver_fs_preview')!;
      expect(isOptional(tool.schema.file_path)).toBe(false);
      expect(getZodTypeName(tool.schema.file_path)).toBe('ZodString');
      expect(isOptional(tool.schema.mode)).toBe(false);
      expect(getZodTypeName(tool.schema.mode)).toBe('ZodEnum');
    });
  });

  // --- claudesaver_complete ---
  describe('claudesaver_complete', () => {
    it('has "prompt" as required', () => {
      const tool = findTool('claudesaver_complete')!;
      expect(isOptional(tool.schema.prompt)).toBe(false);
      expect(getZodTypeName(tool.schema.prompt)).toBe('ZodString');
    });

    it('has optional model, system_prompt, temperature, max_tokens', () => {
      const tool = findTool('claudesaver_complete')!;
      expect(isOptional(tool.schema.model)).toBe(true);
      expect(isOptional(tool.schema.system_prompt)).toBe(true);
      expect(isOptional(tool.schema.temperature)).toBe(true);
      expect(isOptional(tool.schema.max_tokens)).toBe(true);
    });
  });

  // --- claudesaver_generate_code ---
  describe('claudesaver_generate_code', () => {
    it('has "description" and "language" as required', () => {
      const tool = findTool('claudesaver_generate_code')!;
      expect(isOptional(tool.schema.description)).toBe(false);
      expect(getZodTypeName(tool.schema.description)).toBe('ZodString');
      expect(isOptional(tool.schema.language)).toBe(false);
      expect(getZodTypeName(tool.schema.language)).toBe('ZodString');
    });
  });

  // --- claudesaver_analyze_file ---
  describe('claudesaver_analyze_file', () => {
    it('has "file_path" and "task" as required', () => {
      const tool = findTool('claudesaver_analyze_file')!;
      expect(isOptional(tool.schema.file_path)).toBe(false);
      expect(getZodTypeName(tool.schema.file_path)).toBe('ZodString');
      expect(isOptional(tool.schema.task)).toBe(false);
      expect(getZodTypeName(tool.schema.task)).toBe('ZodEnum');
    });

    it('"task" enum has exactly 4 values', () => {
      const tool = findTool('claudesaver_analyze_file')!;
      const values = getEnumValues(tool.schema.task);
      expect(values).toEqual(
        expect.arrayContaining(['summarize', 'find_bugs', 'explain', 'refactor'])
      );
      expect(values).toHaveLength(4);
    });
  });

  // --- claudesaver_batch ---
  describe('claudesaver_batch', () => {
    it('has "tasks" as a required array', () => {
      const tool = findTool('claudesaver_batch')!;
      expect(isOptional(tool.schema.tasks)).toBe(false);
      expect(getZodTypeName(tool.schema.tasks)).toBe('ZodArray');
    });
  });

  // --- claudesaver_models ---
  describe('claudesaver_models', () => {
    it('has "action" as a required enum', () => {
      const tool = findTool('claudesaver_models')!;
      expect(isOptional(tool.schema.action)).toBe(false);
      const values = getEnumValues(tool.schema.action);
      expect(values).toBeDefined();
      expect(values).toEqual(expect.arrayContaining(['list', 'health']));
    });
  });

  // --- claudesaver_level ---
  describe('claudesaver_level', () => {
    it('has "action" as a required enum', () => {
      const tool = findTool('claudesaver_level')!;
      expect(isOptional(tool.schema.action)).toBe(false);
      const values = getEnumValues(tool.schema.action);
      expect(values).toBeDefined();
      expect(values).toEqual(expect.arrayContaining(['get', 'set', 'describe']));
    });

    it('has "level" as optional', () => {
      const tool = findTool('claudesaver_level')!;
      expect(isOptional(tool.schema.level)).toBe(true);
    });
  });

  // --- claudesaver_metrics ---
  describe('claudesaver_metrics', () => {
    it('has "action" as a required enum', () => {
      const tool = findTool('claudesaver_metrics')!;
      expect(isOptional(tool.schema.action)).toBe(false);
      const values = getEnumValues(tool.schema.action);
      expect(values).toBeDefined();
      expect(values).toEqual(expect.arrayContaining(['summary', 'reset', 'session']));
    });
  });
});

// ---------------------------------------------------------------------------
// Tool Response Format (ok / err helpers)
// ---------------------------------------------------------------------------
describe('Tool Response Format', () => {
  it('ok() helper returns { content: [{ type: "text", text: ... }] }', async () => {
    // Call any tool handler that will succeed — claudesaver_models with action "health"
    const tool = findTool('claudesaver_models')!;
    const result = await tool.handler({ action: 'health' });

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    // Should be valid JSON
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    // Should NOT have isError
    expect(result.isError).toBeUndefined();
  });

  it('err() helper returns { content: [...], isError: true }', async () => {
    // Call claudesaver_analyze_file with a path that won't exist, triggering the catch
    const tool = findTool('claudesaver_analyze_file')!;
    const result = await tool.handler({
      file_path: '/nonexistent/path/that/does/not/exist.ts',
      task: 'summarize',
    });

    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('isError', true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    // The text should be JSON containing an error key
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('error');
  });
});
