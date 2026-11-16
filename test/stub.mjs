import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const promptFile = path.resolve(
  repoRoot,
  "../agg02-work/kit/free-model-aggregator-02-kit/practice/trial-0/input/prompt.txt"
);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function parseBriefModels() {
  const content = fs.readFileSync(promptFile, "utf8");
  const marker = '"free-model-aggregator-02/models/v1"';
  const idx = content.indexOf(marker);
  const start = content.lastIndexOf("{", idx);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const parsed = JSON.parse(content.slice(start, end + 1));
  return parsed.models;
}
const briefModels = parseBriefModels();
const catalogIdsExpected = briefModels.map((m) => m.id);

function extractToken(messages) {
  const text = JSON.stringify(messages || []);
  const m = text.match(/[A-Z][A-Z0-9]*-\d+/);
  return m ? m[0] : "NO-TOKEN";
}
function stripPrefix(id) {
  return id.startsWith("openrouter/") ? id.slice("openrouter/".length) : id;
}

// ---------- Stub env ----------
const envState = { registered: null, done: false };
const envServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/register") {
      try { envState.registered = JSON.parse(body); } catch { envState.registered = null; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requests: 6 }));
    } else if (req.method === "GET" && req.url === "/work") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(envState.done ? { done: true } : { done: false, next: "p01", pending: 6 }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
});

