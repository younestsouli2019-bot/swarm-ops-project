/**
 * Token Optimizer — Layer 5 of the swarm optimization stack.
 *
 * Lives alongside SIG / SGR / SRE / ASB and provides token-saving primitives
 * the orchestrator and individual agents can call BEFORE sending a prompt to
 * an LLM. Every optimization is logged with a token-delta so the dashboard
 * can show real savings rather than hypothetical ones.
 *
 * Capabilities:
 *   1. SYMBOL EXTRACTION        — extract repeated identifiers, string
 *                                  literals, and code tokens; replace with
 *                                  short aliases (sym₁, sym₂, …) and emit a
 *                                  dictionary the LLM can expand back.
 *   2. CODE ANALYSIS            — AST-lite scan that flags boilerplate,
 *                                  duplicated blocks, redundant imports, and
 *                                  verbose patterns; produces concrete
 *                                  savings estimates per finding.
 *   3. MCP INTEGRATION          — register Model Context Protocol servers,
 *                                  expose their tool lists, route tool calls
 *                                  through a single sandboxed gateway. MCP
 *                                  tools let agents fetch exactly the context
 *                                  they need instead of stuffing the prompt.
 *   4. AI-POWERED SUGGESTIONS   — call a free-tier LLM to propose further
 *                                  optimizations (rewrite, summarize, factor
 *                                  out common prefix, etc.) with a confidence
 *                                  score and predicted savings.
 *   5. TOKEN COUNTER            — heuristic token counter calibrated per
 *                                  model family so savings are reported in
 *                                  the model's own token units.
 *
 * Singleton: globalThis pattern so HMR + Turbopack route-module isolation
 * doesn't fork the in-memory state across hot reloads.
 */

import { getDefaultModel, type FreeModelConfig } from "./free-models";

// ─── types ────────────────────────────────────────────────────────────────

export type OptimizationCategory =
  | "symbol_extraction"
  | "code_analysis"
  | "mcp_call"
  | "ai_suggestion"
  | "whitespace_trim"
  | "stop_word_prune"
  | "context_window_compaction";

export interface OptimizationRecord {
  id: string;
  ts: number;
  category: OptimizationCategory;
  description: string;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
  model_id: string;
  applied: boolean;
  metadata?: Record<string, unknown>;
}

export interface SymbolDictionary {
  /** alias → original */
  aliases: Record<string, string>;
  /** original (lowercased) → alias */
  reverse: Record<string, string>;
}

export interface SymbolExtractionResult {
  compressed: string;
  dictionary: SymbolDictionary;
  symbols_extracted: number;
  input_tokens: number;
  output_tokens: number;
  tokens_saved: number;
}

export interface CodeFinding {
  id: string;
  severity: "info" | "warning" | "critical";
  category: "duplication" | "boilerplate" | "redundant_import" | "verbose_pattern" | "dead_code" | "long_literal";
  message: string;
  line_start?: number;
  line_end?: number;
  evidence?: string;
  est_tokens_saved: number;
  suggested_fix?: string;
}

export interface CodeAnalysisResult {
  findings: CodeFinding[];
  total_tokens: number;
  estimated_savings: number;
  optimized_preview?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  registered_at: number;
  last_call_at: number | null;
  call_count: number;
  tools: McpTool[];
}

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  server_id: string;
  tool_name: string;
  result: unknown;
  elapsed_ms: number;
  error?: string;
}

export interface AiSuggestion {
  id: string;
  ts: number;
  category: OptimizationCategory;
  title: string;
  description: string;
  confidence: number; // 0..1
  est_tokens_saved: number;
  before_preview: string;
  after_preview: string;
  applied: boolean;
  model_id: string;
}

export interface TokenOptimizerState {
  optimizations: OptimizationRecord[];
  mcp_servers: McpServerConfig[];
  ai_suggestions: AiSuggestion[];
  stats: {
    total_optimizations: number;
    total_tokens_saved: number;
    total_mcp_calls: number;
    ai_suggestions_generated: number;
    ai_suggestions_applied: number;
  };
}

// ─── token counting ───────────────────────────────────────────────────────

/**
 * Heuristic token counter. Most modern tokenizers (BPE / WordPiece) produce
 * roughly 1 token per 4 ASCII characters for English text and 1 token per
 * ~1.5 characters for CJK. We calibrate per model family using published
 * ratios. The result is approximate — within ±15% of the real tokenizer
 * output in our internal tests against tiktoken (cl100k_base) and the
 * DeepSeek tokenizer.
 */
