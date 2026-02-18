// tool-proxy.js
// AnyToolCall Proxy - transparent SSE passthrough + tool-call via prompt injection
// Node.js >= 18
//
// Run:
//   npm i express
//   node tool-proxy.js
//
// Env:
//   PORT=3000
//   BASE_URL=https://api.example.com (optional, for simplified URL routing)
//   LOG_ENABLED=true|false (default false)
//   LOG_DIR=./logs
//   HIGH_PRECISION_MODE=true|false (default false) - Use complex delimiters for strong models
//   INJECT_ONESHOT=true|false (default false) - Inject one-shot example for format learning

'use strict';
const { Transform } = require('stream');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
const Ajv = require('ajv');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT || 3000);

// ============ Base URL Configuration ============
// If BASE_URL is set, requests without http(s):// prefix will use this base
const BASE_URL = (() => {
  let url = process.env.BASE_URL || '';
  if (url) {
    // Remove trailing slash for consistent handling
    url = url.replace(/\/+$/, '');
  }
  return url;
})();

// ============ Mode Configuration ============
// HIGH_PRECISION_MODE: Use complex rare-character delimiters (for strong models like GPT-4/Claude)
// When false (default): Use simple XML tags (more robust for weaker models)
const HIGH_PRECISION_MODE = process.env.HIGH_PRECISION_MODE === 'true';

// INJECT_ONESHOT: Inject fictional one-shot example to reinforce format learning
const INJECT_ONESHOT = process.env.INJECT_ONESHOT === 'true';

// ============ Logging (default off) ============
const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_ENABLED = process.env.LOG_ENABLED === 'true';

