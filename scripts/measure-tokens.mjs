/**
 * measure-tokens.mjs
 *
 * Measures estimated token counts for realistic coding prompt/response pairs.
 * Uses two heuristics since we cannot call the Anthropic tokenizer directly:
 *   1. Word-based: ~1.3 tokens per word (English text / mixed code)
 *   2. Character-based: ~1 token per 3.5 characters (code-heavy content)
 *
 * Also layers on Claude Code overhead estimates (system prompt, tool schemas,
 * conversation framing) to produce a total "real-world" token budget per task.
 */

// ---------------------------------------------------------------------------
// Task definitions -- realistic prompt + response pairs
// ---------------------------------------------------------------------------

const tasks = [
  {
    name: 'docstring_simple',
    testEstimate: 300,  // what our tests assumed
    input: `Write a docstring for this function:\n\nasync function fetchUser(id: string): Promise<User> {\n  const response = await db.query('SELECT * FROM users WHERE id = $1', [id]);\n  return response.rows[0];\n}`,
    output: `/**\n * Fetches a user by their unique identifier.\n * @param id - The unique user ID to look up\n * @returns Promise resolving to the User object\n * @throws Error if user not found\n */`,
  },
  {
    name: 'docstring_complex',
    testEstimate: 800,
    input: `Write a docstring for this function:\n\nasync function processPayment(orderId: string, amount: number, currency: string, paymentMethod: PaymentMethod, options?: PaymentOptions): Promise<PaymentResult> {\n  const order = await orderService.get(orderId);\n  if (!order) throw new OrderNotFoundError(orderId);\n  const validation = await validatePayment(amount, currency, paymentMethod);\n  if (!validation.valid) throw new PaymentValidationError(validation.errors);\n  const charge = await stripeClient.charges.create({ amount, currency, source: paymentMethod.token });\n  await orderService.updatePaymentStatus(orderId, 'paid', charge.id);\n  return { success: true, chargeId: charge.id, amount, currency };\n}`,
    output: `/**\n * Processes a payment for a given order using the specified payment method.\n * Validates the payment parameters, creates a Stripe charge, and updates\n * the order's payment status.\n *\n * @param orderId - The unique identifier of the order to pay for\n * @param amount - The payment amount in the smallest currency unit (e.g., cents)\n * @param currency - ISO 4217 currency code (e.g., 'usd', 'eur')\n * @param paymentMethod - The payment method containing the Stripe token\n * @param options - Optional payment configuration (retry policy, metadata)\n * @returns Promise resolving to a PaymentResult with charge details\n * @throws OrderNotFoundError if the order doesn't exist\n * @throws PaymentValidationError if payment parameters are invalid\n * @throws StripeError if the charge fails\n */`,
  },
  {
    name: 'commit_message',
    testEstimate: 400,
    input: `Generate a commit message for this diff:\n\ndiff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -15,6 +15,12 @@ export async function login(email: string, password: string) {\n   const user = await findUser(email);\n   if (!user) throw new AuthError('User not found');\n   const valid = await bcrypt.compare(password, user.passwordHash);\n+  if (!valid) {\n+    await incrementFailedAttempts(user.id);\n+    if (await getFailedAttempts(user.id) >= 5) {\n+      await lockAccount(user.id);\n+    }\n+    throw new AuthError('Invalid password');\n+  }\n   const token = generateJWT(user);\n   return { token, user: sanitize(user) };\n }`,
    output: `Add account lockout after 5 failed login attempts\n\nTrack failed authentication attempts per user and automatically\nlock the account when the threshold is reached. This prevents\nbrute-force password attacks.`,
  },
  {
    name: 'unit_test_scaffold',
    testEstimate: 1500,
    input: `Write unit tests for this function:\n\nexport class UserService {\n  constructor(private db: Database, private cache: Cache) {}\n\n  async getById(id: string): Promise<User | null> {\n    const cached = await this.cache.get(\`user:\${id}\`);\n    if (cached) return JSON.parse(cached);\n    const user = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);\n    if (user) await this.cache.set(\`user:\${id}\`, JSON.stringify(user), 3600);\n    return user;\n  }\n\n  async create(data: CreateUserDTO): Promise<User> {\n    const existing = await this.db.query('SELECT id FROM users WHERE email = $1', [data.email]);\n    if (existing) throw new DuplicateEmailError(data.email);\n    const hashed = await bcrypt.hash(data.password, 10);\n    return this.db.insert('users', { ...data, password: hashed });\n  }\n}`,
    output: `import { describe, it, expect, vi, beforeEach } from 'vitest';\nimport { UserService } from './user-service';\n\ndescribe('UserService', () => {\n  let service: UserService;\n  let mockDb: any;\n  let mockCache: any;\n\n  beforeEach(() => {\n    mockDb = { query: vi.fn(), insert: vi.fn() };\n    mockCache = { get: vi.fn(), set: vi.fn() };\n    service = new UserService(mockDb, mockCache);\n  });\n\n  describe('getById', () => {\n    it('returns cached user when available', async () => {\n      const user = { id: '1', name: 'Alice', email: 'alice@example.com' };\n      mockCache.get.mockResolvedValue(JSON.stringify(user));\n      const result = await service.getById('1');\n      expect(result).toEqual(user);\n      expect(mockDb.query).not.toHaveBeenCalled();\n    });\n\n    it('queries database when cache misses', async () => {\n      const user = { id: '1', name: 'Alice', email: 'alice@example.com' };\n      mockCache.get.mockResolvedValue(null);\n      mockDb.query.mockResolvedValue(user);\n      const result = await service.getById('1');\n      expect(result).toEqual(user);\n      expect(mockCache.set).toHaveBeenCalledWith('user:1', JSON.stringify(user), 3600);\n    });\n\n    it('returns null for non-existent user', async () => {\n      mockCache.get.mockResolvedValue(null);\n      mockDb.query.mockResolvedValue(null);\n      const result = await service.getById('999');\n      expect(result).toBeNull();\n    });\n  });\n\n  describe('create', () => {\n    it('creates user with hashed password', async () => {\n      mockDb.query.mockResolvedValue(null);\n      mockDb.insert.mockResolvedValue({ id: '2', name: 'Bob', email: 'bob@test.com' });\n      const result = await service.create({ name: 'Bob', email: 'bob@test.com', password: 'secret123' });\n      expect(result.id).toBe('2');\n      expect(mockDb.insert).toHaveBeenCalled();\n      const insertCall = mockDb.insert.mock.calls[0][1];\n      expect(insertCall.password).not.toBe('secret123');\n    });\n\n    it('throws DuplicateEmailError for existing email', async () => {\n      mockDb.query.mockResolvedValue({ id: '1' });\n      await expect(service.create({ name: 'Bob', email: 'existing@test.com', password: 'pass' }))\n        .rejects.toThrow('existing@test.com');\n    });\n  });\n});`,
  },
  {
    name: 'crud_endpoint',
    testEstimate: 1200,
    input: `Generate a REST endpoint for creating new users with Express:\n- POST /api/users\n- Validate email, name, password\n- Hash password with bcrypt\n- Return 201 with user (without password)`,
    output: `import { Router, Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport { z } from 'zod';\nimport { db } from '../database';\n\nconst router = Router();\n\nconst CreateUserSchema = z.object({\n  name: z.string().min(1).max(100),\n  email: z.string().email(),\n  password: z.string().min(8).max(128),\n});\n\nrouter.post('/api/users', async (req: Request, res: Response) => {\n  try {\n    const data = CreateUserSchema.parse(req.body);\n    const existing = await db.query('SELECT id FROM users WHERE email = $1', [data.email]);\n    if (existing.rows.length > 0) {\n      return res.status(409).json({ error: 'Email already registered' });\n    }\n    const passwordHash = await bcrypt.hash(data.password, 12);\n    const result = await db.query(\n      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',\n      [data.name, data.email, passwordHash]\n    );\n    return res.status(201).json(result.rows[0]);\n  } catch (err) {\n    if (err instanceof z.ZodError) {\n      return res.status(400).json({ errors: err.errors });\n    }\n    return res.status(500).json({ error: 'Internal server error' });\n  }\n});\n\nexport default router;`,
  },
  {
    name: 'format_conversion',
    testEstimate: 200,
    input: `Convert this JSON to YAML:\n{\n  "server": {\n    "port": 3000,\n    "host": "0.0.0.0"\n  },\n  "database": {\n    "url": "postgresql://localhost:5432/myapp",\n    "pool_size": 10\n  },\n  "redis": {\n    "url": "redis://localhost:6379"\n  }\n}`,
    output: `server:\n  port: 3000\n  host: "0.0.0.0"\ndatabase:\n  url: "postgresql://localhost:5432/myapp"\n  pool_size: 10\nredis:\n  url: "redis://localhost:6379"`,
  },
  {
    name: 'file_summary',
    testEstimate: 600,
    input: `Summarize what this file does:\n\nimport express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\nimport rateLimit from 'express-rate-limit';\nimport { authRouter } from './routes/auth';\nimport { usersRouter } from './routes/users';\nimport { ordersRouter } from './routes/orders';\nimport { errorHandler } from './middleware/error';\nimport { requestLogger } from './middleware/logger';\nimport { authenticate } from './middleware/auth';\nimport { config } from './config';\n\nconst app = express();\n\napp.use(helmet());\napp.use(cors({ origin: config.corsOrigins }));\napp.use(express.json({ limit: '10mb' }));\napp.use(requestLogger);\n\nconst limiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 100,\n  standardHeaders: true,\n});\napp.use('/api/', limiter);\n\napp.use('/api/auth', authRouter);\napp.use('/api/users', authenticate, usersRouter);\napp.use('/api/orders', authenticate, ordersRouter);\n\napp.use(errorHandler);\n\napp.listen(config.port, () => {\n  console.log('Server running on port ' + config.port);\n});\n\nexport default app;`,
    output: `This is the main Express application entry point that configures and starts the HTTP server.\n\nKey setup:\n- Security: Helmet for HTTP headers, CORS with configurable origins, rate limiting (100 req/15min)\n- Request handling: JSON body parsing (10MB limit), request logging middleware\n- Routes: Auth (public), Users and Orders (require authentication)\n- Error handling: Centralized error handler middleware\n\nThe server listens on the port from config and exports the app instance for testing.`,
  },
  {
    name: 'type_annotations',
    testEstimate: 700,
    input: `Add type annotations to this function:\n\nfunction processOrder(order, items, discount) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }\n  if (discount) {\n    total = total * (1 - discount / 100);\n  }\n  return { orderId: order.id, total, itemCount: items.length, discountApplied: !!discount };\n}`,
    output: `interface Order {\n  id: string;\n}\n\ninterface OrderItem {\n  price: number;\n  quantity: number;\n}\n\ninterface OrderResult {\n  orderId: string;\n  total: number;\n  itemCount: number;\n  discountApplied: boolean;\n}\n\nfunction processOrder(order: Order, items: OrderItem[], discount?: number): OrderResult {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }\n  if (discount) {\n    total = total * (1 - discount / 100);\n  }\n  return { orderId: order.id, total, itemCount: items.length, discountApplied: !!discount };\n}`,
  },
  {
    name: 'boilerplate',
    testEstimate: 350,
    input: `Generate boilerplate for a new Express middleware that logs request timing`,
    output: `import { Request, Response, NextFunction } from 'express';\n\nexport function requestTimer(req: Request, res: Response, next: NextFunction): void {\n  const start = process.hrtime.bigint();\n\n  res.on('finish', () => {\n    const end = process.hrtime.bigint();\n    const durationMs = Number(end - start) / 1_000_000;\n    console.log(\`\${req.method} \${req.originalUrl} \${res.statusCode} \${durationMs.toFixed(2)}ms\`);\n  });\n\n  next();\n}`,
  },
];

