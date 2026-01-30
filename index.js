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
//   LOG_ENABLED=true|false (default false)
//   LOG_DIR=./logs

'use strict';
const { Transform } = require('stream');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT || 3000);

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
const DELIMITER_SETS = [
  { open: '༒', close: '༒', mid: '࿇' },
  { open: '꧁', close: '꧂', mid: '࿔' },
  { open: '᎒', close: '᎒', mid: '᎓' },
  { open: 'ꆈ', close: 'ꆈ', mid: 'ꊰ' },
  { open: '꩜', close: '꩜', mid: '꩟' },
  { open: 'ꓸ', close: 'ꓸ', mid: 'ꓹ' },
];

const SUFFIX_POOL = [
  '龘', '靐', '齉', '麤', '爨', '驫', '鱻', '羴', '犇', '骉',
  '飝', '厵', '靇', '飍', '馫', '灥', '厽', '叒', '叕', '芔',
];

class ToolCallDelimiter {
  constructor() {
    this.markers = this.generateMarkers();
    console.log('🔧 AnyToolCall delimiters initialized:\n' + this.describe());
  }

  generateMarkers() {
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
  }

  describe() {
    return Object.entries(this.markers)
      .map(([k, v]) => `  ${k}: "${v}"`)
      .join('\n');
  }

