import * as http from "node:http";
import * as fs from "node:fs";

interface BriefModel {
  id: string;
  rating: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  display_name: string;
}

interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: CatalogModel[];
  }>;
}

let idCounter = 0;
function nextSeq(): number {
  idCounter += 1;
  return idCounter;
}

// ---------- Brief parsing ----------

function extractJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const start = text.lastIndexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseBrief(content: string): BriefModel[] {
  const raw = extractJsonObject(content, '"free-model-aggregator-02/models/v1"');
  if (!raw) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr: any[] = Array.isArray(parsed.models) ? parsed.models : [];
  const out: BriefModel[] = [];
  const seen = new Set<string>();
  for (const m of arr) {
    if (!m || typeof m.id !== "string") continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      rating: typeof m.rating_milli === "number" ? m.rating_milli : 0,
      context_length: typeof m.context_length === "number" ? m.context_length : null,
      tools: m.tools === true,
      vision: m.vision === true,
      json: m.json === true,
      display_name: typeof m.display_name === "string" ? m.display_name : m.id,
    });
  }
  return out;
}

function loadModels(): BriefModel[] {
  const file = process.env.MAKEFUN_PROMPT_FILE;
  if (!file) return [];
  try {
    const content = fs.readFileSync(file, "utf8");
    return parseBrief(content);
  } catch {
    return [];
  }
}

const briefModels: BriefModel[] = loadModels();

function buildCatalog(): Catalog {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: briefModels.map((m) => ({
          id: m.id,
          free: true,
          context_length: m.context_length,
        })),
      },
    ],
  };
}

const catalog: Catalog = buildCatalog();

// ---------- Helpers ----------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  obj: unknown,
  extra: Record<string, string> = {}
): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(body);
}

function openaiError(res: http.ServerResponse, status: number, message: string, code: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type: "upstream_error", code } }, extra);
}

function anthropicError(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { type: "error", error: { type: "api_error", message } }, extra);
}

function mapStopReason(fr: unknown): string {
  if (fr === "stop") return "end_turn";
  if (fr === "length") return "max_tokens";
  if (fr === "tool_calls") return "tool_use";
  if (fr === "function_call") return "tool_use";
  return "end_turn";
}

function failuresHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { "x-makefun-upstream-failures": JSON.stringify(failures.slice(0, 8)) };
}

// ---------- Request analysis ----------

interface Needs {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

function openaiNeeds(body: any): Needs {
  let vision = false;
  let toolHistory = false;
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object") continue;
    // A conversation already carrying tool calls or tool results can only be
    // continued by a tools-capable model, even if this turn declares no tools.
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) toolHistory = true;
    if (msg.role === "tool" || msg.role === "function") toolHistory = true;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && (part.type === "image_url" || part.type === "image" || part.type === "input_image" || part.image_url)) vision = true;
      }
    }
  }
  return {
    tools: (Array.isArray(body.tools) && body.tools.length > 0) || toolHistory,
    vision,
    json: body.response_format != null,
  };
}

function anthropicNeeds(body: any): Needs {
  let vision = false;
  let toolHistory = false;
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "image") vision = true;
        if (part && (part.type === "tool_use" || part.type === "tool_result")) toolHistory = true;
      }
    }
  }
  return {
    tools: (Array.isArray(body.tools) && body.tools.length > 0) || toolHistory,
    vision,
    json: false,
  };
}

function pickCandidates(needs: Needs): BriefModel[] {
  const sorted = [...briefModels].sort((a, b) => b.rating - a.rating);
  const qualifying = sorted.filter(
    (m) => (!needs.tools || m.tools) && (!needs.vision || m.vision) && (!needs.json || m.json)
  );
  return qualifying.length > 0 ? qualifying : sorted;
}

// ---------- Anthropic -> OpenAI translation ----------

function anthropicSystemToText(system: any): string | null {
  if (system == null) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const b of system) {
      if (b && typeof b.text === "string") parts.push(b.text);
      else if (typeof b === "string") parts.push(b);
    }
    return parts.join("");
  }
  return null;
}