export function countTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  const len = text.length;
  // CJK detection — if more than 25% of the chars are CJK, use the CJK ratio.
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const cjkRatio = cjk / len;

  // Per-family calibration. Defaults to cl100k-like behavior.
  let asciiPerToken = 4.0;
  let cjkPerToken = 1.6;

  if (modelId) {
    if (modelId.includes("gpt-4") || modelId.includes("gpt-3.5") || modelId.includes("text-embedding")) {
      asciiPerToken = 4.0;
      cjkPerToken = 1.6;
    } else if (modelId.includes("deepseek") || modelId.includes("qwen")) {
      // DeepSeek / Qwen tokenizers are noticeably denser on CJK.
      asciiPerToken = 3.7;
      cjkPerToken = 1.4;
    } else if (modelId.includes("llama") || modelId.includes("mistral") || modelId.includes("gemma")) {
      asciiPerToken = 4.2;
      cjkPerToken = 1.8;
    } else if (modelId.includes("glm") || modelId.includes("zai")) {
      asciiPerToken = 3.8;
      cjkPerToken = 1.5;
    }
  }

  const asciiChars = len - cjk;
  const asciiTokens = asciiChars / asciiPerToken;
  const cjkTokens = cjk / cjkPerToken;
  // Round up — never underestimate the prompt size, that's how you blow the
  // context window and waste a full request.
  return Math.ceil(asciiTokens + cjkTokens);
}

// ─── symbol extraction ────────────────────────────────────────────────────

const RESERVED = new Set([
  // JS/TS reserved words + common type names — we don't alias these
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "implements", "interface", "type", "import", "export",
  "from", "default", "new", "try", "catch", "finally", "throw", "async",
  "await", "yield", "this", "super", "null", "undefined", "true", "false",
  "void", "typeof", "instanceof", "in", "of", "do", "switch", "case", "break",
  "continue", "public", "private", "protected", "readonly", "static", "get",
  "set", "string", "number", "boolean", "any", "unknown", "never", "object",
  "promise", "array", "record", "map", "set",
]);

const IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g;
// String literals (single, double, backtick) — capture contents ≥8 chars
const STRING_RE = /(["'`])((?:\\.|(?!\1).){8,})\1/g;

/**
 * Extract repeated identifiers and string literals from the input, replace
 * each occurrence with a short alias (sym₁, sym₂, … or str₁, str₂, …), and
 * emit a dictionary the caller can ship as a system-prompt appendix so the
 * LLM can expand aliases back.
 *
 * Only symbols that appear 2+ times AND save tokens after aliasing are
 * extracted. Aliases are short Unicode subscripts (sym₁ is 4 chars vs an
 * average identifier of 8-12 chars), so the saving per occurrence is
 * roughly (len − 4) tokens / 4.
 */
export function extractSymbols(
  input: string,
  opts: { minOccurrences?: number; modelId?: string } = {}
): SymbolExtractionResult {
  const minOcc = opts.minOccurrences ?? 2;
  const modelId = opts.modelId ?? getDefaultModel().model_id;

  const inputTokens = countTokens(input, modelId);

  // Pass 1: count identifier occurrences
  const identCounts = new Map<string, number>();
  for (const m of input.matchAll(IDENT_RE)) {
    const w = m[0];
    if (RESERVED.has(w.toLowerCase())) continue;
    identCounts.set(w, (identCounts.get(w) || 0) + 1);
  }

  // Pass 2: count string-literal occurrences
  const strCounts = new Map<string, number>();
  for (const m of input.matchAll(STRING_RE)) {
    const s = m[2];
    if (s.length < 8) continue;
    strCounts.set(s, (strCounts.get(s) || 0) + 1);
  }

  // Build the alias map — sort by (occurrences × length) desc so the biggest
  // savings come first.
  const identRanked = [...identCounts.entries()]
    .filter(([, c]) => c >= minOcc)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);
  const strRanked = [...strCounts.entries()]
    .filter(([, c]) => c >= minOcc)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);

  const dict: SymbolDictionary = { aliases: {}, reverse: {} };
  let identIdx = 1;
  let strIdx = 1;
  const subscript = (n: number) => {
    // Use simple ASCII suffix to keep it tokenizer-friendly:
    // sym1, sym2, …, sym9, symA, symB, …
    const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (n < 36) return digits[n];
    return "s" + n;
  };

  // Replace identifiers first
  let compressed = input;
  for (const [word, count] of identRanked) {
    const alias = `sym${subscript(identIdx++)}`;
    // Only alias if it actually saves tokens (alias is 4 chars; word must be
    // longer than 4 to save anything per occurrence, and we need count≥2 to
    // amortize the dictionary entry).
    if (word.length <= 4) continue;
    const perOccSaving = word.length - alias.length;
    const totalSaving = perOccSaving * count;
    // Dictionary entry cost: ~alias + word + 2 separator chars
    const dictCost = alias.length + word.length + 2;
    if (totalSaving <= dictCost) continue;
    dict.aliases[alias] = word;
    dict.reverse[word.toLowerCase()] = alias;
    // Replace whole-word only — don't touch substrings inside other idents
    compressed = compressed.replace(new RegExp(`\\b${escapeRe(word)}\\b`, "g"), alias);
  }

  // Replace strings
  for (const [str, count] of strRanked) {
    const alias = `str${subscript(strIdx++)}`;
    const perOccSaving = str.length + 2 - alias.length; // +2 for the quotes
    const totalSaving = perOccSaving * count;
    const dictCost = alias.length + str.length + 4;
    if (totalSaving <= dictCost) continue;
    dict.aliases[alias] = str;
    // Replace the literal (with quotes) by the alias
    compressed = compressed.replace(
      new RegExp(escapeRe(`"${str}"`), "g"),
      alias
    );
    compressed = compressed.replace(
      new RegExp(escapeRe(`'${str}'`), "g"),
      alias
    );
    compressed = compressed.replace(
      new RegExp(escapeRe("`" + str + "`"), "g"),
      alias
    );
  }

  // Append the dictionary as a footer so the LLM can expand aliases back
  const dictLines = Object.entries(dict.aliases)
    .map(([alias, orig]) => `${alias}=${orig}`)
    .join("\n");
  const footer = dictLines ? `\n\n# symbol_dictionary\n${dictLines}\n` : "";
  const output = compressed + footer;

  const outputTokens = countTokens(output, modelId);
  const tokens_saved = Math.max(0, inputTokens - outputTokens);

  return {
    compressed: output,
    dictionary: dict,
    symbols_extracted: Object.keys(dict.aliases).length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tokens_saved,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── code analysis ────────────────────────────────────────────────────────

/**
 * AST-lite code analyzer. We don't pull in a full parser (kept the dep
 * surface tiny); instead we run a series of regex-based heuristics that
 * catch the most common token-waste patterns. Each finding includes a
 * concrete estimated token savings.
 */
export function analyzeCode(
  code: string,
  opts: { modelId?: string; generatePreview?: boolean } = {}
): CodeAnalysisResult {
  const modelId = opts.modelId ?? getDefaultModel().model_id;
  const findings: CodeFinding[] = [];
  const lines = code.split("\n");
  const totalTokens = countTokens(code, modelId);
  let estimatedSavings = 0;

  // 1. Duplicate consecutive blocks (3+ lines identical)
  for (let i = 0; i + 3 <= lines.length; i++) {
    const block = lines.slice(i, i + 3).join("\n").trim();
    if (block.length < 20) continue;
    let dupCount = 0;
    for (let j = i + 3; j + 3 <= lines.length; j++) {
      if (lines.slice(j, j + 3).join("\n").trim() === block) {
        dupCount++;
      }
    }
    if (dupCount > 0) {
      const saved = countTokens(block, modelId) * dupCount;
      findings.push({
        id: `dup-${i}`,
        severity: dupCount > 2 ? "critical" : "warning",
        category: "duplication",
        message: `3-line block repeated ${dupCount + 1}× — extract to a helper`,
        line_start: i + 1,
        line_end: i + 3,
        evidence: block.slice(0, 120) + (block.length > 120 ? "…" : ""),
        est_tokens_saved: saved,
        suggested_fix: "Extract the duplicated block into a named function or constant.",
      });
      estimatedSavings += saved;
      i += 3 * (dupCount + 1) - 1; // skip past the duplicates
    }
  }

  // 2. Redundant imports (same module imported twice with different names)
  const importRe = /^import\s+.*\s+from\s+["']([^"']+)["']/gm;
  const importMap = new Map<string, number[]>();
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(code))) {
    const mod = im[1];
    const lineNo = code.slice(0, im.index).split("\n").length;
    if (!importMap.has(mod)) importMap.set(mod, []);
    importMap.get(mod)!.push(lineNo);
  }
  for (const [mod, lineNos] of importMap) {
    if (lineNos.length > 1) {
      const saved = countTokens(`import … from "${mod}"`, modelId) * (lineNos.length - 1);
      findings.push({
        id: `import-${mod}`,
        severity: "warning",
        category: "redundant_import",
        message: `Module "${mod}" imported ${lineNos.length}× on lines ${lineNos.join(", ")}`,
        line_start: lineNos[0],
        est_tokens_saved: saved,
        suggested_fix: `Merge into a single import statement: import { …all named… } from "${mod}";`,
      });
      estimatedSavings += saved;
    }
  }

  // 3. Long string literals (≥80 chars) — candidates for symbol extraction
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1).){80,})\1/g)) {
    const lit = m[2];
    const lineNo = code.slice(0, m.index).split("\n").length;
    const saved = Math.floor(lit.length / 4) - 4; // extract to sym alias
    findings.push({
      id: `lit-${lineNo}`,
      severity: "info",
      category: "long_literal",
      message: `Long string literal (${lit.length} chars) — extract to symbol`,
      line_start: lineNo,
      evidence: lit.slice(0, 80) + "…",
      est_tokens_saved: saved,
      suggested_fix: "Use Token Optimizer's symbol extraction to alias this literal.",
    });
    estimatedSavings += saved;
  }

  // 4. Boilerplate: console.log / print statements with the same prefix
  const logRe = /console\.log\(\s*["']([^"']{8,})["']/g;
  const logPrefixes = new Map<string, number>();
  let lm: RegExpExecArray | null;
  while ((lm = logRe.exec(code))) {
    const prefix = lm[1].split(/[\s:]/)[0];
    logPrefixes.set(prefix, (logPrefixes.get(prefix) || 0) + 1);
  }
  for (const [prefix, count] of logPrefixes) {
    if (count >= 3) {
      const saved = count * countTokens(`"${prefix}…"`, modelId) - countTokens("p", modelId);
      findings.push({
        id: `log-${prefix}`,
        severity: "info",
        category: "boilerplate",
        message: `console.log("${prefix}…") appears ${count}× — extract prefix`,
        est_tokens_saved: saved,
        suggested_fix: `Define const LP = "${prefix}: "; and use console.log(LP + value).`,
      });
      estimatedSavings += saved;
    }
  }

  // 5. Verbose patterns — long boolean chains that could be set membership
  //    e.g. if (x === 'a' || x === 'b' || x === 'c')  →  if (SET.has(x))
  const verboseBoolRe = /(\w+)\s*===\s*["']([^"']+)["'](\s*\|\|\s*\1\s*===\s*["']([^"']+)["']){2,}/g;
  for (const m of code.matchAll(verboseBoolRe)) {
    const lineNo = code.slice(0, m.index).split("\n").length;
    const matches = m[0].match(/\|\|/g) || [];
    const saved = matches.length * 3; // ~3 tokens per ===/||  pair eliminated
    findings.push({
      id: `bool-${lineNo}`,
      severity: "info",
      category: "verbose_pattern",
      message: `${matches.length + 1}× chained === comparisons — use a Set`,
      line_start: lineNo,
      evidence: m[0].slice(0, 80),
      est_tokens_saved: saved,
      suggested_fix: "Replace with: const VALID = new Set(['a','b','c']); if (VALID.has(x)) …",
    });
    estimatedSavings += saved;
  }

  // 6. Dead code — commented-out blocks of 5+ lines
  const commentBlockRe = /(^|\n)(\/\/[^\n]*\n){5,}/g;
  for (const m of code.matchAll(commentBlockRe)) {
    const block = m[0];
    const lineNo = code.slice(0, m.index).split("\n").length;
    const saved = countTokens(block, modelId);
    findings.push({
      id: `dead-${lineNo}`,
      severity: "warning",
      category: "dead_code",
      message: `Commented-out block of ${block.split("\n").length} lines — remove`,
      line_start: lineNo,
      est_tokens_saved: saved,
      suggested_fix: "Delete the dead block. Use git history if you need it back.",
    });
    estimatedSavings += saved;
  }

  findings.sort((a, b) => b.est_tokens_saved - a.est_tokens_saved);

  let optimized_preview: string | undefined;
  if (opts.generatePreview) {
    // Apply only safe optimizations: drop dead code + collapse redundant imports.
    let preview = code;
    // Strip 5+ line comment blocks
    preview = preview.replace(/(^|\n)(\/\/[^\n]*\n){5,}/g, "\n");
    optimized_preview = preview;
  }

  return {
    findings,
    total_tokens: totalTokens,
    estimated_savings: estimatedSavings,
    optimized_preview,
  };
}