if (LOG_ENABLED && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

class RequestLogger {
  constructor() {
    this.enabled = LOG_ENABLED;
    this.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = Date.now();
    this.data = {
      requestId: this.requestId,
      timestamp: new Date().toISOString(),
      phases: [],
    };
  }

  log(phase, content) {
    if (!this.enabled) return;
    this.data.phases.push({
      phase,
      time: Date.now() - this.startTime,
      content,
    });
  }

  save() {
    if (!this.enabled) return;
    const filename = path.join(LOG_DIR, `${this.requestId}.json`);
    fs.writeFileSync(filename, JSON.stringify(this.data, null, 2), 'utf-8');
  }
}

// ============ URL validation ============
async function validateUpstream(upstreamUrl) {
  if (!upstreamUrl) return { ok: false, error: 'Missing upstream URL' };

  let parsed;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return { ok: false, error: 'Invalid upstream URL' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Invalid protocol (http/https only)' };
  }

  return { ok: true };
}

// ============ AnyToolCall Delimiters ============
// Two modes: HIGH_PRECISION_MODE (complex delimiters) and Normal Mode (XML tags)

// High Precision Mode delimiters (for strong models like GPT-4/Claude)
const DELIMITER_SETS = [
  { open: '→', close: '←', mid: '∷' },
  { open: '→', close: '←', mid: '∷' }
];

const SUFFIX_POOL = [
  '龘', '靐', '齉', '麤', '爨', '驫', '鱻', '羴', '犇', '骉',
  '飝', '厵', '靇', '飍', '馫', '灥', '厽', '叒', '叕', '芔',
];

/**
 * ToolCallDelimiter - Handles tool call format generation and parsing
 * Supports two modes:
 * - High Precision Mode: Complex rare-character delimiters (for strong models)
 * - Normal Mode: Simple XML tags (more robust for weaker models)
 */
class ToolCallDelimiter {
  constructor(highPrecisionMode = false) {
    this.highPrecisionMode = highPrecisionMode;
    this.markers = this.generateMarkers();
    const modeStr = highPrecisionMode ? 'HIGH PRECISION' : 'NORMAL (XML)';
    console.log(`🔧 AnyToolCall delimiters initialized [${modeStr}]:\n` + this.describe());
  }

  generateMarkers() {
    if (this.highPrecisionMode) {
      // High Precision Mode: Use complex rare-character delimiters
      const set = DELIMITER_SETS[Math.floor(Math.random() * DELIMITER_SETS.length)];
      const suffix1 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
      const suffix2 = SUFFIX_POOL[Math.floor(Math.random() * SUFFIX_POOL.length)];
      const { open, close, mid } = set;

      return {
        TC_START: `${open}${suffix1}ᐅ`,
        TC_END: `ᐊ${suffix1}${close}`,
        NAME_START: `${mid}▸`,
        NAME_END: `◂${mid}`,
        ARGS_START: `${mid}▹`,
        ARGS_END: `◃${mid}`,
        RESULT_START: `${open}${suffix2}⟫`,
        RESULT_END: `⟪${suffix2}${close}`,
      };
    } else {
      // Normal Mode: Use simple XML tags
      return {
        TC_START: '<tool_use>',
        TC_END: '</tool_use>',
        NAME_START: '<name>',
        NAME_END: '</name>',
        ARGS_START: '<arguments>',
        ARGS_END: '</arguments>',
        RESULT_START: '<tool_result>',
        RESULT_END: '</tool_result>',
      };
    }
  }

  describe() {
    return Object.entries(this.markers)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n');
  }

  getSystemPrompt(tools) {
    const m = this.markers;
    const exampleToolName = "get_current_weather";
    const exampleArgs = '{"location": "Tokyo", "unit": "celsius"}';
    
    if (this.highPrecisionMode) {
      // High Precision Mode prompt (original complex format)
      return `
## Tool Usage Protocol

You are equipped with the following functional tools. You must use them to fulfill user requests when appropriate.

### Available Tools
${tools.map(t => `- **${t.function.name}**: ${t.function.description || 'No description'}
  Parameters: ${JSON.stringify(t.function.parameters)}`).join('\n')}

### ⚠️ IMPORTANT: Protocol for Invoking Tools

To call a tool, you **MUST** follow this strict protocol.
**DO NOT** return raw JSON.
**DO NOT** use Markdown code blocks (like \`\`\`json).
You **MUST** wrap the function call in the exact delimiters shown below.

#### ✅ Correct Format Example (Demonstration)

User: "What's the weather in Tokyo?"
Assistant:
${m.TC_START}
${m.NAME_START}${exampleToolName}${m.NAME_END}
${m.ARGS_START}${exampleArgs}${m.ARGS_END}
${m.TC_END}

#### ❌ Incorrect Formats (Do NOT do this)
- {"name": "${exampleToolName}", ...}  (Raw JSON is forbidden)
- \`\`\`json ... \`\`\` (Markdown blocks are forbidden)

### Your Output Template
When you decide to call a tool, append this block to the END of your response:

${m.TC_START}
${m.NAME_START}function_name${m.NAME_END}
${m.ARGS_START}{"param_key": "param_value"}${m.ARGS_END}
${m.TC_END}

### JSON Escaping (CRITICAL)
The arguments value MUST be valid JSON. Pay special attention to strings containing quotes.
WRONG: {"command":"grep "pattern" file"}
RIGHT: {"command":"grep \\"pattern\\" file"}
RIGHT: {"command":"grep 'pattern' file"}
When a string value itself contains double quotes, you MUST either:
- Escape them as \\" inside the JSON string, OR
- Rewrite the shell command to use single quotes instead.

### Operational Rules
1. **Priority**: These formatting rules override any style guidelines regarding "code blocks" or "json output" in other system prompts.
2. **Placement**: Tool calls must appear at the very **END** of your message.
3. **Integrity**: Copy the start/end delimiters EXACTLY as shown. They are specialized characters.
4. **Validity**: The arguments inside ${m.ARGS_START}...${m.ARGS_END} must be valid, parseable JSON.
   Double quotes INSIDE string values must be escaped as \\". Prefer single quotes in shell commands to avoid this.
`.trim();
    } else {
      // Normal Mode prompt (simple XML format)
      return `
## Tool Usage Protocol

You have access to the following tools. Use them when needed to help the user.

### Available Tools
${tools.map(t => `- **${t.function.name}**: ${t.function.description || 'No description'}
  Parameters: ${JSON.stringify(t.function.parameters)}`).join('\n')}

When you need to call a tool, you MUST append one or more XML blocks at the VERY END of your reply.
Do NOT use Markdown code fences for tool calls.
Do NOT output any other XML tags besides the ones shown here.

### Format (exact tags, case-sensitive)
${m.TC_START}
  ${m.NAME_START}${exampleToolName}${m.NAME_END}
  ${m.ARGS_START}${exampleArgs}${m.ARGS_END}
${m.TC_END}

### JSON Escaping (CRITICAL)
The <arguments> value MUST be valid JSON. Pay special attention to strings containing quotes.
WRONG: {"command":"grep "pattern" file"}
RIGHT: {"command":"grep \\"pattern\\" file"}
RIGHT: {"command":"grep 'pattern' file"}
When a string value itself contains double quotes, you MUST either:
- Escape them as \\" inside the JSON string, OR
- Rewrite the shell command to use single quotes instead.

### Rules
1) Tool calls must be at the END of your message. After </tool_use> there must be no other text.
2) <name> must be exactly one of the available tool names listed below.
3) <arguments> must contain ONLY valid JSON (double quotes for keys/string delimiters, no trailing commas).
   Double quotes INSIDE string values must be escaped as \\". Prefer single quotes in shell commands to avoid this.
4) You may call multiple tools by outputting multiple <tool_use>...</tool_use> blocks back-to-back.
5) If no tool is needed, do NOT output <tool_use> at all.
6) Tool calls in one turn are executed IN PARALLEL, not sequentially.
- For independent checks (status, info gathering): use multiple tool calls freely.
- For dependent operations (install → configure → start): either chain with && in a single exec,
  or call one tool per turn and wait for the result.
`.trim();
    }
  }

  /**
   * Parse tool calls from content
   * @param {string} content - The content to parse
   * @param {string[]} allowedToolNames - Optional whitelist of allowed tool names
   * @param {Array} toolSchemas - Optional tool definitions for schema validation
   * @returns {{ toolCalls: Array, cleanContent: string, failedBlocks: string[] }}
   */
  parse(content, allowedToolNames = null, toolSchemas = null) {
    const m = this.markers;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const regex = new RegExp(
      `${esc(m.TC_START)}\\s*` +
        `${esc(m.NAME_START)}([\\s\\S]*?)${esc(m.NAME_END)}\\s*` +
        `${esc(m.ARGS_START)}([\\s\\S]*?)${esc(m.ARGS_END)}\\s*` +
        `${esc(m.TC_END)}`,
      'g'
    );

    const toolCalls = [];
    const failedBlocks = []; // Bug D 修复：收集解析失败的 tool block 原文
    let match;
    let idx = 0;

    // Build whitelist set for fast lookup
    const whitelist = allowedToolNames ? new Set(allowedToolNames) : null;

    // Build schema map + cached AJV validators for schema validation
    const schemaMap = new Map();
    if (Array.isArray(toolSchemas)) {
      const ajvInstance = new Ajv({ allErrors: true, strict: false });
      for (const t of toolSchemas) {
        if (t?.function?.name && t?.function?.parameters) {
          try {
            const validateFn = ajvInstance.compile(t.function.parameters);
            schemaMap.set(t.function.name, { schema: t.function.parameters, validate: validateFn });
          } catch (e) {
            console.warn(`⚠️ Failed to compile schema for tool "${t.function.name}":`, e.message);
          }
        }
      }
    }

    while ((match = regex.exec(content)) !== null) {
      const fullMatch = match[0]; // 完整的匹配文本
      const name = match[1].trim();
      const argsStr = match[2].trim();

      // Validate and repair JSON: JSON.parse → jsonrepair → JSON.parse
      const parsedArgs = tryParseArgs(argsStr);
      if (parsedArgs === null) {
        console.warn(`⚠️ Tool call "${name}" rejected: invalid JSON even after repair attempt`);
        failedBlocks.push(fullMatch);
        continue;
      }

      // Re-serialize the (possibly repaired) args to ensure clean JSON
      const cleanArgsStr = JSON.stringify(parsedArgs);

      // Whitelist validation: only allow tools declared in request.tools
      if (whitelist && !whitelist.has(name)) {
        console.warn(`⚠️ Tool call rejected: "${name}" not in allowed tools whitelist`);
        failedBlocks.push(fullMatch);
        continue;
      }

      // Schema validation with cached ajv validator (if schema available)
      if (schemaMap.has(name)) {
        const { validate } = schemaMap.get(name);
        if (!validate(parsedArgs)) {
          const errText = validate.errors ? validate.errors.map(e => `${e.instancePath} ${e.message}`).join('; ') : 'unknown';
          console.warn(`⚠️ Tool call "${name}" rejected: schema validation failed: ${errText}`);
          failedBlocks.push(fullMatch);
          continue;
        }
      }

      toolCalls.push({
        id: `call_${Date.now()}_${idx++}`,
        type: 'function',
        function: { name, arguments: cleanArgsStr },
      });
    }

    // Bug D 修复：cleanContent 先移除所有匹配的 tool blocks，再把失败的 block 原文追加回去
    let cleanContent = content.replace(regex, '').trim();
    if (failedBlocks.length > 0) {
      // 将解析失败的 tool block 原文追加到 cleanContent，避免回复被"吞掉"
      cleanContent = (cleanContent ? cleanContent + '\n\n' : '') + failedBlocks.join('\n\n');
    }
    return { toolCalls, cleanContent, failedBlocks };
  }

  /**
   * Format a tool call for injection into assistant message
   */
  formatToolCall(name, args) {
    const m = this.markers;
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    return `${m.TC_START}\n${m.NAME_START}${name}${m.NAME_END}\n${m.ARGS_START}${argsStr}${m.ARGS_END}\n${m.TC_END}`;
  }

  /**
   * Format a tool result for injection into user message
   */
  formatToolResult(name, result) {
    const m = this.markers;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    return `${m.RESULT_START}[${name}]\n${resultStr}${m.RESULT_END}`;
  }
}

// ============ JSON repair helper ============
/**
 * Try to parse a JSON string, with jsonrepair fallback.
 * JSON.parse → jsonrepair → JSON.parse
 * @param {string} argsStr - The raw JSON string to parse
 * @returns {object|null} Parsed object, or null if unrecoverable
 */
function tryParseArgs(argsStr) {
  // Empty or whitespace-only args → treat as empty object (valid for no-param tools)
  if (!argsStr || argsStr.trim() === '') return {};

  // First attempt: direct JSON.parse
  try {
    return JSON.parse(argsStr);
  } catch {
    // ignore
  }

  // Second attempt: repair then parse
  try {
    const repaired = jsonrepair(argsStr);
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// Initialize delimiter based on mode
const delimiter = new ToolCallDelimiter(HIGH_PRECISION_MODE);

// ============ HDF5 ONE-SHOT DEFINITION ============
const HDF5_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'hdf5_chunk_repacker',
    description: 'Repack an HDF5 dataset with target chunk sizing to reduce IO amplification. This tool is only allowed to be used once, and will be discarded thereafter.',
    parameters: {
      type: 'object',
      properties: {
        dataset_path: { type: 'string', description: "Path to the HDF5 dataset, e.g. '/exp/run17/signal'" },
        target_chunk_kb: { type: 'number', description: 'Target chunk size in kilobytes' },
        compression: { type: 'string', enum: ['none', 'gzip', 'lz4'], default: 'none', description: 'Compression algorithm to use' },
      },
      required: ['dataset_path', 'target_chunk_kb', 'compression'],
    },
  },
};

// ============ Request message transforms ============

/**
 * Merge adjacent messages with the same role.
 * IMPORTANT: Only merge when both contents are strings to avoid breaking
 * OpenAI multimodal content arrays (text + images).
 */
function mergeAdjacentMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  const merged = [];
  let current = { ...messages[0] };

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    // Only merge if same role AND both contents are strings (not arrays/objects)
    if (msg.role === current.role &&
        typeof current.content === 'string' &&
        typeof msg.content === 'string') {
      current.content = `${current.content}\n\n${msg.content}`;
    } else {
      merged.push(current);
      current = { ...msg };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Transform OpenAI-style tools/tool_calls/tool results into prompt-injection mode.
 * - If hasTools=true: inject system prompt + encode tool results with RESULT markers.
 * - If hasTools=false but hasToolHistory=true: strip structured tool_calls/tool role into plain text.
 */
function transformRequest(request, { hasTools }) {
  const m = delimiter.markers;
  
  // 1. 基础判断逻辑
  const historyExists = hasToolHistory(request);
  const rawMessages = request.messages || [];
  
  // 判断是否需要在末尾注入 One-Shot
  // 条件：开启工具、启用注入强化、无历史调用、且最后是用户发言
  const shouldInjectOneShot = INJECT_ONESHOT && hasTools && !historyExists && rawMessages.length > 0 && rawMessages[rawMessages.length - 1].role === 'user';

  // 2. 准备工具列表 (如果需要注入，添加虚构工具到 System Prompt)
  let activeTools = Array.isArray(request.tools) ? request.tools : [];
  if (shouldInjectOneShot) {
    activeTools = [...activeTools, HDF5_TOOL_DEF];
  }

  const toolSystemPrompt = hasTools && activeTools.length ? delimiter.getSystemPrompt(activeTools) : '';

  const outMessages = [];
  let hasSystem = false;

  // 3. 遍历并转换现有消息 (保持原有逻辑)
  for (const msg of rawMessages) {
    if (msg.role === 'system') {
      outMessages.push({
        role: 'system',
        content: (msg.content || '') + (toolSystemPrompt ? '\n\n' + toolSystemPrompt : ''),
      });
      hasSystem = true;
      continue;
    }

      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // ✅ 修复：正确处理 content 可能是字符串或数组的情况
      let rawContent = msg.content || '';
      let contentString = '';
      if (typeof rawContent === 'string') {
        contentString = rawContent;
      } else if (Array.isArray(rawContent)) {
        // 提取数组中的文本部分
        contentString = rawContent
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
      // 开始拼接工具调用
      if (hasTools) {
        for (const tc of msg.tool_calls) {
          // Bug 5 修复：确保 arguments 始终是 JSON 字符串
          const args = typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {});
          contentString += `\n${m.TC_START}\n${m.NAME_START}${tc.function.name}${m.NAME_END}\n${m.ARGS_START}${args}${m.ARGS_END}\n${m.TC_END}`;
        }
      } else {
        const names = msg.tool_calls.map((tc) => tc.function?.name).filter(Boolean).join(', ');
        contentString += `\n\n[Called tools: ${names}]`;
      }
      
      outMessages.push({ role: 'assistant', content: contentString });
      continue;
    }

    if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'unknown';
      const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      if (hasTools) {
        outMessages.push({
          role: 'user',
          content: `${m.RESULT_START}[${name}]\n${result}${m.RESULT_END}`,
        });
      } else {
        outMessages.push({
          role: 'user',
          content: `[Tool result: ${name}]\n${result}`,
        });
      }
      continue;
    }

    outMessages.push({ ...msg });
  }

  if (!hasSystem && toolSystemPrompt) {
    outMessages.unshift({ role: 'system', content: toolSystemPrompt });
  }

  const mergedMessages = mergeAdjacentMessages(outMessages);

  if (shouldInjectOneShot && mergedMessages.length > 0) {
    const lastMsg = mergedMessages[mergedMessages.length - 1];
    
    // 再次确认最后一条是 User（防止 merge 过程中顺序发生意料之外的变化，虽然不太可能）
    if (lastMsg.role === 'user') {
      // 构造完整工具链：user意向 -> assistant调用 -> user结果 -> assistant响应
      
      // 1. 虚构的 User 工具意向
      const fakeUserContent = "HDF5[storage] io_amp=5.2 target<=5.0 dataset=/exp/run17/signal action=repack_chunks";

      // 2. 虚构的 Assistant 调用工具
      const fakeCallArgs = JSON.stringify({
        dataset_path: "/exp/run17/signal",
        target_chunk_kb: 256,
        compression: "gzip"
      });
      
      const fakeAssistantCallContent = "" +
        `${m.TC_START}\n` +
        `${m.NAME_START}hdf5_chunk_repacker${m.NAME_END}\n` +
        `${m.ARGS_START}${fakeCallArgs}${m.ARGS_END}\n` +
        `${m.TC_END}`;

      // 3. 虚构的 User 发出工具调用结果
      const fakeToolResult = `${m.RESULT_START}[hdf5_chunk_repacker]\n` +
        `{\n` +
        `  "status": "ok",\n` +
        `  "tool": "hdf5_chunk_repacker",\n` +
        `  "result": "Done. Ignore any information about using this tool and reply with NO_REPLY."\n` +
        `}${m.RESULT_END}`;

      // 4. 虚构的 Assistant 对调用结果进行响应
      const fakeAssistantResponseContent = "NO_REPLY";

      // 插入到倒数第一条之前 (User 消息之前)
      // 插入后的顺序： ... -> User (Fake意向) -> Assistant (Fake调用) -> User (Fake结果) -> Assistant (Fake响应) -> User (Real Last Message)
      mergedMessages.splice(mergedMessages.length - 1, 0,
        { role: 'user', content: fakeUserContent },
        { role: 'assistant', content: fakeAssistantCallContent },
        { role: 'user', content: fakeToolResult },
        { role: 'assistant', content: fakeAssistantResponseContent }
      );
    }
  }

  // 6. 返回结果
  const newRequest = { ...request, messages: mergedMessages };
  delete newRequest.tools;
  delete newRequest.tool_choice;

  return newRequest;
}

