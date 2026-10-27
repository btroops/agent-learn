/**
 * Day 1：非流式裸调，把真实响应原样打出来，作为 types.ts 的唯一对照物。
 * 不 import 任何 SDK，只用原生 fetch。
 *
 * 运行（在 mini-harness/ts 下）：
 *   node --env-file=../.env src/smoke.ts --models    # 先列可用模型，确定 LLM_MODEL
 *   node --env-file=../.env src/smoke.ts             # 再发一次非流式对话
 *   node --env-file=../.env src/smoke.ts --headers   # 额外打印响应头，Day6 记录限流头用
 *   node --env-file=../.env src/smoke.ts --with-tools # 附带工具定义，验证 prompt_tokens 是否含工具定义
 *   node --env-file=../.env src/smoke.ts --save=../notes/samples/x.json # 原始响应落盘
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "./types.ts";

/** 同一条 prompt 的工具版：只用来对比 prompt_tokens 与拿 tool_calls 形状 */
const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询指定城市的实时天气",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名，例如：北京" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["city"],
    },
  },
};

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error("缺少 LLM_BASE_URL / LLM_API_KEY，请先按 .env.example 填 mini-harness/.env");
}

const api = baseUrl.replace(/\/+$/, "");
const args = process.argv.slice(2);
const authHeaders = { authorization: `Bearer ${apiKey}` };
const saveTarget = args.find((a) => a.startsWith("--save="))?.slice("--save=".length);

/** URL 里的 path token 一律打码；API Key 只存在于请求头，从不进落盘文件 */
function redactUrl(url: string): string {
  return url.replace(/\/s\/u\/[^/]+\//, "/s/u/***/");
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key] = value;
  return out;
}

async function saveSample(payload: Record<string, unknown>): Promise<void> {
  if (!saveTarget) return;
  await mkdir(dirname(saveTarget), { recursive: true });
  await writeFile(saveTarget, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\n已落盘: ${saveTarget}`);
}

async function listModels(): Promise<void> {
  const url = `${api}/models`;
  console.log("GET", url);

  const res = await fetch(url, { headers: authHeaders });
  const text = await res.text();
  console.log(`\n=== HTTP ${res.status} ${res.statusText} ===`);
  console.log(text);

  try {
    const body = JSON.parse(text) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      console.log("\n=== 可用模型 id（填进 .env 的 LLM_MODEL）===");
      for (const id of ids) console.log(" -", id);
    }
  } catch {
    console.log("\n响应不是 JSON，该网关可能未开放 /models，直接向运维要模型名");
  }

  await saveSample({
    capturedAt: new Date().toISOString(),
    endpoint: redactUrl(url),
    http: { status: res.status, headers: headersToObject(res.headers) },
    raw: text,
  });
}

async function chat(): Promise<void> {
  const model = process.env.LLM_MODEL;
  if (!model) {
    throw new Error("LLM_MODEL 为空：先跑 `node --env-file=../.env src/smoke.ts --models` 确认模型名");
  }

  const url = `${api}/chat/completions`;
  const showHeaders = args.includes("--headers");
  const withTools = args.includes("--with-tools");

  // A/B 只差一个 tools 字段，prompt 完全相同，这样 prompt_tokens 的差值就是工具定义的 token 数
  const requestBody = {
    model,
    messages: [{ role: "user", content: "北京现在天气怎么样？" }],
    ...(withTools ? { tools: [WEATHER_TOOL] } : {}),
  };

  console.log("POST", url);
  console.log("附带工具定义:", withTools);
  console.log("请求体:", JSON.stringify(requestBody));

  const startedAt = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify(requestBody),
  });
  const text = await res.text();
  const elapsed = Math.round(performance.now() - startedAt);

  console.log(`\n=== HTTP ${res.status} ${res.statusText} (${elapsed}ms) ===`);
  console.log("content-type:", res.headers.get("content-type"));

  if (showHeaders) {
    console.log("\n=== 响应头 ===");
    for (const [key, value] of res.headers) console.log(`${key}: ${value}`);
  }

  console.log("\n=== 原始响应体 ===");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(text);
    throw new Error("响应不是 JSON：检查 BASE_URL 是否写错（常见问题：少了版本前缀或重复了 /chat/completions）");
  }

  // usage 是 Day1 验收点：prompt_tokens 含 system + 工具定义 + 全部历史消息
  const usage = (parsed as { usage?: Record<string, number> }).usage;
  console.log("\n=== usage ===");
  console.log(usage ?? "无 usage 字段：记进 notes，该网关非流式也不返回");

  await saveSample({
    capturedAt: new Date().toISOString(),
    endpoint: redactUrl(url),
    requestBody,
    http: { status: res.status, headers: headersToObject(res.headers), elapsedMs: elapsed },
    response: parsed,
  });
}

if (args.includes("--models")) {
  await listModels();
} else {
  await chat();
}