function translateAnthropicMessages(body: any): any[] {
  const out: any[] = [];
  const sys = anthropicSystemToText(body.system);
  if (sys != null) out.push({ role: "system", content: sys });
  const msgs: any[] = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of msgs) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push({ role, content: "" });
      continue;
    }
    // Sequential translation, flushing buffered normal content before specials.
    let textParts: any[] = [];
    let toolCalls: any[] = [];
    const flush = () => {
      if (textParts.length === 0 && toolCalls.length === 0) return;
      if (role === "assistant" && toolCalls.length > 0) {
        const text = textParts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        const m: any = { role: "assistant", content: text.length > 0 ? text : null, tool_calls: toolCalls };
        out.push(m);
      } else if (textParts.length === 1 && textParts[0].type === "text") {
        out.push({ role, content: textParts[0].text });
      } else if (textParts.length > 0) {
        out.push({ role, content: textParts });
      }
      textParts = [];
      toolCalls = [];
    };
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        textParts.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
      } else if (block.type === "image") {
        const src = block.source || {};
        const media = typeof src.media_type === "string" ? src.media_type : "image/png";
        const data = typeof src.data === "string" ? src.data : "";
        textParts.push({ type: "image_url", image_url: { url: `data:${media};base64,${data}` } });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `call_${nextSeq()}`,
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "",
            arguments: JSON.stringify(block.input != null ? block.input : {}),
          },
        });
      } else if (block.type === "tool_result") {
        flush();
        let contentText = "";
        if (typeof block.content === "string") contentText = block.content;
        else if (Array.isArray(block.content)) {
          contentText = block.content
            .filter((b: any) => b && b.type === "text")
            .map((b: any) => b.text)
            .join("");
        }
        out.push({
          role: "tool",
          tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: contentText,
        });
      }
    }
    flush();
    // A message whose content produced nothing still needs representation.
    if (msg.content.length === 0) out.push({ role, content: "" });
  }
  return out;
}

function translateAnthropicTools(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t: any) => ({
    type: "function",
    function: {
      name: t && typeof t.name === "string" ? t.name : "",
      description: t && typeof t.description === "string" ? t.description : undefined,
      parameters: t && t.input_schema != null ? t.input_schema : { type: "object", properties: {} },
    },
  }));
}

function translateAnthropicToolChoice(tc: any): any {
  if (tc == null) return undefined;
  if (typeof tc === "string") return tc;
  if (tc.type === "tool" && typeof tc.name === "string") {
    return { type: "function", function: { name: tc.name } };
  }
  if (tc.type === "any") return "required";
  if (tc.type === "auto") return "auto";
  if (tc.type === "none") return "none";
  return undefined;
}

// ---------- Gateway body ----------

function resolveCap(body: any): number {
  const raw = body.max_tokens != null ? body.max_tokens : body.max_completion_tokens != null ? body.max_completion_tokens : body.max_output_tokens;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), 8192);
  }
  return 1024;
}

function buildGatewayBody(wire: string, body: any, modelId: string): any {
  const stream = body.stream === true;
  const gw: any = { model: modelId, max_tokens: resolveCap(body), stream };
  if (wire === "openai") {
    gw.messages = Array.isArray(body.messages) ? body.messages : [];
    if (body.temperature != null) gw.temperature = body.temperature;
    if (body.top_p != null) gw.top_p = body.top_p;
    if (body.response_format != null) gw.response_format = body.response_format;
    if (body.tools != null) gw.tools = body.tools;
    if (body.tool_choice != null) gw.tool_choice = body.tool_choice;
    if (body.stop != null) gw.stop = body.stop;
  } else {
    gw.messages = translateAnthropicMessages(body);
    if (body.temperature != null) gw.temperature = body.temperature;
    if (body.top_p != null) gw.top_p = body.top_p;
    const tools = translateAnthropicTools(body.tools);
    if (tools) gw.tools = tools;
    const tc = translateAnthropicToolChoice(body.tool_choice);
    if (tc !== undefined) gw.tool_choice = tc;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) gw.stop = body.stop_sequences;
  }
  if (stream) gw.stream_options = { include_usage: true };
  return gw;
}