// ---------------------------------------------------------------------------
// Token-counting heuristics
// ---------------------------------------------------------------------------

/**
 * Word-based estimate: split on whitespace, multiply by 1.3.
 * Good for natural-language-heavy content.
 */
function countTokensWordBased(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * 1.3);
}

/**
 * Character-based estimate: total characters / 3.5.
 * Better for code-heavy content where many tokens are punctuation
 * or short identifiers that each consume a full token.
 */
function countTokensCharBased(text) {
  return Math.ceil(text.length / 3.5);
}

/**
 * Blended estimate: average the two heuristics, weighted toward
 * char-based for code (60/40 split since our content is mostly code).
 */
function countTokensBlended(text) {
  const w = countTokensWordBased(text);
  const c = countTokensCharBased(text);
  return Math.ceil(w * 0.4 + c * 0.6);
}

// ---------------------------------------------------------------------------
// Claude Code overhead constants
// ---------------------------------------------------------------------------

const CLAUDE_CODE_SYSTEM_PROMPT_TOKENS = 6500;  // ~5000-8000, use midpoint
const TOOL_SCHEMA_TOKENS_PER_TOOL = 350;        // ~200-500, use midpoint
const NUM_TOOLS_TYPICAL = 6;                     // Read, Write, Edit, Bash, Grep, Glob
const CONVERSATION_FRAMING_TOKENS = 200;         // role tags, message structure
const TOTAL_OVERHEAD =
  CLAUDE_CODE_SYSTEM_PROMPT_TOKENS +
  TOOL_SCHEMA_TOKENS_PER_TOOL * NUM_TOOLS_TYPICAL +
  CONVERSATION_FRAMING_TOKENS;