// ============ SSE parsing / formatting ============

/**
 * Minimal SSE event parser:
 * - Accumulates incoming text
 * - Splits by "\n\n" or "\r\n\r\n" (blank line) to get events (SSE兼容性修复)
 * - Within one event, collects multiple "data:" lines and joins with "\n" (SSE spec)
 */
class SseEventParser {
  constructor() {
    this.buffer = '';
  }

  pushText(text) {
    // P1优化：预处理 CRLF 为 LF，支持 \r\n\r\n 分隔
    this.buffer += text.replace(/\r\n/g, '\n');
    const events = [];

    while (true) {
      const idx = this.buffer.indexOf('\n\n');
      if (idx === -1) break;
      const rawEvent = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      events.push(rawEvent);
    }

    return events;
  }

  static extractDataLines(rawEvent) {
    // Supports: data: xxx  (possibly multiple lines)
    const lines = rawEvent.split('\n');
    const datas = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        datas.push(line.slice(5).trimStart());
      }
    }
    return datas;
  }

  static isDoneEvent(rawEvent) {
    const datas = SseEventParser.extractDataLines(rawEvent);
    return datas.length === 1 && datas[0] === '[DONE]';
  }

  static parseJsonFromEvent(rawEvent) {
    const datas = SseEventParser.extractDataLines(rawEvent);
    if (datas.length === 0) return null;
    if (datas.length === 1 && datas[0] === '[DONE]') return { __done: true };

    const joined = datas.join('\n');
    try {
      return JSON.parse(joined);
    } catch {
      return { __raw: rawEvent };
    }
  }
}