function gatewayUrl(): string {
  const base = (process.env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

// ---------- Anthropic non-stream translation ----------

function translateToAnthropic(gwJson: any, dialedId: string): any {
  const choice = gwJson && Array.isArray(gwJson.choices) && gwJson.choices.length > 0 ? gwJson.choices[0] : {};
  const message = choice && choice.message ? choice.message : {};
  const content: any[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc && tc.function ? tc.function : {};
      let input: any = {};
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = {};
        }
      } else if (fn.arguments != null && typeof fn.arguments === "object") {
        input = fn.arguments;
      }
      content.push({
        type: "tool_use",
        id: typeof tc.id === "string" ? tc.id : `toolu_${nextSeq()}`,
        name: typeof fn.name === "string" ? fn.name : "",
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const usage = gwJson && gwJson.usage ? gwJson.usage : {};
  const gid = gwJson && typeof gwJson.id === "string" && gwJson.id.length > 0 ? gwJson.id : String(nextSeq());
  return {
    id: `msg_${gid}`,
    type: "message",
    role: "assistant",
    model: dialedId,
    content,
    stop_reason: mapStopReason(choice ? choice.finish_reason : null),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    },
  };
}

// ---------- Streaming: Anthropic conversion ----------

interface AnthropicStreamState {
  started: boolean;
  textOpen: boolean;
  textClosed: boolean;
  toolBlocks: Map<number, number>;
  openBlockIndex: number | null;
  nextBlockIndex: number;
  finishReason: unknown;
  outputTokens: number;
  inputTokens: number;
  msgId: string;
}

function anthropicEvent(res: http.ServerResponse, name: string, obj: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`);
}

async function streamAnthropic(
  res: http.ServerResponse,
  gwRes: Response,
  dialedId: string,
  failures: FailureRow[]
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...failuresHeader(failures),
  });
  const state: AnthropicStreamState = {
    started: false,
    textOpen: false,
    textClosed: false,
    toolBlocks: new Map(),
    openBlockIndex: null,
    nextBlockIndex: 1,
    finishReason: null,
    outputTokens: 0,
    inputTokens: 0,
    msgId: `msg_${nextSeq()}`,
  };
  const ensureStart = () => {
    if (state.started) return;
    state.started = true;
    anthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: state.msgId,
        type: "message",
        role: "assistant",
        model: dialedId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    });
    anthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    state.textOpen = true;
    state.openBlockIndex = 0;
  };
  const closeText = () => {
    if (state.textOpen) {
      anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      state.textOpen = false;
      state.textClosed = true;
      if (state.openBlockIndex === 0) state.openBlockIndex = null;
    }
  };

  const reader = (gwRes.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleChunk = (chunk: any) => {
    if (chunk && typeof chunk.id === "string" && chunk.id.length > 0) {
      // Keep a deterministic id derived from the gateway's id.
      state.msgId = `msg_${chunk.id}`;
    }
    if (chunk && chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number") state.inputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") state.outputTokens = chunk.usage.completion_tokens;
    }
    const choices: any[] = chunk && Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (choice && choice.finish_reason != null) state.finishReason = choice.finish_reason;
      const delta = choice && choice.delta ? choice.delta : {};
      ensureStart();
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!state.textOpen && !state.textClosed) {
          // text was never opened; open it now
          anthropicEvent(res, "content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          state.textOpen = true;
          state.openBlockIndex = 0;
        }
        if (state.textOpen) {
          anthropicEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          closeText();
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;
          let blockIndex = state.toolBlocks.get(tcIndex);
          if (blockIndex === undefined) {
            blockIndex = state.nextBlockIndex;
            state.nextBlockIndex += 1;
            state.toolBlocks.set(tcIndex, blockIndex);
            const fn = tc.function || {};
            anthropicEvent(res, "content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: typeof tc.id === "string" ? tc.id : `toolu_${nextSeq()}`,
                name: typeof fn.name === "string" ? fn.name : "",
                input: {},
              },
            });
            state.openBlockIndex = blockIndex;
          }
          const args = tc.function && typeof tc.function.arguments === "string" ? tc.function.arguments : "";
          if (args.length > 0) {
            anthropicEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            });
          }
        }
      }
    }
    if (choices.length === 0 && chunk && chunk.usage) {
      ensureStart();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      if (data.length === 0) continue;
      try {
        handleChunk(JSON.parse(data));
      } catch {
        // ignore malformed gateway chunk
      }
    }
  }
  ensureStart();
  // Close whichever block is open.
  if (state.textOpen) {
    anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    state.textOpen = false;
  } else if (state.openBlockIndex != null) {
    anthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: state.openBlockIndex });
    state.openBlockIndex = null;
  }
  anthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: mapStopReason(state.finishReason), stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  });
  anthropicEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ---------- Streaming: OpenAI forwarding ----------

async function streamOpenAI(
  res: http.ServerResponse,
  gwRes: Response,
  dialedId: string,
  failures: FailureRow[]
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...failuresHeader(failures),
  });
  const reader = (gwRes.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      if (trimmed.length > 0) res.write(`${line}\n`);
      return;
    }
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      res.write("data: [DONE]\n\n");
      return;
    }
    if (data.length === 0) return;
    try {
      const chunk = JSON.parse(data);
      chunk.model = dialedId;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } catch {
      res.write(`${line}\n`);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      emitLine(line);
    }
  }
  if (buf.trim().length > 0) emitLine(buf);
  res.end();
}

// ---------- Core completion handler with failover ----------

async function handleCompletion(
  wire: string,
  body: any,
  res: http.ServerResponse
): Promise<void> {
  const needs = wire === "openai" ? openaiNeeds(body) : anthropicNeeds(body);
  const candidates = pickCandidates(needs);
  const failures: FailureRow[] = [];
  const isStream = body.stream === true;
  const apiKey = process.env.OPENAI_API_KEY || "";

  if (candidates.length === 0) {
    const msg = "no models available";
    if (wire === "openai") openaiError(res, 502, msg, "fetch_error");
    else anthropicError(res, 502, msg);
    return;
  }

  for (const candidate of candidates) {
    const gwBody = buildGatewayBody(wire, body, candidate.id);
    let gwRes: Response;
    try {
      gwRes = await fetch(gatewayUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(gwBody),
      });
    } catch (err: any) {
      failures.push({ status: 0, code: "fetch_error", model: candidate.id });
      continue;
    }
    if (!gwRes.ok) {
      let code = `http_${gwRes.status}`;
      try {
        const errText = await gwRes.text();
        if (errText) {
          try {
            const errJson = JSON.parse(errText);
            const e = errJson && errJson.error ? errJson.error : errJson;
            if (e && typeof e.code === "string" && e.code.length > 0) code = e.code;
            else if (e && typeof e.type === "string" && e.type.length > 0) code = e.type;
            else if (e && typeof e.code === "number") code = String(e.code);
          } catch {
            // keep http_ code
          }
        }
      } catch {
        // keep http_ code
      }
      failures.push({ status: gwRes.status, code, model: candidate.id });
      continue;
    }

    // Success path.
    try {
      if (isStream) {
        if (wire === "openai") await streamOpenAI(res, gwRes, candidate.id, failures);
        else await streamAnthropic(res, gwRes, candidate.id, failures);
        return;
      }
      const text = await gwRes.text();
      let gwJson: any = null;
      try {
        gwJson = JSON.parse(text);
      } catch {
        gwJson = null;
      }
      if (gwJson == null) {
        // Gateway said 200 but body is not JSON: treat as failure and fail over.
        failures.push({ status: gwRes.status, code: "invalid_response", model: candidate.id });
        continue;
      }
      if (wire === "openai") {
        gwJson.model = candidate.id;
        sendJson(res, 200, gwJson, failuresHeader(failures));
      } else {
        const translated = translateToAnthropic(gwJson, candidate.id);
        sendJson(res, 200, translated, failuresHeader(failures));
      }
      return;
    } catch (err) {
      // If headers already sent (streaming), we cannot fail over.
      if (res.headersSent) {
        try { res.end(); } catch { /* noop */ }
        return;
      }
      failures.push({ status: 0, code: "fetch_error", model: candidate.id });
      continue;
    }
  }

  const last = failures.length > 0 ? failures[failures.length - 1] : { status: 502, code: "fetch_error", model: null as string | null };
  const status = last.status >= 400 && last.status <= 599 ? last.status : 502;
  const message = `upstream failed with ${last.code}`;
  if (wire === "openai") openaiError(res, status, message, last.code);
  else anthropicError(res, status, message);
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/v1/models") {
      const ids = briefModels.map((m) => m.id);
      const hasAuth = req.headers["authorization"] != null;
      const hasApiKey = req.headers["x-api-key"] != null;
      if (!hasAuth && hasApiKey) {
        sendJson(res, 200, {
          data: ids.map((id) => {
            const bm = briefModels.find((m) => m.id === id);
            return {
              id,
              type: "model",
              display_name: bm ? bm.display_name : id,
              created_at: "1970-01-01T00:00:00Z",
            };
          }),
          has_more: false,
          first_id: ids.length > 0 ? ids[0] : null,
          last_id: ids.length > 0 ? ids[ids.length - 1] : null,
        });
      } else {
        sendJson(res, 200, {
          object: "list",
          data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "openrouter" })),
        });
      }
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
      const wire = path === "/v1/messages" ? "anthropic" : "openai";
      const raw = await readBody(req);
      let body: any;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        if (wire === "openai") openaiError(res, 400, "malformed JSON body", "invalid_json");
        else anthropicError(res, 400, "malformed JSON body");
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        if (wire === "openai") openaiError(res, 400, "request body must be a JSON object", "invalid_json");
        else anthropicError(res, 400, "request body must be a JSON object");
        return;
      }
      await handleCompletion(wire, body, res);
      return;
    }

    // Unknown path.
    if (path === "/v1/messages") anthropicError(res, 404, "not found");
    else openaiError(res, 404, "not found", "not_found");
  } catch (err) {
    if (!res.headersSent) {
      try {
        openaiError(res, 500, "internal error", "internal_error");
      } catch { /* noop */ }
    } else {
      try { res.end(); } catch { /* noop */ }
    }
  }
});

// ---------- Main ----------

async function registerAndPoll(port: number): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL || "").replace(/\/+$/, "");
  // Register with retries.
  while (true) {
    try {
      const r = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
      });
      if (r.ok) {
        // Consume body so the socket can close cleanly.
        try { await r.text(); } catch { /* noop */ }
        break;
      }
      try { await r.text(); } catch { /* noop */ }
    } catch {
      // retry
    }
    await delay(500);
  }
  // Poll work.
  while (true) {
    await delay(1000);
    try {
      const r = await fetch(`${envUrl}/work`);
      if (r.ok) {
        const j: any = await r.json();
        if (j && j.done === true) break;
      }
    } catch {
      // keep polling
    }
  }
  server.close(() => {
    process.exit(0);
  });
  // Safety: if close hangs because of keep-alive sockets, exit shortly.
  setTimeout(() => process.exit(0), 500).unref();
}

if (process.argv.includes("--list")) {
  process.stdout.write(`${JSON.stringify(catalog)}\n`);
  process.exit(0);
} else {
  server.listen(0, "0.0.0.0", () => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    if (process.env.MAKEFUN_ENV_URL) {
      void registerAndPoll(port);
    }
  });
}