// ---------- Stub gateway ----------
const gatewayState = { failOnce: false, counter: 0 };
const gatewayServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!(req.method === "POST" && req.url === "/v1/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found", code: "not_found" } }));
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json", code: "invalid_json" } }));
      return;
    }
    if (gatewayState.failOnce) {
      gatewayState.failOnce = false;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited", code: "rate_limit_exceeded", type: "rate_limit_error" } }));
      return;
    }
    gatewayState.counter += 1;
    const token = extractToken(parsed.messages);
    const stripped = stripPrefix(parsed.model || "");
    const isJson = parsed.response_format != null;
    const content = isJson ? JSON.stringify({ token }) : `Here is ${token}`;
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `chatcmpl-stub${gatewayState.counter}`, object: "chat.completion.chunk", created: 0, model: stripped };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: isJson ? content.slice(0, 8) : `Here is ` }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { content: isJson ? content.slice(8) : token }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } },
      ];
      for (const ch of chunks) res.write(`data: ${JSON.stringify(ch)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-stub${gatewayState.counter}`,
        object: "chat.completion",
        created: 0,
        model: stripped,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      }));
    }
  });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const envPort = await listen(envServer);
  const gwPort = await listen(gatewayServer);
  const envUrl = `http://127.0.0.1:${envPort}`;
  const gwBase = `http://127.0.0.1:${gwPort}/v1`;

  const childEnv = {
    ...process.env,
    MAKEFUN_PROMPT_FILE: promptFile,
    MAKEFUN_ENV_URL: envUrl,
    OPENAI_BASE_URL: gwBase,
    OPENAI_API_KEY: "dummy-test-key",
    ANTHROPIC_API_KEY: "dummy-test-key",
  };
  const child = spawn("node", ["main.ts"], { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let childStderr = "";
  child.stderr.on("data", (d) => { childStderr += d; });
  child.stdout.on("data", () => {});
  let exitInfo = null;
  child.on("exit", (code, signal) => { exitInfo = { code, signal }; });

  // Wait for registration
  let waited = 0;
  while (!envState.registered && waited < 15000) { await delay(100); waited += 100; }
  check("registration received", !!envState.registered, envState.registered ? `port ${envState.registered.port}` : `no register; stderr: ${childStderr.slice(0, 300)}`);
  if (!envState.registered) {
    console.log("SUMMARY 0 passed, cannot continue");
    try { child.kill(); } catch {}
    process.exit(1);
  }
  const serverPort = envState.registered.port;
  const base = `http://127.0.0.1:${serverPort}`;
  const registeredIds = (envState.registered.catalog?.providers?.[0]?.models || []).map((m) => m.id);
  check("registered catalog ids match brief", JSON.stringify([...registeredIds].sort()) === JSON.stringify([...catalogIdsExpected].sort()), `${registeredIds.length} ids`);

  // /v1/models OpenAI shape
  try {
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer dummy" } });
    const j = await r.json();
    const ids = (j.data || []).map((d) => d.id);
    check("models OpenAI shape", r.status === 200 && j.object === "list" && Array.isArray(j.data) && j.data.every((d) => d.object === "model"), `status ${r.status}`);
    check("models OpenAI ids == catalog ids", JSON.stringify([...ids].sort()) === JSON.stringify([...catalogIdsExpected].sort()) && ids.length === catalogIdsExpected.length, `${ids.length} ids`);
  } catch (e) { check("models OpenAI shape", false, String(e)); check("models OpenAI ids == catalog ids", false, String(e)); }

  // /v1/models Anthropic shape
  try {
    const r = await fetch(`${base}/v1/models`, { headers: { "x-api-key": "dummy", "anthropic-version": "2023-06-01" } });
    const j = await r.json();
    const ids = (j.data || []).map((d) => d.id);
    check("models Anthropic shape", r.status === 200 && Array.isArray(j.data) && j.has_more === false && j.data.every((d) => d.type === "model"), `status ${r.status}`);
    check("models Anthropic ids == catalog ids", JSON.stringify([...ids].sort()) === JSON.stringify([...catalogIdsExpected].sort()), `${ids.length} ids`);
    check("models Anthropic first/last", j.first_id === catalogIdsExpected[0] && j.last_id === catalogIdsExpected[catalogIdsExpected.length - 1], `${j.first_id} .. ${j.last_id}`);
  } catch (e) { check("models Anthropic shape", false, String(e)); check("models Anthropic ids == catalog ids", false, String(e)); check("models Anthropic first/last", false, String(e)); }

  // Non-stream chat completion
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Please return ECHO-1001" }], max_tokens: 100 }),
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    check("chat non-stream token echoed", r.status === 200 && content.includes("ECHO-1001"), `status ${r.status} content ${content}`);
    check("chat non-stream model is dialable", catalogIdsExpected.includes(j.model), `model ${j.model}`);
  } catch (e) { check("chat non-stream token echoed", false, String(e)); check("chat non-stream model is dialable", false, String(e)); }

  // Streaming chat completion
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "Please return ECHO-1002" }], max_tokens: 100 }),
    });
    const text = await r.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    let allContent = "", modelsOk = true, sawChunk = false;
    for (const d of dataLines) {
      if (d === "[DONE]") continue;
      const ch = JSON.parse(d);
      sawChunk = true;
      if (!catalogIdsExpected.includes(ch.model)) modelsOk = false;
      const delta = ch.choices?.[0]?.delta?.content || "";
      allContent += delta;
    }
    check("chat streaming token echoed", r.status === 200 && allContent.includes("ECHO-1002"), `content ${allContent}`);
    check("chat streaming model rewritten", sawChunk && modelsOk, "");
    check("chat streaming ends DONE", dataLines.length > 0 && dataLines[dataLines.length - 1] === "[DONE]", "");
  } catch (e) { check("chat streaming token echoed", false, String(e)); check("chat streaming model rewritten", false, String(e)); check("chat streaming ends DONE", false, String(e)); }

  // Non-stream messages
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dummy", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "auto", max_tokens: 100, system: "Be terse.", messages: [{ role: "user", content: "Please return ECHO-1003" }] }),
    });
    const j = await r.json();
    const textContent = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    check("messages non-stream shape", r.status === 200 && j.type === "message" && j.role === "assistant" && Array.isArray(j.content), `status ${r.status}`);
    check("messages non-stream token echoed", textContent.includes("ECHO-1003"), `content ${textContent}`);
    check("messages non-stream model is dialable", catalogIdsExpected.includes(j.model), `model ${j.model}`);
    check("messages non-stream usage and stop", j.usage && j.usage.input_tokens >= 0 && j.usage.output_tokens >= 1 && j.stop_reason === "end_turn", JSON.stringify(j.usage || {}));
  } catch (e) { check("messages non-stream shape", false, String(e)); check("messages non-stream token echoed", false, String(e)); check("messages non-stream model is dialable", false, String(e)); check("messages non-stream usage and stop", false, String(e)); }

  // Streaming messages
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dummy", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "auto", stream: true, max_tokens: 100, messages: [{ role: "user", content: "Please return ECHO-1004" }] }),
    });
    const text = await r.text();
    const events = [];
    let deltaText = "";
    for (const block of text.split("\n\n")) {
      const evLine = block.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!evLine) continue;
      const name = evLine.slice(6).trim();
      events.push(name);
      if (dataLine) {
        try { const obj = JSON.parse(dataLine.slice(5).trim()); if (obj.delta && obj.delta.type === "text_delta") deltaText += obj.delta.text; } catch {}
      }
    }
    const orderOk = events[0] === "message_start" && events[events.length - 1] === "message_stop" &&
      events.includes("content_block_start") && events.includes("content_block_delta") &&
      events.includes("content_block_stop") && events.includes("message_delta") &&
      events.indexOf("message_delta") < events.indexOf("message_stop");
    check("messages streaming event order", r.status === 200 && orderOk, events.join(","));
    check("messages streaming token echoed", deltaText.includes("ECHO-1004"), `deltas ${deltaText}`);
  } catch (e) { check("messages streaming event order", false, String(e)); check("messages streaming token echoed", false, String(e)); }

  // JSON mode
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Return JSON with ECHO-1005" }], max_tokens: 100, response_format: { type: "json_object" } }),
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    let parsedOk = false;
    try { const o = JSON.parse(content); parsedOk = JSON.stringify(o).includes("ECHO-1005"); } catch {}
    const modelRow = briefModels.find((m) => m.id === j.model);
    check("json mode token in JSON object", r.status === 200 && parsedOk, `content ${content}`);
    check("json mode model supports json", !!modelRow && modelRow.json === true, `model ${j.model}`);
  } catch (e) { check("json mode token in JSON object", false, String(e)); check("json mode model supports json", false, String(e)); }

  // Tools request with 429 failover
  try {
    gatewayState.failOnce = true;
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Use a tool or return ECHO-1006" }],
        max_tokens: 100,
        tools: [{ type: "function", function: { name: "get_token", description: "gets token", parameters: { type: "object", properties: {} } } }],
      }),
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    const header = r.headers.get("x-makefun-upstream-failures");
    let rows = null;
    try { rows = header ? JSON.parse(header) : null; } catch {}
    check("tools failover still served", r.status === 200 && content.includes("ECHO-1006"), `status ${r.status} content ${content}`);
    check("tools failover header 1 row 429", Array.isArray(rows) && rows.length === 1 && rows[0].status === 429 && catalogIdsExpected.includes(rows[0].model), `header ${header}`);
  } catch (e) { check("tools failover still served", false, String(e)); check("tools failover header 1 row 429", false, String(e)); }

  // --list
  try {
    const listOut = await new Promise((resolve, reject) => {
      const p = spawn("node", ["main.ts", "--list"], { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code} ${err}`))));
    });
    const parsed = JSON.parse(listOut);
    const ids = (parsed.providers?.[0]?.models || []).map((m) => m.id);
    check("--list parses and ids match registered", JSON.stringify([...ids].sort()) === JSON.stringify([...registeredIds].sort()), `${ids.length} ids`);
  } catch (e) { check("--list parses and ids match registered", false, String(e)); }

  // Flip done and assert exit 0
  envState.done = true;
  let exitWaited = 0;
  while (!exitInfo && exitWaited < 15000) { await delay(100); exitWaited += 100; }
  check("server exits 0 on done", !!exitInfo && exitInfo.code === 0, exitInfo ? `code ${exitInfo.code}` : "still running");
  if (!exitInfo) { try { child.kill(); } catch {} }

  envServer.close();
  gatewayServer.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`SUMMARY ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