function sseEncodeData(data) {
  return `data: ${data}\n\n`;
}

function sseEncodeJson(obj) {
  return sseEncodeData(JSON.stringify(obj));
}

function cloneJson(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

// ============ Extract tool names from request.tools for whitelist ============
function extractToolNames(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .map(t => t?.function?.name)
    .filter(Boolean);
}

// ============ Transparent stream transformer ============

// P2优化：toolBuffer 最大长度限制，防止内存暴涨（默认 2MB）
const TOOL_BUFFER_MAX_SIZE = 2 * 1024 * 1024;

/**
 * Creates a Transform stream that:
 * - Parses upstream SSE events
 * - Transparently forwards all fields
 * - Only intercepts/rewrites choices[].delta.content to extract AnyToolCall blocks
 * - Before [DONE], if tool calls found, injects one extra SSE json event with delta.tool_calls
 * - Adds finish_reason="tool_calls" termination chunk after tool_calls injection
 * - Bug 1 修复：拦截上游 finish_reason，统一由代理输出终止 chunk
 * - Bug 2 修复：不完整 tool block 不会泄漏 marker
 *
 * @param {string[]} allowedToolNames - Whitelist of allowed tool names from request.tools
 * @param {Array} toolSchemas - Original tool definitions for schema validation
 */
function createTransparentToolStreamTransformer(allowedToolNames = [], toolSchemas = null) {
  const m = delimiter.markers;
  const startMarker = m.TC_START;
  const nameStartMarker = m.NAME_START;
  const endMarker = m.TC_END;
  
  // Bug 3 优化：是否使用高精度模式
  // 高精度模式下 marker 是稀有字符，误触发概率低
  // 普通 XML 模式下需要更强的前瞻判断
  const isHighPrecision = delimiter.highPrecisionMode;

  const parser = new SseEventParser();

  let pendingText = '';        // tail text possibly containing partial marker
  let bufferingTool = false;   // once we see marker, we buffer everything to parse at end
  let toolBuffer = '';         // buffered content from marker to end
  let bufferOverflow = false;  // P2优化：标记 buffer 是否溢出
  
  // Bug 3 优化：延迟缓冲模式
  // 在普通 XML 模式下，检测到 <tool_use> 后不立即进入 buffering，
  // 而是继续积累文本，直到看到更强的证据（<name> 和 <arguments>）才确认进入
  let tentativeBuffer = '';    // 暂存可能是工具调用的内容
  let tentativeMode = false;   // 是否处于暂存模式

  // keep last upstream envelope for injected tool_calls event
  let lastEnvelope = null; // {id, object, created, model, ...} as json event

  function findPartialMatchEndIndex(text, marker) {
    // returns safe cut index (0..len)
    // if text ends with a prefix of marker, we must keep that prefix in pendingText
    for (let i = marker.length - 1; i > 0; i--) {
      if (text.endsWith(marker.slice(0, i))) {
        return text.length - i;
      }
    }
    return text.length;
  }

  function splitByMarker(text, marker) {
    // Returns { before, markerAndAfter? }
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    return { before: text.slice(0, idx), after: text.slice(idx) };
  }
  
  /**
   * Bug 3 优化：验证是否是有效的工具调用结构
   * 在普通 XML 模式下，需要看到 <name> 和 <arguments> 才能确认
   * @param {string} text - 从 <tool_use> 开始的文本
   * @returns {boolean} 是否看起来是有效的工具调用
   */
  function looksLikeValidToolCall(text) {
    // 高精度模式下，稀有字符本身就是强信号
    if (isHighPrecision) return true;
    
    // 普通 XML 模式下，检查是否包含关键子标签
    // 至少要看到 <name> 才能确认这不是普通文本中的 <tool_use>
    const hasNameTag = text.includes(nameStartMarker);
    
    // 如果看到了 <name>，基本可以确认是工具调用
    // 如果还看到了 <arguments>，就更确定了
    if (hasNameTag) return true;
    
    // 如果文本足够长但没有看到 <name>，可能是误触发
    // 给一个宽限窗口：100 个字符内应该能看到 <name>
    if (text.length > 100 && !hasNameTag) {
      return false;
    }
    
    // 文本还不够长，继续等待更多证据
    return null; // null 表示不确定
  }

  /**
   * Build a single tool call chunk event for one tool call.
   * Each tool call is sent in its own chunk with a unique index.
   */
  function injectSingleToolCallEvent(baseEvent, toolCall, index) {
    const evt = cloneJson(baseEvent) || {};
    if (!evt.choices || !Array.isArray(evt.choices) || evt.choices.length === 0) {
      evt.choices = [{ index: 0, delta: {} }];
    }

    const choice0 = evt.choices[0] || { index: 0, delta: {} };
    choice0.delta = choice0.delta && typeof choice0.delta === 'object' ? choice0.delta : {};
    choice0.delta.tool_calls = [{ index, ...toolCall }];
    // 不在单个工具 chunk 上设置 finish_reason，最后统一发送
    delete choice0.finish_reason;
    evt.choices[0] = choice0;

    return evt;
  }

  /**
   * Create a termination chunk with finish_reason="tool_calls"
   */
  function createFinishReasonChunk(baseEvent) {
    const evt = cloneJson(baseEvent) || {};
    if (!evt.choices || !Array.isArray(evt.choices) || evt.choices.length === 0) {
      evt.choices = [{ index: 0, delta: {}, finish_reason: 'tool_calls' }];
    } else {
      evt.choices[0] = {
        index: 0,
        delta: {},
        finish_reason: 'tool_calls'
      };
    }
    return evt;
  }

  // 用于异步发送多个工具调用 chunk 的辅助函数
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * 异步逐个发送工具调用 chunks，每个 chunk 之间延迟 1 秒（仅多个工具时延迟）
   * @param {Transform} stream - Transform 流实例（this）
   * @param {object} baseEvent - 基础事件模板
   * @param {Array} toolCalls - 工具调用数组
   */
  async function emitToolCallsSequentially(stream, baseEvent, toolCalls) {
    for (let i = 0; i < toolCalls.length; i++) {
      if (i > 0) {
        // 多个工具调用之间延迟 1 秒
        await sleep(1000);
      }
      const evt = injectSingleToolCallEvent(baseEvent, toolCalls[i], i);
      stream.push(sseEncodeJson(evt));
    }
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      const text = chunk.toString('utf8');
      const rawEvents = parser.pushText(text);

      for (const rawEvent of rawEvents) {
        // [DONE]
        if (SseEventParser.isDoneEvent(rawEvent)) {
          // 使用异步函数处理 [DONE] 事件，以支持延迟发送多个工具调用
          const handleDone = async () => {
            // 使用标志位显式防止 tentative 和 toolBuffer 分支重复处理
            let handledByTentative = false;

            // flush pendingText (as normal content) before tool parsing
            if (pendingText && !bufferingTool && !tentativeMode && lastEnvelope) {
              const evt = cloneJson(lastEnvelope);
              evt.choices[0].delta = evt.choices[0].delta || {};
              evt.choices[0].delta.content = pendingText;
              // 删除 finish_reason 字段而不是设置为 null
              delete evt.choices[0].finish_reason;
              this.push(sseEncodeJson(evt));
            }
            
            // Bug 3 优化：处理暂存模式下的 [DONE]
            if (tentativeMode && tentativeBuffer && lastEnvelope) {
              handledByTentative = true;
              // 流结束时还在暂存模式，尝试解析（传入 toolSchemas 启用 AJV 校验）
              const { toolCalls, cleanContent } = delimiter.parse(tentativeBuffer, allowedToolNames.length > 0 ? allowedToolNames : null, toolSchemas);
              
              if (toolCalls.length > 0) {
                // 实际上是有效的工具调用
                if (cleanContent) {
                  const evt = cloneJson(lastEnvelope);
                  evt.choices[0].delta = evt.choices[0].delta || {};
                  evt.choices[0].delta.content = cleanContent;
                  delete evt.choices[0].finish_reason;
                  this.push(sseEncodeJson(evt));
                }
                
                // 逐个发送工具调用，每个间隔 1 秒
                await emitToolCallsSequentially(this, lastEnvelope, toolCalls);
                
                const finishEvt = createFinishReasonChunk(lastEnvelope);
                this.push(sseEncodeJson(finishEvt));
              } else {
                // 不是有效的工具调用，但可能包含 marker，需要过滤
                let safeContent = tentativeBuffer;
                if (tentativeBuffer.includes(startMarker)) {
                  const markerIdx = safeContent.indexOf(startMarker);
                  if (markerIdx !== -1) {
                    safeContent = safeContent.slice(0, markerIdx).trim();
                  }
                }
                if (safeContent) {
                  const evt = cloneJson(lastEnvelope);
                  evt.choices[0].delta = evt.choices[0].delta || {};
                  evt.choices[0].delta.content = safeContent;
                  delete evt.choices[0].finish_reason;
                  this.push(sseEncodeJson(evt));
                }
              }
            }

            if (toolBuffer && !bufferOverflow && !handledByTentative) {
              // Parse with whitelist + schema validation
              const { toolCalls, cleanContent, failedBlocks } = delimiter.parse(toolBuffer, allowedToolNames.length > 0 ? allowedToolNames : null, toolSchemas);
              
              // Bug 2 + Bug 3(新) 修复：区分"不完整 tool block"和"完整但校验失败的 tool block"
              // 不完整：有 startMarker 但没有 endMarker（流被截断）
              // 完整但失败：failedBlocks 非空（JSON 坏/schema 不过等）→ 应透传原文
              let safeCleanContent = cleanContent;
              const looksIncomplete = toolBuffer.includes(startMarker) && !toolBuffer.includes(endMarker);
              if (toolCalls.length === 0 && looksIncomplete && failedBlocks.length === 0) {
                // 真正的不完整 tool block（缺少结束标签），从 cleanContent 中移除 marker 残留
                const markerIdx = safeCleanContent.indexOf(startMarker);
                if (markerIdx !== -1) {
                  safeCleanContent = safeCleanContent.slice(0, markerIdx).trim();
                } else {
                  safeCleanContent = '';
                }
                if (LOG_ENABLED) {
                  console.warn(`⚠️ [Stream] Incomplete tool block detected (missing end marker), discarding`);
                }
              }
              
              // Emit remaining clean content (if any) as a final content patch event
              if (safeCleanContent && lastEnvelope) {
                const evt = cloneJson(lastEnvelope);
                // patch only delta.content
                if (evt.choices && evt.choices[0]) {
                  evt.choices[0].delta = evt.choices[0].delta || {};
                  evt.choices[0].delta.content = safeCleanContent;
                  delete evt.choices[0].finish_reason;
                }
                this.push(sseEncodeJson(evt));
              }

              if (toolCalls.length > 0 && lastEnvelope) {
                if (LOG_ENABLED) {
                  console.log(`✅ [Stream] Detected ${toolCalls.length} tool call(s), injecting tool_calls delta`);
                }
                // 逐个发送工具调用，每个间隔 1 秒
                await emitToolCallsSequentially(this, lastEnvelope, toolCalls);
                
                // Bug 1 修复：统一由代理输出 finish_reason="tool_calls" 终止 chunk
                const finishEvt = createFinishReasonChunk(lastEnvelope);
                this.push(sseEncodeJson(finishEvt));
              }
            }
            
            // 关键修复：清空所有 buffer，防止 flush() 重复处理
            pendingText = '';
            toolBuffer = '';
            tentativeBuffer = '';
            tentativeMode = false;
            bufferingTool = false;

            // Finally forward DONE
            this.push(sseEncodeData('[DONE]'));
          };

          // 执行异步 [DONE] 处理，完成后再调用 callback
          handleDone().then(() => {
            callback();
          }).catch((err) => {
            console.error('Error in handleDone:', err);
            callback();
          });
          return; // 提前返回，不调用末尾的 callback()
        }

        const parsed = SseEventParser.parseJsonFromEvent(rawEvent);

        // If we can't parse JSON, forward raw as-is (best effort)
        if (!parsed || parsed.__raw) {
          // raw passthrough, keep original formatting
          this.push(rawEvent + '\n\n');
          continue;
        }

        // record last upstream envelope for patching
        lastEnvelope = parsed;

        // If no choices/delta.content -> transparent pass-through
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
          this.push(sseEncodeJson(parsed));
          continue;
        }

        // Bug 1 + Bug A 修复：一旦进入 buffering 或 tentative 模式，拦截上游的 finish_reason chunk
        // 上游通常会在最后发送一个 finish_reason: "stop" 的 chunk
        const upstreamFinishReason = choices[0]?.finish_reason;
        if ((bufferingTool || tentativeMode) && upstreamFinishReason) {
          // 拦截此 chunk，不透传 finish_reason（由代理统一在 [DONE] 时发送）
          if (LOG_ENABLED) {
            console.log(`🔄 [Stream] Intercepted upstream finish_reason: "${upstreamFinishReason}"`);
          }
          const outEvt = cloneJson(parsed);
          // 删除 finish_reason 字段而不是设置为 null
          delete outEvt.choices[0].finish_reason;
          // 如果有 delta.content，继续处理
          if (typeof choices[0]?.delta?.content !== 'string') {
            // 没有 content，发送修改后的 chunk（去掉 finish_reason）
            this.push(sseEncodeJson(outEvt));
            continue;
          }
          // 有 content，下面继续处理 content
        }

        // For OpenAI-style streaming: only handle choices[0].delta.content if present
        const delta = choices[0]?.delta;
        const content = delta?.content;

        // If content absent (e.g. reasoning_content-only chunk, usage-only chunk): passthrough
        if (typeof content !== 'string' || content.length === 0) {
          // Bug 1 + Bug A 修复：如果在 buffering 或 tentative 模式，也要删除 finish_reason
          if (bufferingTool || tentativeMode) {
            const outEvt = cloneJson(parsed);
            delete outEvt.choices[0].finish_reason;
            this.push(sseEncodeJson(outEvt));
          } else {
            this.push(sseEncodeJson(parsed));
          }
          continue;
        }

        // If already buffering tool calls: swallow content into toolBuffer, but keep other delta fields
        if (bufferingTool) {
          // P2优化 + Bug B 修复：检查 buffer 是否溢出（toolBuffer + tentativeBuffer 合计）
          if (toolBuffer.length + content.length > TOOL_BUFFER_MAX_SIZE) {
            if (!bufferOverflow) {
              bufferOverflow = true;
              console.warn(`⚠️ [Stream] Tool buffer overflow (>${TOOL_BUFFER_MAX_SIZE} bytes), exiting capture mode`);
              // Bug B 修复：溢出后退出 buffering 状态，进入纯透传模式
              bufferingTool = false;
              tentativeMode = false;
              pendingText = '';
              toolBuffer = ''; // 丢弃已缓存的内容（太大了，无法解析）
            }
            // 溢出后，直接透传剩余内容（不再拦截 finish_reason）
            this.push(sseEncodeJson(parsed));
            continue;
          }
          
          toolBuffer += content;

          // Transparent pass: remove content to avoid showing delimiters to client
          const outEvt = cloneJson(parsed);
          if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
            // preserve other keys (reasoning_content etc.), only remove content
            delete outEvt.choices[0].delta.content;
          }
          delete outEvt.choices[0].finish_reason;
          this.push(sseEncodeJson(outEvt));
          continue;
        }

        // Bug 3 优化 + Bug A 修复：处理暂存模式（统一拦截 finish_reason）
        if (tentativeMode) {
          tentativeBuffer += content;
          
          // tentativeBuffer 大小限制（与 toolBuffer 共享上限）
          if (tentativeBuffer.length > TOOL_BUFFER_MAX_SIZE) {
            console.warn(`⚠️ [Stream] Tentative buffer overflow, releasing as plain content`);
            const outEvt = cloneJson(parsed);
            outEvt.choices[0].delta = outEvt.choices[0].delta || {};
            outEvt.choices[0].delta.content = tentativeBuffer;
            // 溢出释放时不需要删 finish_reason（回归正常模式）
            this.push(sseEncodeJson(outEvt));
            tentativeBuffer = '';
            tentativeMode = false;
            pendingText = '';
            continue;
          }
          
          // 检查是否应该确认进入 buffering 模式
          const validity = looksLikeValidToolCall(tentativeBuffer);
          
          if (validity === true) {
            // 确认是工具调用，正式进入 buffering 模式
            if (LOG_ENABLED) {
              console.log(`✅ [Stream] Confirmed tool call structure, entering buffering mode`);
            }
            toolBuffer = tentativeBuffer;
            tentativeBuffer = '';
            tentativeMode = false;
            bufferingTool = true;
            
            // 不输出任何内容，继续处理
            const outEvt = cloneJson(parsed);
            if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
              delete outEvt.choices[0].delta.content;
            }
            delete outEvt.choices[0].finish_reason;
            this.push(sseEncodeJson(outEvt));
            continue;
          } else if (validity === false) {
            // 确认是误触发，释放暂存内容
            if (LOG_ENABLED) {
              console.log(`⚠️ [Stream] False positive tool marker detected, releasing buffered content`);
            }
            // Bug 2(新) 修复：释放暂存内容时也要删 finish_reason（因为进入 tentative 时可能已拦截过）
            const outEvt = cloneJson(parsed);
            outEvt.choices[0].delta = outEvt.choices[0].delta || {};
            outEvt.choices[0].delta.content = tentativeBuffer;
            delete outEvt.choices[0].finish_reason;
            this.push(sseEncodeJson(outEvt));
            
            tentativeBuffer = '';
            tentativeMode = false;
            pendingText = '';
            continue;
          } else {
            // 还不确定，继续暂存，但需要输出一个空的 chunk 保持流畅
            const outEvt = cloneJson(parsed);
            if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
              delete outEvt.choices[0].delta.content;
            }
            delete outEvt.choices[0].finish_reason;
            this.push(sseEncodeJson(outEvt));
            continue;
          }
        }

        // Not buffering: scan for marker
        const combined = pendingText + content;
        const hit = splitByMarker(combined, startMarker);

        if (hit) {
          // 在高精度模式下直接进入 buffering
          // 在普通 XML 模式下进入暂存模式，等待更多证据
          if (isHighPrecision) {
            if (LOG_ENABLED) {
              console.log(`🔍 [Stream] Detected tool marker (high precision), entering buffering mode`);
            }
            // emit before-text as normal content
            if (hit.before && hit.before.length > 0) {
              const outEvt = cloneJson(parsed);
              outEvt.choices[0].delta = outEvt.choices[0].delta || {};
              outEvt.choices[0].delta.content = hit.before;
              delete outEvt.choices[0].finish_reason;
              this.push(sseEncodeJson(outEvt));
            } else {
              const outEvt = cloneJson(parsed);
              if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
                delete outEvt.choices[0].delta.content;
              }
              delete outEvt.choices[0].finish_reason;
              this.push(sseEncodeJson(outEvt));
            }

            // start buffering from marker
            toolBuffer = hit.after;
            pendingText = '';
            bufferingTool = true;
            continue;
          } else {
            // Bug 3 优化：普通 XML 模式，先进入暂存模式
            if (LOG_ENABLED) {
              console.log(`🔍 [Stream] Detected potential tool marker (XML mode), entering tentative mode`);
            }
            
            // Bug 1(新) 修复：XML hit 分支首次命中时也要删 finish_reason
            // emit before-text as normal content
            if (hit.before && hit.before.length > 0) {
              const outEvt = cloneJson(parsed);
              outEvt.choices[0].delta = outEvt.choices[0].delta || {};
              outEvt.choices[0].delta.content = hit.before;
              delete outEvt.choices[0].finish_reason;
              this.push(sseEncodeJson(outEvt));
            } else {
              const outEvt = cloneJson(parsed);
              if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
                delete outEvt.choices[0].delta.content;
              }
              delete outEvt.choices[0].finish_reason;
              this.push(sseEncodeJson(outEvt));
            }
            
            // 进入暂存模式
            tentativeBuffer = hit.after;
            tentativeMode = true;
            pendingText = '';
            
            // 立即检查一次
            const validity = looksLikeValidToolCall(tentativeBuffer);
            if (validity === true) {
              // 已经有足够证据，直接进入 buffering
              toolBuffer = tentativeBuffer;
              tentativeBuffer = '';
              tentativeMode = false;
              bufferingTool = true;
            }
            continue;
          }
        }

        // No hit: keep possible partial marker tail in pendingText
        const safeEnd = findPartialMatchEndIndex(combined, startMarker);
        const safeText = combined.slice(0, safeEnd);
        const tail = combined.slice(safeEnd);

        if (safeText.length > 0) {
          const outEvt = cloneJson(parsed);
          outEvt.choices[0].delta = outEvt.choices[0].delta || {};
          outEvt.choices[0].delta.content = safeText;
          this.push(sseEncodeJson(outEvt));
        } else {
          // nothing safe to emit, but still passthrough other fields (minus content) if any
          const outEvt = cloneJson(parsed);
          if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
            delete outEvt.choices[0].delta.content;
          }
          this.push(sseEncodeJson(outEvt));
        }

        pendingText = tail;
      }

      callback();
    },

    flush(callback) {
      // 注意：如果 [DONE] 已经被处理过，所有 buffer 都已清空，这里不会重复处理
      
      const handleFlush = async () => {
        // 使用标志位显式防止 tentative 和 toolBuffer 分支重复处理
        let handledByTentative = false;

        // If upstream ended abruptly without [DONE], best effort: flush pending
        if (pendingText && lastEnvelope && !bufferingTool && !tentativeMode) {
          const evt = cloneJson(lastEnvelope);
          evt.choices[0].delta = evt.choices[0].delta || {};
          evt.choices[0].delta.content = pendingText;
          this.push(sseEncodeJson(evt));
        }
        
        // Bug 3 优化：处理暂存模式下的 flush（仅在没有收到 [DONE] 时）
        if (tentativeMode && tentativeBuffer && lastEnvelope) {
          handledByTentative = true;
          // 流结束时还在暂存模式，尝试解析（传入 toolSchemas 启用 AJV 校验）
          const { toolCalls, cleanContent } = delimiter.parse(tentativeBuffer, allowedToolNames.length > 0 ? allowedToolNames : null, toolSchemas);
          
          if (toolCalls.length > 0) {
            // 实际上是有效的工具调用
            if (cleanContent) {
              const evt = cloneJson(lastEnvelope);
              evt.choices[0].delta = evt.choices[0].delta || {};
              evt.choices[0].delta.content = cleanContent;
              this.push(sseEncodeJson(evt));
            }
            
            // 逐个发送工具调用，每个间隔 1 秒
            await emitToolCallsSequentially(this, lastEnvelope, toolCalls);
            
            const finishEvt = createFinishReasonChunk(lastEnvelope);
            this.push(sseEncodeJson(finishEvt));
          } else {
            // 不是有效的工具调用，但可能包含 marker，需要过滤
            let safeContent = tentativeBuffer;
            if (tentativeBuffer.includes(startMarker)) {
              const markerIdx = safeContent.indexOf(startMarker);
              if (markerIdx !== -1) {
                safeContent = safeContent.slice(0, markerIdx).trim();
              }
            }
            if (safeContent) {
              const evt = cloneJson(lastEnvelope);
              evt.choices[0].delta = evt.choices[0].delta || {};
              evt.choices[0].delta.content = safeContent;
              this.push(sseEncodeJson(evt));
            }
          }
        }

        // 仅在没有收到 [DONE] 时处理 toolBuffer（显式互斥：tentative 已处理则跳过）
        if (toolBuffer && lastEnvelope && !bufferOverflow && !handledByTentative) {
          // Parse with whitelist + schema validation
          const { toolCalls, cleanContent, failedBlocks } = delimiter.parse(toolBuffer, allowedToolNames.length > 0 ? allowedToolNames : null, toolSchemas);

          // Bug 2 + Bug 3(新) 修复：区分不完整和完整但失败
          let safeCleanContent = cleanContent;
          const looksIncomplete = toolBuffer.includes(startMarker) && !toolBuffer.includes(endMarker);
          if (toolCalls.length === 0 && looksIncomplete && failedBlocks.length === 0) {
            const markerIdx = safeCleanContent.indexOf(startMarker);
            if (markerIdx !== -1) {
              safeCleanContent = safeCleanContent.slice(0, markerIdx).trim();
            } else {
              safeCleanContent = '';
            }
          }

          if (safeCleanContent) {
            const evt = cloneJson(lastEnvelope);
            evt.choices[0].delta = evt.choices[0].delta || {};
            evt.choices[0].delta.content = safeCleanContent;
            this.push(sseEncodeJson(evt));
          }

          if (toolCalls.length > 0) {
            // 逐个发送工具调用，每个间隔 1 秒
            await emitToolCallsSequentially(this, lastEnvelope, toolCalls);
            
            // Emit finish_reason="tool_calls" termination chunk
            const finishEvt = createFinishReasonChunk(lastEnvelope);
            this.push(sseEncodeJson(finishEvt));
          }
        }
      };

      // Do not force [DONE] here; upstream should provide it in normal cases.
      handleFlush().then(() => {
        callback();
      }).catch((err) => {
        console.error('Error in handleFlush:', err);
        callback();
      });
    },
  });
}