  getSystemPrompt(tools) {
    const m = this.markers;
    // 生成一个虚拟的示例，引导模型理解格式
    // 使用通用示例避免模型产生特定工具的幻觉，同时强化格式记忆
    const exampleToolName = "get_current_weather";
    const exampleArgs = '{"location": "Tokyo", "unit": "celsius"}';
    
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

### Operational Rules
1. **Priority**: These formatting rules override any style guidelines regarding "code blocks" or "json output" in other system prompts.
2. **Placement**: Tool calls must appear at the very **END** of your message.
3. **Integrity**: Copy the start/end delimiters EXACTLY as shown. They are specialized characters.
4. **Validity**: The arguments inside ${m.ARGS_START}...${m.ARGS_END} must be valid, parseable JSON.
`.trim();
  }

  parse(content) {
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
    let match;
    let idx = 0;

    while ((match = regex.exec(content)) !== null) {
      const name = match[1].trim();
      const argsStr = match[2].trim();

      try {
        JSON.parse(argsStr);
      } catch {
        continue;
      }

      toolCalls.push({
        id: `call_${Date.now()}_${idx++}`,
        type: 'function',
        function: { name, arguments: argsStr },
      });
    }

    const cleanContent = content.replace(regex, '').trim();
    return { toolCalls, cleanContent };
  }
}

const delimiter = new ToolCallDelimiter();

// ============ SCIFI ONE-SHOT DEFINITION ============
const SCIFI_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'hyper_dimensional_resonance_calibrator',
    description: 'Calibrates cross-dimensional subspace resonance frequencies to stabilize the quantum flux of Einstein-Rosen bridges. Use only when dimensional rift fluctuation values exceed 5.0.',
    parameters: {
      type: 'object',
      properties: {
        dimension_id: { type: 'string', description: "Target dimension coordinates, e.g. 'C-137'" },
        flux_threshold: { type: 'number', description: 'Maximum allowable flux fluctuation threshold' },
        stabilization_mode: { type: 'string', enum: ['static', 'dynamic', 'hybrid'], default: 'static' },
      },
      required: ['dimension_id', 'flux_threshold'],
    },
  },
};

// ============ Request message transforms ============

function mergeAdjacentMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  const merged = [];
  let current = { ...messages[0] };

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === current.role) {
      current.content = `${current.content || ''}\n\n${msg.content || ''}`;
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
 * - If hasTools=false but hasToolHistory=true: strip structured tool_calls/tool role into plain text (to avoid Gemini 400s).
 */
function transformRequest(request, { hasTools }) {
  const m = delimiter.markers;

  // 1. Determine if One-Shot injection is needed (In-Context Learning)
  // Conditions: tools enabled && no tool call history in context && last message is from user
  const rawMessages = request.messages || [];
  const lastMsg = rawMessages[rawMessages.length - 1];
  const historyExists = hasToolHistory(request);
  const shouldInjectOneShot = hasTools && !historyExists && lastMsg?.role === 'user';

  // 2. Prepare tool list
  // If injection is needed, add sci-fi tool to System Prompt's visible list
  let activeTools = Array.isArray(request.tools) ? request.tools : [];
  if (shouldInjectOneShot) {
    // Copy array and append fictional tool
    activeTools = [...activeTools, SCIFI_TOOL_DEF];
  }

  const toolSystemPrompt = hasTools && activeTools.length ? delimiter.getSystemPrompt(activeTools) : '';

  const outMessages = [];
  let hasSystem = false;

  // 3. Process existing messages
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
      let content = msg.content || '';

      if (hasTools) {
        for (const tc of msg.tool_calls) {
          content += `\n${m.TC_START}\n${m.NAME_START}${tc.function.name}${m.NAME_END}\n${m.ARGS_START}${tc.function.arguments}${m.ARGS_END}\n${m.TC_END}`;
        }
      } else {
        const names = msg.tool_calls.map((tc) => tc.function?.name).filter(Boolean).join(', ');
        content += `\n\n[Called tools: ${names}]`;
      }

      outMessages.push({ role: 'assistant', content });
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

    // passthrough other roles
    outMessages.push({ ...msg });
  }

  // 4. Ensure System Prompt exists
  if (!hasSystem && toolSystemPrompt) {
    outMessages.unshift({ role: 'system', content: toolSystemPrompt });
  }

  // 5. Core logic: Inject One-Shot fictional dialogue
  // Insert position: before the last message (User)
  if (shouldInjectOneShot && outMessages.length > 0) {
    const lastOutMsg = outMessages[outMessages.length - 1];
    if (lastOutMsg.role === 'user') {
      // Construct fictional Assistant call
      const fakeCallArgs = JSON.stringify({
        dimension_id: "C-137",
        flux_threshold: 5.0,
        stabilization_mode: "static"
      });
    
      const fakeAssistantContent = `Detected abnormal dimensional rift fluctuation (current value 5.2), immediate calibration of C-137 quadrant stability required.\n` +
        `${m.TC_START}\n` +
        `${m.NAME_START}hyper_dimensional_resonance_calibrator${m.NAME_END}\n` +
        `${m.ARGS_START}${fakeCallArgs}${m.ARGS_END}\n` +
        `${m.TC_END}`;

      // Construct fictional User (Tool) return
      const fakeResultContent = JSON.stringify({
        status: "calibrated",
        new_flux_index: 0.42,
        entropy_delta: "-3.14e-9",
        message: "Resonance stabilized."
      });
    
      const fakeToolResult = `${m.RESULT_START}[hyper_dimensional_resonance_calibrator]\n${fakeResultContent}${m.RESULT_END}`;

      // Insert at second-to-last position (before the last User message)
      // outMessages structure: [System, ...History, FakeAssistant, FakeToolResult, LastUserMessage]
      outMessages.splice(outMessages.length - 1, 0,
        { role: 'assistant', content: fakeAssistantContent },
        { role: 'user', content: fakeToolResult }
      );
    }
  }

  const merged = mergeAdjacentMessages(outMessages);

  const newRequest = { ...request, messages: merged };
  delete newRequest.tools;
  delete newRequest.tool_choice;

  return newRequest;
}

// ============ SSE parsing / formatting ============

/**
 * Minimal SSE event parser:
 * - Accumulates incoming text
 * - Splits by "\n\n" (blank line) to get events
 * - Within one event, collects multiple "data:" lines and joins with "\n" (SSE spec)
 */
class SseEventParser {
  constructor() {
    this.buffer = '';
  }

  pushText(text) {
    this.buffer += text;
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

// ============ Transparent stream transformer ============

/**
 * Creates a Transform stream that:
 * - Parses upstream SSE events
 * - Transparently forwards all fields
 * - Only intercepts/rewrites choices[].delta.content to extract AnyToolCall blocks
 * - Before [DONE], if tool calls found, injects one extra SSE json event with delta.tool_calls
 */
function createTransparentToolStreamTransformer() {
  const startMarker = delimiter.markers.TC_START;

  const parser = new SseEventParser();

  let pendingText = '';        // tail text possibly containing partial marker
  let bufferingTool = false;   // once we see marker, we buffer everything to parse at end
  let toolBuffer = '';         // buffered content from marker to end

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

  function injectToolCallsEvent(baseEvent, toolCalls) {
    // Build a minimal delta tool_calls patch event, while preserving upstream metadata.
    const evt = cloneJson(baseEvent) || {};
    if (!evt.choices || !Array.isArray(evt.choices) || evt.choices.length === 0) {
      evt.choices = [{ index: 0, delta: {}, finish_reason: null }];
    }

    // Keep existing choices length but only patch choice[0]
    const choice0 = evt.choices[0] || { index: 0, delta: {}, finish_reason: null };
    choice0.delta = choice0.delta && typeof choice0.delta === 'object' ? choice0.delta : {};
    choice0.delta.tool_calls = toolCalls.map((tc, i) => ({ index: i, ...tc }));
    // keep finish_reason null for tool call delta patch
    choice0.finish_reason = null;
    evt.choices[0] = choice0;

    // do not touch usage if present; but most patch events won't include usage
    return evt;
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      const text = chunk.toString('utf8');
      const rawEvents = parser.pushText(text);

      for (const rawEvent of rawEvents) {
        // [DONE]
        if (SseEventParser.isDoneEvent(rawEvent)) {
          // flush pendingText (as normal content) before tool parsing
          if (pendingText && !bufferingTool) {
            // We need a base envelope to emit; if none, just forward pending as raw text event is impossible.
            // We'll only emit pendingText via rewriting an existing envelope later; if none exists, drop (shouldn't happen).
          }

          if (toolBuffer) {
            const { toolCalls, cleanContent } = delimiter.parse(toolBuffer);
            // Emit remaining clean content (if any) as a final content patch event
            if (cleanContent && lastEnvelope) {
              const evt = cloneJson(lastEnvelope);
              // patch only delta.content
              if (evt.choices && evt.choices[0]) {
                evt.choices[0].delta = evt.choices[0].delta || {};
                evt.choices[0].delta.content = cleanContent;
              }
              this.push(sseEncodeJson(evt));
            }

            if (toolCalls.length > 0 && lastEnvelope) {
              const patchEvt = injectToolCallsEvent(lastEnvelope, toolCalls);
              this.push(sseEncodeJson(patchEvt));
            }
          } else if (pendingText && lastEnvelope) {
            // if we never entered bufferingTool but have pending tail, emit it
            const evt = cloneJson(lastEnvelope);
            evt.choices[0].delta = evt.choices[0].delta || {};
            evt.choices[0].delta.content = pendingText;
            this.push(sseEncodeJson(evt));
          }

          // Finally forward DONE
          this.push(sseEncodeData('[DONE]'));
          continue;
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

        // For OpenAI-style streaming: only handle choices[0].delta.content if present
        const delta = choices[0]?.delta;
        const content = delta?.content;

        // If content absent (e.g. reasoning_content-only chunk, usage-only chunk): passthrough
        if (typeof content !== 'string' || content.length === 0) {
          this.push(sseEncodeJson(parsed));
          continue;
        }

        // If already buffering tool calls: swallow content into toolBuffer, but keep other delta fields
        if (bufferingTool) {
          toolBuffer += content;

          // Transparent pass: remove content to avoid showing delimiters to client
          const outEvt = cloneJson(parsed);
          if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
            // preserve other keys (reasoning_content etc.), only remove content
            delete outEvt.choices[0].delta.content;
          }
          this.push(sseEncodeJson(outEvt));
          continue;
        }

        // Not buffering: scan for marker
        const combined = pendingText + content;
        const hit = splitByMarker(combined, startMarker);

        if (hit) {
          // emit before-text as normal content
          if (hit.before && hit.before.length > 0) {
            const outEvt = cloneJson(parsed);
            outEvt.choices[0].delta = outEvt.choices[0].delta || {};
            outEvt.choices[0].delta.content = hit.before;
            this.push(sseEncodeJson(outEvt));
          } else {
            // if before empty, we should remove content to avoid leaking marker start
            const outEvt = cloneJson(parsed);
            if (outEvt.choices?.[0]?.delta && typeof outEvt.choices[0].delta === 'object') {
              delete outEvt.choices[0].delta.content;
            }
            this.push(sseEncodeJson(outEvt));
          }

          // start buffering from marker
          toolBuffer = hit.after;
          pendingText = '';
          bufferingTool = true;
          continue;
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
      // If upstream ended abruptly without [DONE], best effort: flush pending
      if (pendingText && lastEnvelope && !bufferingTool) {
        const evt = cloneJson(lastEnvelope);
        evt.choices[0].delta = evt.choices[0].delta || {};
        evt.choices[0].delta.content = pendingText;
        this.push(sseEncodeJson(evt));
      }

      if (toolBuffer && lastEnvelope) {
        const { toolCalls, cleanContent } = delimiter.parse(toolBuffer);

        if (cleanContent) {
          const evt = cloneJson(lastEnvelope);
          evt.choices[0].delta = evt.choices[0].delta || {};
          evt.choices[0].delta.content = cleanContent;
          this.push(sseEncodeJson(evt));
        }

        if (toolCalls.length > 0) {
          const patchEvt = injectToolCallsEvent(lastEnvelope, toolCalls);
          this.push(sseEncodeJson(patchEvt));
        }
      }

      // Do not force [DONE] here; upstream should provide it in normal cases.
      callback();
    },
  });
}

// ============ Upstream URL extraction ============
function extractUpstream(reqUrl) {
  // format: /https://api.xxx/v1/chat/completions
  const match = reqUrl.match(/^\/(https?:\/\/.+)$/);
  if (!match) return null;
  return match[1];
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
    return res.status(400).json({
      error: { message: 'Invalid URL format. Use: /{upstream_url}', type: 'invalid_request' },
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

  const needsTransform = isChatCompletions && (requestHasTools || requestHasToolHistory);
  if (needsTransform) {
    body = transformRequest(body, { hasTools: requestHasTools });
  }

  // headers: forward auth and a few common keys; keep content-type
  const headers = {};
  const auth = req.headers.authorization;
  if (auth) headers['Authorization'] = auth;
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) headers['x-api-key'] = xApiKey;
  const anthropicVersion = req.headers['anthropic-version'];
  if (anthropicVersion) headers['anthropic-version'] = anthropicVersion;

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

      // Transform stream (transparent + minimal rewrite)
      const transformer = createTransparentToolStreamTransformer();

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

    // If tools enabled, parse AnyToolCall from assistant message content
    if (requestHasTools && data?.choices?.[0]?.message?.content) {
      const { toolCalls, cleanContent } = delimiter.parse(data.choices[0].message.content);
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
  console.log(`
╔═══════════════════════════════════════════════════════╗
║               🚀 AnyToolCall Proxy Started            ║
╠═══════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(47)}║
║  Logging: ${(LOG_ENABLED ? `ENABLED -> ${LOG_DIR}` : 'DISABLED').padEnd(44)}║
╠═══════════════════════════════════════════════════════╣
║  Usage: POST http://localhost:${PORT}/{upstream_url}       ║
║  Example: POST http://localhost:${PORT}/https://api.openai.com/v1/chat/completions
╚═══════════════════════════════════════════════════════╝
`);
});