// ---------------------------------------------------------------------------
// Measurement + formatting
// ---------------------------------------------------------------------------

function pad(str, len, align = 'right') {
  const s = String(str);
  if (align === 'left') return s.padEnd(len);
  return s.padStart(len);
}

function formatRow(cols, widths, aligns) {
  return '| ' + cols.map((c, i) => pad(c, widths[i], aligns[i])).join(' | ') + ' |';
}

function separator(widths) {
  return '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('');
console.log('='.repeat(130));
console.log('  TOKEN MEASUREMENT REPORT -- Realistic Coding Task Prompt/Response Pairs');
console.log('  Heuristic methods: word-based (x1.3), char-based (/3.5), blended (40/60)');
console.log('='.repeat(130));
console.log('');

// -- Section 1: Raw content measurements --

const headers1 = [
  'Task',
  'In Chars',
  'Out Chars',
  'In Tok(w)',
  'In Tok(c)',
  'In Tok(b)',
  'Out Tok(w)',
  'Out Tok(c)',
  'Out Tok(b)',
  'Total(b)',
];
const widths1 = [22, 9, 9, 10, 10, 10, 11, 11, 10, 9];
const aligns1 = ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'];

console.log('SECTION 1: Raw Token Estimates per Task (no overhead)');
console.log('  (w) = word-based    (c) = char-based    (b) = blended 40w/60c');
console.log('');
console.log(formatRow(headers1, widths1, aligns1));
console.log(separator(widths1));

const results = [];

for (const task of tasks) {
  const inChars = task.input.length;
  const outChars = task.output.length;

  const inTokW = countTokensWordBased(task.input);
  const inTokC = countTokensCharBased(task.input);
  const inTokB = countTokensBlended(task.input);

  const outTokW = countTokensWordBased(task.output);
  const outTokC = countTokensCharBased(task.output);
  const outTokB = countTokensBlended(task.output);

  const totalBlended = inTokB + outTokB;

  results.push({
    name: task.name,
    inChars,
    outChars,
    inTokW,
    inTokC,
    inTokB,
    outTokW,
    outTokC,
    outTokB,
    totalBlended,
    testEstimate: task.testEstimate,
  });

  console.log(
    formatRow(
      [
        task.name,
        inChars,
        outChars,
        inTokW,
        inTokC,
        inTokB,
        outTokW,
        outTokC,
        outTokB,
        totalBlended,
      ],
      widths1,
      aligns1
    )
  );
}

console.log(separator(widths1));
console.log('');

// -- Section 2: With Claude Code overhead --

console.log('SECTION 2: Total Tokens Including Claude Code Overhead');
console.log(`  System prompt:        ~${CLAUDE_CODE_SYSTEM_PROMPT_TOKENS} tokens`);
console.log(`  Tool schemas (${NUM_TOOLS_TYPICAL} tools): ~${TOOL_SCHEMA_TOKENS_PER_TOOL * NUM_TOOLS_TYPICAL} tokens`);
console.log(`  Conversation framing: ~${CONVERSATION_FRAMING_TOKENS} tokens`);
console.log(`  TOTAL OVERHEAD:       ~${TOTAL_OVERHEAD} tokens`);
console.log('');

const headers2 = [
  'Task',
  'Content',
  'Overhead',
  'Total w/OH',
  'Test Est',
  'Ratio(act/est)',
  'Status',
];
const widths2 = [22, 9, 9, 11, 9, 15, 14];
const aligns2 = ['left', 'right', 'right', 'right', 'right', 'right', 'left'];

console.log(formatRow(headers2, widths2, aligns2));
console.log(separator(widths2));

let totalContentTokens = 0;
let totalWithOverhead = 0;
let totalTestEstimates = 0;

for (const r of results) {
  const withOverhead = r.totalBlended + TOTAL_OVERHEAD;
  const ratio = (r.totalBlended / r.testEstimate).toFixed(2);
  const ratioNum = parseFloat(ratio);

  let status;
  if (ratioNum >= 0.8 && ratioNum <= 1.2) {
    status = 'ACCURATE';
  } else if (ratioNum < 0.8) {
    status = 'OVER-ESTIMATED';
  } else {
    status = 'UNDER-ESTIMATED';
  }

  totalContentTokens += r.totalBlended;
  totalWithOverhead += withOverhead;
  totalTestEstimates += r.testEstimate;

  console.log(
    formatRow(
      [r.name, r.totalBlended, TOTAL_OVERHEAD, withOverhead, r.testEstimate, ratio + 'x', status],
      widths2,
      aligns2
    )
  );
}

console.log(separator(widths2));

const avgRatio = (totalContentTokens / totalTestEstimates).toFixed(2);
console.log(
  formatRow(
    ['TOTALS', totalContentTokens, '-', totalWithOverhead, totalTestEstimates, avgRatio + 'x', ''],
    widths2,
    aligns2
  )
);
console.log('');

// -- Section 3: Per-task breakdown detail --

console.log('SECTION 3: Detailed Per-Task Breakdown');
console.log('-'.repeat(90));

for (const r of results) {
  const inputPct = ((r.inTokB / r.totalBlended) * 100).toFixed(0);
  const outputPct = ((r.outTokB / r.totalBlended) * 100).toFixed(0);
  const overheadPct = ((TOTAL_OVERHEAD / (r.totalBlended + TOTAL_OVERHEAD)) * 100).toFixed(0);

  console.log(`  ${r.name}`);
  console.log(`    Input:    ${r.inChars} chars -> ${r.inTokB} tokens (${inputPct}% of content)`);
  console.log(`    Output:   ${r.outChars} chars -> ${r.outTokB} tokens (${outputPct}% of content)`);
  console.log(`    Content:  ${r.totalBlended} tokens`);
  console.log(`    Overhead: ${TOTAL_OVERHEAD} tokens (${overheadPct}% of total request)`);
  console.log(`    Total:    ${r.totalBlended + TOTAL_OVERHEAD} tokens`);
  console.log(`    Test est: ${r.testEstimate} tokens | Ratio: ${(r.totalBlended / r.testEstimate).toFixed(2)}x`);
  console.log('');
}

// -- Section 4: Summary statistics --

console.log('='.repeat(90));
console.log('  SUMMARY STATISTICS');
console.log('='.repeat(90));
console.log('');

const contentTokensList = results.map((r) => r.totalBlended);
const ratios = results.map((r) => r.totalBlended / r.testEstimate);

const avgContent = (contentTokensList.reduce((a, b) => a + b, 0) / contentTokensList.length).toFixed(0);
const minContent = Math.min(...contentTokensList);
const maxContent = Math.max(...contentTokensList);
const medianContent = [...contentTokensList].sort((a, b) => a - b)[Math.floor(contentTokensList.length / 2)];

const avgRatioVal = (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2);
const minRatio = Math.min(...ratios).toFixed(2);
const maxRatio = Math.max(...ratios).toFixed(2);

const accurate = ratios.filter((r) => r >= 0.8 && r <= 1.2).length;
const overEstimated = ratios.filter((r) => r < 0.8).length;
const underEstimated = ratios.filter((r) => r > 1.2).length;

console.log(`  Tasks measured:           ${results.length}`);
console.log(`  Avg content tokens:       ${avgContent}`);
console.log(`  Min content tokens:       ${minContent} (${results[contentTokensList.indexOf(minContent)].name})`);
console.log(`  Max content tokens:       ${maxContent} (${results[contentTokensList.indexOf(maxContent)].name})`);
console.log(`  Median content tokens:    ${medianContent}`);
console.log('');
console.log(`  Claude Code overhead:     ${TOTAL_OVERHEAD} tokens (fixed per request)`);
console.log(`  Overhead as % of small:   ${((TOTAL_OVERHEAD / (minContent + TOTAL_OVERHEAD)) * 100).toFixed(1)}%`);
console.log(`  Overhead as % of large:   ${((TOTAL_OVERHEAD / (maxContent + TOTAL_OVERHEAD)) * 100).toFixed(1)}%`);
console.log('');
console.log(`  Test estimate accuracy:`);
console.log(`    Avg ratio (actual/est): ${avgRatioVal}x`);
console.log(`    Min ratio:              ${minRatio}x`);
console.log(`    Max ratio:              ${maxRatio}x`);
console.log(`    Accurate (0.8-1.2x):    ${accurate}/${results.length}`);
console.log(`    Over-estimated:         ${overEstimated}/${results.length}`);
console.log(`    Under-estimated:        ${underEstimated}/${results.length}`);
console.log('');

// -- Section 5: Cost estimation --

console.log('='.repeat(90));
console.log('  COST ESTIMATION (at Anthropic pricing)');
console.log('='.repeat(90));
console.log('');

// Claude 3.5 Sonnet pricing
const INPUT_COST_PER_MTK = 3.00;   // $3.00 per 1M input tokens
const OUTPUT_COST_PER_MTK = 15.00;  // $15.00 per 1M output tokens

// Haiku pricing
const HAIKU_INPUT_COST = 0.25;
const HAIKU_OUTPUT_COST = 1.25;

console.log('  Model          | Pricing (per 1M tokens)');
console.log('  ---------------|--------------------------');
console.log(`  Sonnet 3.5     | Input: $${INPUT_COST_PER_MTK.toFixed(2)}  Output: $${OUTPUT_COST_PER_MTK.toFixed(2)}`);
console.log(`  Haiku 3.5      | Input: $${HAIKU_INPUT_COST.toFixed(2)}  Output: $${HAIKU_OUTPUT_COST.toFixed(2)}`);
console.log('');

const headers3 = ['Task', 'In Tok', 'Out Tok', 'Sonnet $', 'Haiku $', 'Savings'];
const widths3 = [22, 8, 8, 10, 10, 9];
const aligns3 = ['left', 'right', 'right', 'right', 'right', 'right'];

console.log(formatRow(headers3, widths3, aligns3));
console.log(separator(widths3));

let totalSonnet = 0;
let totalHaiku = 0;

for (const r of results) {
  const inTokens = r.inTokB + TOTAL_OVERHEAD; // input includes overhead
  const outTokens = r.outTokB;

  const sonnetCost = (inTokens * INPUT_COST_PER_MTK + outTokens * OUTPUT_COST_PER_MTK) / 1_000_000;
  const haikuCost = (inTokens * HAIKU_INPUT_COST + outTokens * HAIKU_OUTPUT_COST) / 1_000_000;
  const savings = ((1 - haikuCost / sonnetCost) * 100).toFixed(0);

  totalSonnet += sonnetCost;
  totalHaiku += haikuCost;

  console.log(
    formatRow(
      [
        r.name,
        inTokens,
        outTokens,
        '$' + sonnetCost.toFixed(5),
        '$' + haikuCost.toFixed(5),
        savings + '%',
      ],
      widths3,
      aligns3
    )
  );
}

console.log(separator(widths3));
console.log(
  formatRow(
    [
      'TOTAL (9 tasks)',
      '-',
      '-',
      '$' + totalSonnet.toFixed(5),
      '$' + totalHaiku.toFixed(5),
      ((1 - totalHaiku / totalSonnet) * 100).toFixed(0) + '%',
    ],
    widths3,
    aligns3
  )
);

console.log('');
console.log(`  At 100 requests/day using Sonnet:  $${(totalSonnet / results.length * 100).toFixed(4)}/day`);
console.log(`  At 100 requests/day using Haiku:   $${(totalHaiku / results.length * 100).toFixed(4)}/day`);
console.log(`  Monthly savings (Haiku vs Sonnet): $${((totalSonnet - totalHaiku) / results.length * 100 * 30).toFixed(2)}/month`);
console.log('');

// -- Section 6: Key takeaways --

console.log('='.repeat(90));
console.log('  KEY TAKEAWAYS');
console.log('='.repeat(90));
console.log('');
console.log('  1. Claude Code overhead (~' + TOTAL_OVERHEAD + ' tokens) dominates small tasks.');
console.log('     For a format_conversion task, overhead is ' +
  ((TOTAL_OVERHEAD / (results.find(r => r.name === 'format_conversion').totalBlended + TOTAL_OVERHEAD)) * 100).toFixed(0) +
  '% of total tokens.');
console.log('');
console.log('  2. Content tokens range from ' + minContent + ' to ' + maxContent + ' --');
console.log('     a ' + (maxContent / minContent).toFixed(1) + 'x spread across task types.');
console.log('');
console.log('  3. The char-based heuristic (/3.5) tends to give higher estimates');
console.log('     for code, while word-based (x1.3) is lower. Blended splits');
console.log('     the difference for a more reliable middle ground.');
console.log('');
console.log('  4. Test estimates vs measured:');
if (overEstimated > accurate) {
  console.log('     Our test estimates tend to OVER-estimate actual token counts.');
  console.log('     This is conservative (safe) but may affect cost projections.');
} else if (underEstimated > accurate) {
  console.log('     Our test estimates tend to UNDER-estimate actual token counts.');
  console.log('     This means real costs may be higher than projected.');
} else {
  console.log('     Most estimates are within 20% of measured values -- good calibration.');
}
console.log('');
console.log('  5. For delegation decisions, the overhead-inclusive total is what');
console.log('     matters. Simple tasks (boilerplate, format_conversion) have');
console.log('     90%+ overhead -- perfect candidates for smaller/cheaper models.');
console.log('');