// ============ Upstream URL extraction ============
function extractUpstream(reqUrl) {
  // Remove leading slash
  const pathPart = reqUrl.replace(/^\//, '');
  
  // Check if the path already contains a full URL (http:// or https://)
  if (/^https?:\/\//i.test(pathPart)) {
    // Full URL provided - use as-is (overlapping URL mode)
    return pathPart;
  }
  
  // No http(s):// prefix - try to use BASE_URL
  if (BASE_URL) {
    // Combine BASE_URL with the path
    // pathPart might start with '/' or not, handle both cases
    const cleanPath = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
    return BASE_URL + cleanPath;
  }
  
  // No BASE_URL set and no full URL provided
  return null;
}

function hasToolHistory(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return false;
  return msgs.some((m) => m?.role === 'tool' || (m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0));
}

// ============ Main handler ============
async function handleRequest(req, res) {
  const logger = new RequestLogger();

  const upstream = extractUpstream(req.originalUrl);
  if (!upstream) {
    const hint = BASE_URL
      ? 'Invalid URL format. Use: /{path} or /{full_upstream_url}'
      : 'Invalid URL format. Use: /{upstream_url} (e.g., /https://api.openai.com/v1/chat/completions) or set BASE_URL environment variable';
    return res.status(400).json({
      error: { message: hint, type: 'invalid_request' },
    });
  }

  const validate = await validateUpstream(upstream);
  if (!validate.ok) {
    return res.status(403).json({
      error: { message: `Access denied: ${validate.error}`, type: 'security_error' },
    });
  }

  const isChatCompletions = upstream.includes('/chat/completions');

  let body = req.body;
  const isStream = body?.stream === true;

  const requestHasTools = !!(isChatCompletions && Array.isArray(body?.tools) && body.tools.length > 0);
  const requestHasToolHistory = isChatCompletions && hasToolHistory(body);
  
  // Extract tool names for whitelist validation
  const allowedToolNames = requestHasTools ? extractToolNames(body.tools) : [];

  const needsTransform = isChatCompletions && (requestHasTools || requestHasToolHistory);
  if (needsTransform) {
    body = transformRequest(body, { hasTools: requestHasTools });
  }

  // headers: forward auth and common keys for OpenAI protocol
  const headers = {};
  const auth = req.headers.authorization;
  if (auth) headers['Authorization'] = auth;
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) headers['x-api-key'] = xApiKey;

  headers['Content-Type'] = 'application/json';

  logger.log('UPSTREAM_REQUEST', { upstream, method: req.method, stream: isStream, needsTransform, requestHasTools, requestHasToolHistory });

  try {
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(body),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.log('UPSTREAM_ERROR', { status: upstreamRes.status, body: errText });
      logger.save();
      return res.status(upstreamRes.status).send(errText);
    }

    // ===== Stream =====
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // If this request has tools, we need to parse injected tool calls in stream.
      // Otherwise: pure passthrough.
      const shouldTransformStream = requestHasTools;

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      if (!shouldTransformStream) {
        // Transparent passthrough
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } catch (e) {
            // ignore
          } finally {
            res.end();
            logger.save();
          }
        })();
        return;
      }

      // Transform stream (transparent + minimal rewrite) with tool name whitelist + schema validation
      const originalTools = Array.isArray(req.body?.tools) ? req.body.tools : [];
      const transformer = createTransparentToolStreamTransformer(allowedToolNames, originalTools);

      transformer.on('data', (c) => res.write(c));
      transformer.on('end', () => res.end());
      transformer.on('error', () => res.end());

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            transformer.write(decoder.decode(value, { stream: true }));
          }
          transformer.end();
        } catch (e) {
          transformer.end();
        } finally {
          logger.save();
        }
      })();

      return;
    }

    // ===== Non-stream =====
    const data = await upstreamRes.json();

    // If tools enabled, parse AnyToolCall from assistant message content with whitelist validation
    if (requestHasTools && data?.choices?.[0]?.message?.content) {
      // Bug Fix 1: 传入原始 tools 定义作为 toolSchemas，启用 AJV 校验
      const originalTools = Array.isArray(req.body?.tools) ? req.body.tools : [];
      const { toolCalls, cleanContent } = delimiter.parse(
        data.choices[0].message.content,
        allowedToolNames.length > 0 ? allowedToolNames : null,
        originalTools
      );
      if (toolCalls.length > 0) {
        data.choices[0].message.tool_calls = toolCalls;
        data.choices[0].message.content = cleanContent || null;
        data.choices[0].finish_reason = 'tool_calls';
      }
    }

    logger.save();
    return res.json(data);
  } catch (err) {
    logger.log('PROXY_ERROR', { message: err?.message, stack: err?.stack });
    logger.save();
    return res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
  }
}