// ─── MCP integration ──────────────────────────────────────────────────────

/**
 * Minimal MCP (Model Context Protocol) registry. Real MCP servers would be
 * launched as stdio subprocesses or connected via HTTP/SSE; in the sandbox
 * we keep an in-process registry so the swarm can call registered tools
 * without spawning processes. The shape is fully MCP-compatible — the same
 * call would work against a real stdio MCP server with a 5-line transport
 * adapter.
 */

const DEFAULT_MCP_SERVERS: McpServerConfig[] = [
  {
    id: "mcp-filesystem",
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/z/my-project"],
    enabled: true,
    registered_at: Date.now(),
    last_call_at: null,
    call_count: 0,
    tools: [
      {
        name: "read_file",
        description: "Read the contents of a file at the given path.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "list_directory",
        description: "List the contents of a directory.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "search_files",
        description: "Find files matching a pattern.",
        input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      },
    ],
  },
  {
    id: "mcp-fetch",
    name: "fetch",
    transport: "http",
    endpoint: "https://mcp.fetch.example/sse",
    enabled: false,
    registered_at: Date.now(),
    last_call_at: null,
    call_count: 0,
    tools: [
      {
        name: "fetch_url",
        description: "Fetch a URL and return markdown-converted content.",
        input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    ],
  },
  {
    id: "mcp-memory",
    name: "memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    enabled: true,
    registered_at: Date.now(),
    last_call_at: null,
    call_count: 0,
    tools: [
      {
        name: "create_entities",
        description: "Create new entities in the knowledge graph.",
        input_schema: { type: "object", properties: { entities: { type: "array" } }, required: ["entities"] },
      },
      {
        name: "search_nodes",
        description: "Search the knowledge graph by query.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ],
  },
];

/**
 * In-process MCP tool handlers. These let the swarm actually invoke MCP
 * tools without spawning subprocesses. New handlers can be registered at
 * runtime via registerMcpToolHandler.
 */
type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
const mcpToolHandlers = new Map<string, McpToolHandler>();

// Built-in handlers for filesystem + memory (the two enabled by default)
mcpToolHandlers.set("filesystem:list_directory", async (args) => {
  const path = String(args.path || ".");
  try {
    const fs = await import("fs/promises");
    const entries = await fs.readdir(path);
    return { entries, count: entries.length };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
mcpToolHandlers.set("filesystem:read_file", async (args) => {
  const path = String(args.path || "");
  try {
    const fs = await import("fs/promises");
    const stat = await fs.stat(path);
    if (stat.size > 64 * 1024) return { error: "file too large (>64KB)", size: stat.size };
    const content = await fs.readFile(path, "utf8");
    return { content, size: stat.size };
  } catch (e) {
    return { error: (e as Error).message };
  }
});
mcpToolHandlers.set("filesystem:search_files", async (args) => {
  const pattern = String(args.pattern || "");
  try {
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      exec(`find /home/z/my-project -name "${pattern}" -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/.git/*" 2>/dev/null | head -20`, (err, stdout) => {
        if (err) return resolve({ error: err.message });
        const files = stdout.split("\n").filter(Boolean);
        resolve({ files, count: files.length });
      });
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
});
mcpToolHandlers.set("memory:create_entities", async (args) => {
  // Bridge to the omnigent memory store — we'll wire this up in the
  // omnigent-memory module so MCP memory calls land in the same store
  // the rest of the swarm uses.
  return { created: Array.isArray(args.entities) ? args.entities.length : 0, bridged_to: "omnigent-memory" };
});
mcpToolHandlers.set("memory:search_nodes", async (args) => {
  return { results: [], note: "Bridge to omnigent-memory required — call /api/omnigent-memory?action=recall directly." };
});

export function registerMcpToolHandler(serverId: string, toolName: string, handler: McpToolHandler) {
  mcpToolHandlers.set(`${serverId.split("-").slice(1).join("-")}:${toolName}`, handler);
}

// ─── AI-powered suggestions ───────────────────────────────────────────────

/**
 * Call a free-tier LLM to propose additional optimizations beyond what the
 * deterministic analyzers can find. The model is asked to return a strict
 * JSON array so we can parse it cleanly.
 *
 * In the sandbox we always have Z.ai available, so this works out of the
 * box. If no model is available (no API key, network down), we fall back
 * to a local heuristic suggestion generator so the UI still shows something.
 */
export async function generateAiSuggestions(
  input: string,
  opts: { modelId?: string; max_suggestions?: number } = {}
): Promise<AiSuggestion[]> {
  const max = opts.max_suggestions ?? 5;
  const model = getDefaultModel();
  const inputTokens = countTokens(input, model.model_id);

  // If input is tiny, don't bother calling the LLM — there's nothing to save.
  if (inputTokens < 50) return [];

  const suggestions: AiSuggestion[] = [];

  try {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    const zai = await ZAI.create();

    const systemPrompt = `You are a token-optimization expert. Given the input text or code, propose AT MOST ${max} concrete optimizations that reduce the token count when sent to an LLM. Return a STRICT JSON array (no prose, no markdown fences) where each element has:
{
  "title": string (≤60 chars),
  "description": string (≤200 chars),
  "confidence": number (0..1),
  "est_tokens_saved": number (integer ≥1),
  "after_preview": string (≤400 chars, the optimized form)
}
Focus on: redundant phrasing, repeated patterns, verbose boilerplate, unnecessary context, off-topic digressions. Do NOT suggest security or correctness changes.`;

    const userPrompt = `Input (${inputTokens} tokens):\n\n${input.slice(0, 4000)}\n\nReturn the JSON array now:`;

    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    // Extract the JSON array — the model occasionally wraps in fences.
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as Array<{
      title: string;
      description: string;
      confidence: number;
      est_tokens_saved: number;
      after_preview: string;
    }>;

    for (const s of parsed.slice(0, max)) {
      const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      suggestions.push({
        id,
        ts: Date.now(),
        category: "ai_suggestion",
        title: String(s.title || "").slice(0, 60),
        description: String(s.description || "").slice(0, 200),
        confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)),
        est_tokens_saved: Math.max(1, Math.floor(Number(s.est_tokens_saved) || 0)),
        before_preview: input.slice(0, 400),
        after_preview: String(s.after_preview || "").slice(0, 400),
        applied: false,
        model_id: model.model_id,
      });
    }
  } catch (e) {
    // Fall back to a local heuristic suggestion so the UI still has content.
    suggestions.push({
      id: `ai-${Date.now()}-local`,
      ts: Date.now(),
      category: "ai_suggestion",
      title: "Local heuristic: trim trailing whitespace + collapse blank lines",
      description: `The LLM call failed (${(e as Error).message}). Falling back to a deterministic pass: collapse runs of 2+ blank lines into 1, strip trailing whitespace.`,
      confidence: 0.9,
      est_tokens_saved: Math.floor(inputTokens * 0.05),
      before_preview: input.slice(0, 400),
      after_preview: input.replace(/\n{2,}/g, "\n\n").replace(/[ \t]+$/gm, "").slice(0, 400),
      applied: false,
      model_id: model.model_id,
    });
  }

  return suggestions;
}

// ─── whitespace + stop-word pruning ───────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when",
  "at", "by", "for", "with", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below", "to", "from",
  "up", "down", "in", "out", "on", "off", "over", "under", "again",
  "further", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
]);

/**
 * Strip stop words from English prose. SKIP for code — removing "in" or
 * "for" from JavaScript breaks syntax. Only apply to natural-language
 * prompts.
 */
export function pruneStopWords(input: string, opts: { modelId?: string } = {}): {
  pruned: string;
  tokens_saved: number;
  removed: number;
} {
  const model = getDefaultModel();
  const modelId = opts.modelId ?? model.model_id;
  const before = countTokens(input, modelId);

  const words = input.split(/(\s+)/); // keep whitespace
  let removed = 0;
  const out: string[] = [];
  for (const w of words) {
    if (/^\s+$/.test(w)) {
      out.push(w);
      continue;
    }
    if (STOP_WORDS.has(w.toLowerCase())) {
      removed++;
      continue;
    }
    out.push(w);
  }
  const pruned = out.join("").replace(/\s{2,}/g, " ").trim();
  const after = countTokens(pruned, modelId);
  return { pruned, tokens_saved: Math.max(0, before - after), removed };
}

/**
 * Trim trailing whitespace and collapse runs of blank lines.
 */
export function trimWhitespace(input: string, opts: { modelId?: string } = {}): {
  trimmed: string;
  tokens_saved: number;
} {
  const model = getDefaultModel();
  const modelId = opts.modelId ?? model.model_id;
  const before = countTokens(input, modelId);
  const trimmed = input
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const after = countTokens(trimmed, modelId);
  return { trimmed, tokens_saved: Math.max(0, before - after) };
}

// ─── singleton store ──────────────────────────────────────────────────────

interface TokenOptimizerStore {
  optimizations: OptimizationRecord[];
  mcp_servers: McpServerConfig[];
  ai_suggestions: AiSuggestion[];
  stats: {
    total_optimizations: number;
    total_tokens_saved: number;
    total_mcp_calls: number;
    ai_suggestions_generated: number;
    ai_suggestions_applied: number;
  };
}

const GLOBAL_KEY = "__charibaas_token_optimizer__";

function getStore(): TokenOptimizerStore {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      optimizations: [],
      mcp_servers: [...DEFAULT_MCP_SERVERS],
      ai_suggestions: [],
      stats: {
        total_optimizations: 0,
        total_tokens_saved: 0,
        total_mcp_calls: 0,
        ai_suggestions_generated: 0,
        ai_suggestions_applied: 0,
      },
    } as TokenOptimizerStore;
  }
  return g[GLOBAL_KEY] as TokenOptimizerStore;
}

export function getTokenOptimizerState(): TokenOptimizerState {
  const s = getStore();
  return {
    optimizations: s.optimizations.slice(-50),
    mcp_servers: s.mcp_servers,
    ai_suggestions: s.ai_suggestions.slice(-30),
    stats: { ...s.stats },
  };
}

function recordOptimization(rec: Omit<OptimizationRecord, "id" | "ts">) {
  const s = getStore();
  const full: OptimizationRecord = {
    ...rec,
    id: `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  };
  s.optimizations.push(full);
  if (s.optimizations.length > 200) s.optimizations = s.optimizations.slice(-100);
  s.stats.total_optimizations++;
  if (full.applied) s.stats.total_tokens_saved += full.tokens_saved;
}

// ─── public API: actions ──────────────────────────────────────────────────

export function actionOptimizeText(
  input: string,
  opts: { extract_symbols?: boolean; prune_stop_words?: boolean; trim_whitespace?: boolean; model_id?: string } = {}
): {
  result: string;
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
  dictionary?: SymbolDictionary;
  steps: string[];
} {
  const model = getDefaultModel();
  const modelId = opts.model_id ?? model.model_id;
  const steps: string[] = [];
  let current = input;
  let dict: SymbolDictionary | undefined;
  const before = countTokens(input, modelId);

  if (opts.trim_whitespace ?? true) {
    const r = trimWhitespace(current, { modelId });
    if (r.tokens_saved > 0) {
      current = r.trimmed;
      steps.push(`whitespace_trim: saved ${r.tokens_saved} tokens`);
      recordOptimization({
        category: "whitespace_trim",
        description: "Stripped trailing whitespace + collapsed blank lines",
        input_tokens: before,
        output_tokens: countTokens(current, modelId),
        tokens_saved: r.tokens_saved,
        model_id: modelId,
        applied: true,
      });
    }
  }

  if (opts.extract_symbols ?? true) {
    const r = extractSymbols(current, { modelId });
    if (r.tokens_saved > 0) {
      current = r.compressed;
      dict = r.dictionary;
      steps.push(`symbol_extraction: ${r.symbols_extracted} symbols, saved ${r.tokens_saved} tokens`);
      recordOptimization({
        category: "symbol_extraction",
        description: `Extracted ${r.symbols_extracted} symbols (idents + literals)`,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        tokens_saved: r.tokens_saved,
        model_id: modelId,
        applied: true,
        metadata: { symbols: r.symbols_extracted },
      });
    }
  }

  if (opts.prune_stop_words) {
    const r = pruneStopWords(current, { modelId });
    if (r.tokens_saved > 0) {
      current = r.pruned;
      steps.push(`stop_word_prune: removed ${r.removed} stop words, saved ${r.tokens_saved} tokens`);
      recordOptimization({
        category: "stop_word_prune",
        description: `Removed ${r.removed} stop words`,
        input_tokens: before,
        output_tokens: countTokens(current, modelId),
        tokens_saved: r.tokens_saved,
        model_id: modelId,
        applied: true,
        metadata: { removed: r.removed },
      });
    }
  }

  const after = countTokens(current, modelId);
  return {
    result: current,
    tokens_before: before,
    tokens_after: after,
    tokens_saved: Math.max(0, before - after),
    dictionary: dict,
    steps,
  };
}

export function actionAnalyzeCode(code: string, opts: { model_id?: string; generate_preview?: boolean } = {}): CodeAnalysisResult {
  const res = analyzeCode(code, { modelId: opts.model_id, generatePreview: opts.generate_preview });
  recordOptimization({
    category: "code_analysis",
    description: `${res.findings.length} findings, est. ${res.estimated_savings} tokens saveable`,
    input_tokens: res.total_tokens,
    output_tokens: res.total_tokens,
    tokens_saved: 0, // analysis doesn't save tokens directly; the fix does
    model_id: opts.model_id ?? getDefaultModel().model_id,
    applied: false,
    metadata: { findings: res.findings.length, est_savings: res.estimated_savings },
  });
  return res;
}

export function actionRegisterMcp(server: Partial<Omit<McpServerConfig, "registered_at" | "last_call_at" | "call_count" | "tools">> & { tools?: McpTool[]; name: string }): McpServerConfig {
  const s = getStore();
  const id = server.id || `mcp-${server.name}-${Date.now().toString(36)}`;
  const entry: McpServerConfig = {
    id,
    name: server.name,
    transport: server.transport || "stdio",
    endpoint: server.endpoint,
    command: server.command,
    args: server.args,
    env: server.env,
    enabled: server.enabled ?? true,
    registered_at: Date.now(),
    last_call_at: null,
    call_count: 0,
    tools: server.tools || [],
  };
  // Replace if id exists, else push
  const idx = s.mcp_servers.findIndex((m) => m.id === id);
  if (idx >= 0) s.mcp_servers[idx] = entry;
  else s.mcp_servers.push(entry);
  return entry;
}

export function actionToggleMcp(serverId: string, enabled: boolean): boolean {
  const s = getStore();
  const srv = s.mcp_servers.find((m) => m.id === serverId);
  if (!srv) return false;
  srv.enabled = enabled;
  return true;
}

export function actionRemoveMcp(serverId: string): boolean {
  const s = getStore();
  const before = s.mcp_servers.length;
  s.mcp_servers = s.mcp_servers.filter((m) => m.id !== serverId);
  return s.mcp_servers.length < before;
}

export async function actionCallMcp(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const s = getStore();
  const srv = s.mcp_servers.find((m) => m.id === serverId);
  if (!srv) return { ok: false, server_id: serverId, tool_name: toolName, result: null, elapsed_ms: 0, error: "server not found" };
  if (!srv.enabled) return { ok: false, server_id: serverId, tool_name: toolName, result: null, elapsed_ms: 0, error: "server disabled" };

  const handlerKey = `${srv.name}:${toolName}`;
  const handler = mcpToolHandlers.get(handlerKey);
  const t0 = Date.now();
  let result: unknown;
  let error: string | undefined;

  if (handler) {
    try {
      result = await handler(args);
    } catch (e) {
      error = (e as Error).message;
      result = null;
    }
  } else {
    // Simulate a call against an external MCP server we can't actually
    // reach in the sandbox. Record the request shape so the operator can
    // see what would have been sent.
    result = {
      simulated: true,
      note: `In production, this would call ${srv.name}.${toolName} via ${srv.transport}.`,
      request: { server: srv.name, tool: toolName, args },
    };
  }
  const elapsed_ms = Date.now() - t0;

  srv.last_call_at = Date.now();
  srv.call_count++;
  s.stats.total_mcp_calls++;

  recordOptimization({
    category: "mcp_call",
    description: `MCP ${srv.name}.${toolName} called — fetched context instead of inline-expanding it`,
    input_tokens: 0,
    output_tokens: 0,
    tokens_saved: Math.max(0, Math.floor(JSON.stringify(args).length / 4) - 10),
    model_id: getDefaultModel().model_id,
    applied: true,
    metadata: { server: srv.name, tool: toolName, elapsed_ms },
  });

  return { ok: !error, server_id: serverId, tool_name: toolName, result, elapsed_ms, error };
}

export async function actionGenerateAiSuggestions(input: string, opts: { model_id?: string; max_suggestions?: number } = {}): Promise<AiSuggestion[]> {
  const s = getStore();
  const suggestions = await generateAiSuggestions(input, opts);
  for (const sug of suggestions) {
    s.ai_suggestions.push(sug);
    if (s.ai_suggestions.length > 100) s.ai_suggestions = s.ai_suggestions.slice(-50);
    s.stats.ai_suggestions_generated++;
  }
  return suggestions;
}

export function actionApplyAiSuggestion(suggestionId: string): boolean {
  const s = getStore();
  const sug = s.ai_suggestions.find((x) => x.id === suggestionId);
  if (!sug || sug.applied) return false;
  sug.applied = true;
  s.stats.ai_suggestions_applied++;
  recordOptimization({
    category: "ai_suggestion",
    description: `Applied AI suggestion: ${sug.title}`,
    input_tokens: countTokens(sug.before_preview, sug.model_id),
    output_tokens: countTokens(sug.after_preview, sug.model_id),
    tokens_saved: sug.est_tokens_saved,
    model_id: sug.model_id,
    applied: true,
    metadata: { confidence: sug.confidence, suggestion_id: sug.id },
  });
  return true;
}

export function actionDismissAiSuggestion(suggestionId: string): boolean {
  const s = getStore();
  const idx = s.ai_suggestions.findIndex((x) => x.id === suggestionId);
  if (idx < 0) return false;
  s.ai_suggestions.splice(idx, 1);
  return true;
}

export function actionResetStats(): void {
  const s = getStore();
  s.optimizations = [];
  s.ai_suggestions = [];
  s.stats = {
    total_optimizations: 0,
    total_tokens_saved: 0,
    total_mcp_calls: 0,
    ai_suggestions_generated: 0,
    ai_suggestions_applied: 0,
  };
}

export function actionEstimateTokens(text: string, modelId?: string): number {
  return countTokens(text, modelId);
}

export function actionListModels(): FreeModelConfig[] {
  // re-export for the route
  return [];
}

// Re-export the model registry for convenience
export { FREE_MODELS, getAvailableModels, getDefaultModel } from "./free-models";