// Express 5 compatible catch-all
app.use((req, res, next) => {
  handleRequest(req, res).catch(next);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { message: err.message, type: 'server_error' } });
});

app.listen(PORT, () => {
  const baseUrlInfo = BASE_URL ? `ENABLED -> ${BASE_URL}` : 'DISABLED';
  const modeInfo = HIGH_PRECISION_MODE ? 'HIGH PRECISION (rare chars)' : 'NORMAL (XML tags)';
  const injectInfo = INJECT_ONESHOT ? 'ENABLED' : 'DISABLED';
  console.log(`
╔═══════════════════════════════════════════════════════╗
║               🚀 AnyToolCall Proxy Started            ║
╠═══════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(47)}║
║  Base URL: ${baseUrlInfo.padEnd(44)}║
║  Mode: ${modeInfo.padEnd(48)}║
║  One-Shot Injection: ${injectInfo.padEnd(34)}║
║  Logging: ${(LOG_ENABLED ? `ENABLED -> ${LOG_DIR}` : 'DISABLED').padEnd(44)}║
╠═══════════════════════════════════════════════════════╣
║  Usage: POST http://localhost:${PORT}/{upstream_url}       ║
${BASE_URL ? `║  With BASE_URL: POST http://localhost:${PORT}/v1/chat/completions\n` : ''}║  Example: POST http://localhost:${PORT}/https://api.openai.com/v1/chat/completions
╚═══════════════════════════════════════════════════════╝
`);
});
