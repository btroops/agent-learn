/**
 * Day 6：故障形态实测（只观测，不实现重试）。
 *
 * 目的：拿到 4 类故障的**真实**响应，作为 W3 重试策略的依据。
 * 每个场景记录：HTTP 状态码 / 响应头 / 响应体 / 是否发生在 SSE 流中途 / 错误格式是否与非流式一致。
 *
 * 分层判定（写死在这一个地方，避免每个场景自己解释）：
 * - connection：HTTP 非 2xx、fetch 失败、读流中途被打断 —— 请求没进入正常的事件流
 * - application：HTTP 200 正常建立流，但流里出现 error 负载
 * - none：正常完成
 *
 * 运行（在 mini-harness/ts 下）：
 *   node --env-file=../.env src/probe.ts                       # 除 429 外的全部场景
 *   node --env-file=../.env src/probe.ts --with-rate-limit     # 额外做 429 并发冲击（打网关，慎用）
 *   node --env-file=../.env src/probe.ts --rate-limit=16       # 指定并发数
 *   node --env-file=../.env src/probe.ts --only=disconnect,timeout-total
 *   node --env-file=../.env src/probe.ts --out=../notes/error-samples
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDoneEvent } from "./sse.ts";
import { readSSEStream, streamChatCompletion } from "./stream.ts";

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
const badModel = process.env.LLM_BAD_MODEL ?? "no-such-model";

if (!baseUrl || !apiKey || !model) {
  throw new Error("缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，请先按 .env.example 填 mini-harness/.env");
}

const api = baseUrl.replace(/\/+$/, "");
const args = process.argv.slice(2);
const outDir = args.find((a) => a.startsWith("--out="))?.slice("--out=".length) ?? "../notes/error-samples";
const only = (args.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const rateLimitConcurrency = Number(
  args.find((a) => a.startsWith("--rate-limit="))?.slice("--rate-limit=".length) ?? "8",
);
const withRateLimit = args.includes("--with-rate-limit") || only.includes("429");

/** 只有显式 --only 时才按名单过滤；默认跑除 429 外的全部 */
function wanted(scenario: string): boolean {
  if (only.length > 0) return only.includes(scenario);
  return scenario !== "429";
}

// ---------- 记录结构 ----------

type Layer = "connection" | "application" | "none";

interface StreamErrorEvent {
  atEventIndex: number;
  atMs: number;
  raw: string;
  parsed: unknown;
}

interface Capture {
  scenario: string;
  /** gateway = 真实网关；local-mock = 本地构造，用于验证解析器行为，不冒充网关样本 */
  source: "gateway" | "local-mock";
  capturedAt: string;
  layer: Layer;
  /** 跑之前预期看到什么，跑完对照，不一致时 notes 必须写明 */
  hypothesis: string;
  request: Record<string, unknown>;
  http: {
    status: number;
    statusText: string;
    contentType: string | null;
    /** 单独挑出来：限流头存不存在，直接决定重试策略能不能依赖它 */
    rateLimitHeaders: Record<string, string>;
    headers: Record<string, string>;
    /** 非 2xx 时的响应体原文（截断），这是"错误格式"的直接证据 */
    bodyText?: string;
    bodyJson?: unknown;
  } | null;
  timing: {
    requestStartedAt: string;
    /** fetch resolve，即响应头到齐 */
    responseHeadersMs: number | null;
    /** 第一个 body 分片，工程意义上的"首字节"（更接近首 token） */
    firstBodyByteMs: number | null;
    lastEventMs: number | null;
    totalMs: number;
    /** 本地主动 abort 发生的时刻 */
    abortedAtMs: number | null;
  };
  stream: {
    eventCount: number;
    chunkCount: number;
    bytesReceived: number;
    endedWithDone: boolean;
    /** 流里出现 error 负载的位置，秒不掉就是它 */
    errorEvent: StreamErrorEvent | null;
    firstEventData: string | null;
    lastEventData: string | null;
  } | null;
  failure: {
    name: string;
    message: string;
    code?: string;
    /** 本地主动触发的动作：first-byte-timeout / total-timeout / client-cancel */
    abortedBy: string | null;
  } | null;
  notes: string[];
}

// ---------- 工具 ----------

// 网关 host、path token、Bearer、sk- 一律打码；样本要能进 git。
// host 也必须打码：只藏 path token 不够，域名本身同样是内网信息。
const gatewayOrigin = new URL(baseUrl).origin;

function redact(text: string): string {
  return text
    .replaceAll(gatewayOrigin, "https://***")
    .replace(/\/s\/u\/[^/]+\//g, "/s/u/***/")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    // cookie 与鉴权头不落盘；其余全留，限流头/网关头都在这里
    if (["set-cookie", "authorization", "proxy-authorization"].includes(key.toLowerCase())) continue;
    out[key] = redact(value);
  }
  return out;
}

function pickRateLimitHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/ratelimit|retry-after/i.test(key)) out[key] = value;
  }
  return out;
}

function errorInfo(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { name: err.name, message: redact(err.message), ...(code ? { code } : {}) };
  }
  return { name: typeof err, message: redact(String(err)) };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------- 核心：发一次流式请求，把整个过程记下来 ----------

interface CaptureOptions {
  /** 首字节超时：收到第一个 body 分片就撤销 */
  firstByteTimeoutMs?: number;
  /** 总时长超时：从请求发出开始，不撤销 */
  totalTimeoutMs?: number;
  /** 收到 N 个 SSE 事件后主动 abort，模拟客户端断连 */
  abortAfterEvents?: number;
  /**
   * 请求发出后 N ms 主动 abort。
   * 比 abortAfterEvents 可靠：这个网关把数据攒成 15KB 才 flush，
   * 首片里往往已有几十个事件，"按事件数"会瞬间读完、根本不在传输中途。
   */
  abortAfterMs?: number;
  /**
   * 首片到达后 N ms 主动 abort。
   * 最可靠的"流中途"定义：首片时间在 1.4-4s 间波动，绝对时刻很难同时满足
   * "首片已到"且"流还没结束"，用相对首片的偏移才能稳定落在两片之间的真空期。
   */
  abortAfterFirstByteMs?: number;
  /** 流式请求体是否带 stream:true（由本函数强制加） */
  stopAfterFirstErrorEvent?: boolean;
}

async function captureStreaming(
  scenario: string,
  requestBody: Record<string, unknown>,
  hypothesis: string,
  options: CaptureOptions = {},
): Promise<Capture> {
  const url = `${api}/chat/completions`;
  const startedAtEpochMs = Date.now();
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);

  const controller = new AbortController();
  let abortedBy: string | null = null;
  let abortedAtMs: number | null = null;
  const abortWith = (why: string): void => {
    if (abortedBy !== null) return;
    abortedBy = why;
    abortedAtMs = elapsed();
    controller.abort(new Error(why));
  };

  const timers: NodeJS.Timeout[] = [];
  let firstByteTimer: NodeJS.Timeout | undefined;
  if (options.firstByteTimeoutMs !== undefined) {
    firstByteTimer = setTimeout(() => abortWith("first-byte-timeout"), options.firstByteTimeoutMs);
    timers.push(firstByteTimer);
  }
  if (options.totalTimeoutMs !== undefined) {
    timers.push(setTimeout(() => abortWith("total-timeout"), options.totalTimeoutMs));
  }
  if (options.abortAfterMs !== undefined) {
    timers.push(setTimeout(() => abortWith("client-cancel"), options.abortAfterMs));
  }

  let responseHeadersMs: number | null = null;
  let firstBodyByteMs: number | null = null;
  let lastEventMs: number | null = null;
  let bytesReceived = 0;
  let eventCount = 0;
  let chunkCount = 0;
  let endedWithDone = false;
  let firstEventData: string | null = null;
  let lastEventData: string | null = null;
  let errorEvent: StreamErrorEvent | null = null;
  let http: Capture["http"] = null;
  let failure: Capture["failure"] = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...requestBody, stream: true }),
      signal: controller.signal,
    });
    responseHeadersMs = elapsed();

    const headerObj = headersToObject(res.headers);
    http = {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      rateLimitHeaders: pickRateLimitHeaders(headerObj),
      headers: headerObj,
    };

    if (!res.ok) {
      const text = await res.text();
      http.bodyText = redact(text.slice(0, 4000));
      http.bodyJson = tryJson(text);
      return finish(res.status >= 400 ? "connection" : "none");
    }
    if (!res.body) throw new Error("响应没有 body，无法按流处理");

    const stream = readSSEStream(res.body, (raw) => {
      bytesReceived += raw.data.byteLength;
      if (firstBodyByteMs === null) {
        firstBodyByteMs = elapsed();
        if (firstByteTimer) clearTimeout(firstByteTimer);
        if (options.abortAfterFirstByteMs !== undefined) {
          timers.push(setTimeout(() => abortWith("client-cancel"), options.abortAfterFirstByteMs));
        }
      }
    });

    for await (const event of stream) {
      eventCount += 1;
      lastEventMs = elapsed();
      if (firstEventData === null) firstEventData = redact(event.data.slice(0, 300));
      lastEventData = redact(event.data.slice(0, 300));

      if (options.abortAfterEvents !== undefined && eventCount >= options.abortAfterEvents) {
        abortWith("client-cancel");
      }

      if (isDoneEvent(event)) {
        endedWithDone = true;
        break;
      }

      const parsed = tryJson(event.data);
      if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
        errorEvent ??= {
          atEventIndex: eventCount - 1,
          atMs: elapsed(),
          raw: redact(event.data.slice(0, 2000)),
          parsed,
        };
        if (options.stopAfterFirstErrorEvent) break;
      }
      chunkCount += 1;
    }
    return finish("none");
  } catch (err) {
    const info = errorInfo(err);
    failure = { ...info, abortedBy };
    // 已经有 errorEvent 说明流本身是 200 且已建立，归应用层；否则算连接层
    return finish(errorEvent !== null ? "application" : "connection");
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }

  function finish(layer: Layer): Capture {
    return {
      scenario,
      source: "gateway",
      capturedAt: new Date().toISOString(),
      layer,
      hypothesis,
      request: {
        endpoint: `${redact(api)}/chat/completions`,
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: requestBody,
      },
      http,
      timing: {
        requestStartedAt: new Date(startedAtEpochMs).toISOString(),
        responseHeadersMs,
        firstBodyByteMs,
        lastEventMs,
        totalMs: elapsed(),
        abortedAtMs,
      },
      stream: http?.status === 200
        ? {
            eventCount,
            chunkCount,
            bytesReceived,
            endedWithDone,
            errorEvent,
            firstEventData,
            lastEventData,
          }
        : null,
      failure,
      notes: [],
    };
  }
}

// ---------- 场景 ----------

const PROMPT = "用一句话说明什么是 TCP。";

/** ①② 5xx / 4xx：不存在的模型、非法参数。流式与非流式各一次，比较错误格式是否一致 */
async function probeBadModel(): Promise<Capture[]> {
  const out: Capture[] = [];

  for (const stream of [false, true]) {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const res = await fetch(`${api}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: badModel,
        messages: [{ role: "user", content: PROMPT }],
        ...(stream ? { stream: true } : {}),
      }),
    });
    const text = await res.text();
    const headerObj = headersToObject(res.headers);
    out.push({
      scenario: `bad-model-${stream ? "stream" : "nonstream"}`,
      source: "gateway",
      capturedAt: startedAt,
      layer: res.ok ? "none" : "connection",
      hypothesis: "清单写的是 5xx，但「模型不存在」按 OpenAI 语义应为 404/400；实测哪个就记哪个",
      request: {
        endpoint: `${redact(api)}/chat/completions`,
        body: { model: badModel, messages: [{ role: "user", content: PROMPT }], stream },
      },
      http: {
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type"),
        rateLimitHeaders: pickRateLimitHeaders(headerObj),
        headers: headerObj,
        bodyText: redact(text.slice(0, 4000)),
        bodyJson: tryJson(text),
      },
      timing: {
        requestStartedAt: startedAt,
        responseHeadersMs: Math.round(performance.now() - t0),
        firstBodyByteMs: null,
        lastEventMs: null,
        totalMs: Math.round(performance.now() - t0),
        abortedAtMs: null,
      },
      stream: null,
      failure: null,
      notes: [],
    });
  }
  return out;
}

async function probeBadParams(): Promise<Capture> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const body = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    // 两个都属于"参数层面非法"：一个范围越界，一个类型错误
    temperature: 99,
    max_tokens: -1,
  };
  const res = await fetch(`${api}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const headerObj = headersToObject(res.headers);
  return {
    scenario: "bad-params",
    source: "gateway",
    capturedAt: startedAt,
    layer: res.ok ? "none" : "connection",
    hypothesis: "非法参数应在请求校验阶段被拒（4xx），不该进入流",
    request: { endpoint: `${redact(api)}/chat/completions`, body },
    http: {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      rateLimitHeaders: pickRateLimitHeaders(headerObj),
      headers: headerObj,
      bodyText: redact(text.slice(0, 4000)),
      bodyJson: tryJson(text),
    },
    timing: {
      requestStartedAt: startedAt,
      responseHeadersMs: Math.round(performance.now() - t0),
      firstBodyByteMs: null,
      lastEventMs: null,
      totalMs: Math.round(performance.now() - t0),
      abortedAtMs: null,
    },
    stream: null,
    failure: null,
    notes: [],
  };
}

/**
 * ③ 断连：流式中途客户端主动 abort。
 *
 * 必须用长输出：这个网关把上游数据攒满约 15KB 才 flush，短输出会在响应头到达的同一瞬间
 * 全部到齐，"中途"根本不存在。1-300 的样本实测首片 4057ms、第二片 5670ms，
 * 选 5000ms 正好落在"已收到首片、正在等下一片"的真空期。
 */
async function probeDisconnect(): Promise<Capture> {
  return captureStreaming(
    "disconnect-mid-stream",
    {
      model,
      messages: [{ role: "user", content: "请逐个输出从 1 到 300 的数字，每行一个，不要省略任何数字。" }],
      max_tokens: 3000,
    },
    "200 建立后客户端 abort：读流应抛 AbortError；已解析事件保留，半截事件丢弃",
    { abortAfterFirstByteMs: 800, totalTimeoutMs: 60_000 },
  );
}

/** ④ 首字节超时：TTFT 通常 250ms 起，这里压到 50ms，保证在响应头/首片之前就掐断 */
async function probeFirstByteTimeout(): Promise<Capture> {
  return captureStreaming(
    "timeout-first-byte",
    { model, messages: [{ role: "user", content: "写一段 200 字的产品介绍。" }] },
    "首字节超时：fetch 阶段就 reject，拿不到 HTTP 状态码，也没有任何 SSE 事件",
    { firstByteTimeoutMs: 50 },
  );
}

/** ④ 总时长超时：首字节放行，流跑起来后按总时长掐断 */
async function probeTotalTimeout(): Promise<Capture> {
  return captureStreaming(
    "timeout-total",
    {
      model,
      messages: [{ role: "user", content: "请逐个输出从 1 到 600 的数字，每行一个，不要省略任何数字。" }],
      max_tokens: 5000,
    },
    "总时长超时：HTTP 200 已到、已有事件产出，abort 发生在流中途（与首字节超时形态不同）",
    { totalTimeoutMs: 6000 },
  );
}

/** ① 429：并发冲击。网关可能根本不限流，那就如实记录"未复现" */
async function probeRateLimit(concurrency: number): Promise<Capture[]> {
  const runs = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      captureStreaming(
        `429-concurrent-${i + 1}`,
        { model, messages: [{ role: "user", content: `回复 OK 即可。序号 ${i + 1}` }], max_tokens: 8 },
        "连续快速请求触发限流，重点看 Retry-After 是否存在",
        { totalTimeoutMs: 20_000 },
      ),
    ),
  );
  return runs;
}

// ---------- ⑤ 200 + 流中 error：先试网关，再用本地 mock 验证解析器 ----------

async function probeGatewayStreamError(): Promise<Capture[]> {
  const out: Capture[] = [];

  // 试 A：超长 prompt 撞 context 上限。有的网关在开始前 400，有的在流中途发 error。
  const longPrompt = "请逐字复述下面这段文本，不要省略：\n" + "数据结构与算法。".repeat(4000);
  out.push(
    await captureStreaming(
      "stream-error-long-prompt",
      { model, messages: [{ role: "user", content: longPrompt }], max_tokens: 16 },
      "超长 prompt 可能触发 context 超限：预期 400（连接层），若为 200 + 流内 error 则是应用层",
      { totalTimeoutMs: 30_000 },
    ),
  );

  // 试 B：对照组。同样是不 abort 的长流，用来排除"流本来就会中途断"这种解释
  out.push(
    await captureStreaming(
      "stream-normal-long",
      { model, messages: [{ role: "user", content: "写 400 字说明 HTTP/2 多路复用。" }], max_tokens: 900 },
      "对照组：不 abort 时应完整收到 [DONE]，否则说明该网关本来就会中途断流",
      { totalTimeoutMs: 30_000 },
    ),
  );

  return out;
}

/**
 * 本地 mock：网关不配合时，唯一能验证"解析器会不会吞掉流中 error"的办法。
 * 两个变体，差别只在 error 之后发不发 [DONE]：
 *   - error-then-done：error 事件后照常 [DONE] → 主流程完全感知不到失败
 *   - error-then-close：error 事件后直接断 → 被误报成"流被截断"
 */
async function probeMockStreamError(): Promise<Capture[]> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta: string): string =>
      `data: ${JSON.stringify({
        id: "mock-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`;

    res.write(chunk("前半段回答。"));
    setTimeout(() => {
      res.write(`data: {"error":{"message":"mock upstream failure","type":"server_error","code":500}}\n\n`);
      setTimeout(() => {
        if (url.startsWith("/v1-error-done")) {
          res.write("data: [DONE]\n\n");
        }
        res.end();
      }, 20);
    }, 20);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const out: Capture[] = [];
  for (const mode of ["done", "close"] as const) {
    const scenario = `stream-error-mock-${mode}`;
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const base = `http://127.0.0.1:${port}/v1-error-${mode}`;
    const requestBody = { model: "mock-model", messages: [{ role: "user", content: "hi" }] };

    // pass 1：解析层看到了什么（这里能看见 [DONE]）
    const rawEvents: string[] = [];
    let endedWithDone = false;
    let errorEvent: StreamErrorEvent | null = null;
    let parseFailure: Capture["failure"] = null;
    let http: Capture["http"] = null;

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: "Bearer mock",
        },
        body: JSON.stringify({ ...requestBody, stream: true }),
      });
      const headerObj = headersToObject(res.headers);
      http = {
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type"),
        rateLimitHeaders: {},
        headers: headerObj,
      };
      if (!res.body) throw new Error("mock 响应没有 body");

      let index = 0;
      for await (const event of readSSEStream(res.body)) {
        index += 1;
        rawEvents.push(redact(event.data.slice(0, 300)));
        if (isDoneEvent(event)) {
          endedWithDone = true;
          break;
        }
        const parsed = tryJson(event.data);
        if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
          errorEvent ??= {
            atEventIndex: index - 1,
            atMs: Math.round(performance.now() - t0),
            raw: redact(event.data.slice(0, 1000)),
            parsed,
          };
        }
      }
    } catch (err) {
      parseFailure = { ...errorInfo(err), abortedBy: null };
    }

    // pass 2：消费层实际交出什么（streamChatCompletion 就是真实使用路径）
    const consumerChunks: string[] = [];
    let consumerFailure: Capture["failure"] = null;
    try {
      for await (const chunk of streamChatCompletion(requestBody, { apiKey: "mock", baseUrl: base })) {
        consumerChunks.push(redact(JSON.stringify(chunk).slice(0, 300)));
      }
    } catch (err) {
      consumerFailure = { ...errorInfo(err), abortedBy: null };
    }

    out.push({
      scenario,
      source: "local-mock",
      capturedAt: startedAt,
      layer: "application",
      hypothesis:
        mode === "done"
          ? "error 事件后仍有 [DONE]：streamChatCompletion 把 error 当普通 chunk 交出，调用方不判 'error' 就静默吞掉"
          : "error 事件后直接断流：若最后一个事件完整，readSSEStream 不会报错 —— 表现为'正常结束'",
      request: {
        endpoint: `http://127.0.0.1:${port}/v1-error-${mode}/chat/completions`,
        body: { ...requestBody, stream: true },
      },
      http,
      timing: {
        requestStartedAt: startedAt,
        responseHeadersMs: null,
        firstBodyByteMs: null,
        lastEventMs: null,
        totalMs: Math.round(performance.now() - t0),
        abortedAtMs: null,
      },
      stream: {
        eventCount: rawEvents.length,
        chunkCount: consumerChunks.length,
        bytesReceived: 0,
        endedWithDone,
        errorEvent,
        firstEventData: rawEvents[0] ?? null,
        lastEventData: rawEvents.at(-1) ?? null,
      },
      failure: parseFailure ?? consumerFailure,
      notes: [
        "本地构造，不是网关真实响应；只用来证明解析器/消费层的行为",
        `解析层（readSSEStream）收到的事件：${JSON.stringify(rawEvents)}`,
        `消费层（streamChatCompletion）交出的 chunk：${JSON.stringify(consumerChunks)}`,
        rawEvents.length > 0 && consumerChunks.length > 0
          ? `消费层拿到了 ${consumerChunks.length} 个 chunk，其中 1 个是 error 负载；调用方若不显式判 'error' 就等同于成功`
          : "消费层没有拿到任何 chunk",
        endedWithDone
          ? "解析层看到了 [DONE]，但 streamChatCompletion 在 [DONE] 处直接 return，调用方无法从返回值区分'正常结束'与'error 后结束'"
          : "解析层没看到 [DONE]；由于最后一个事件完整，readSSEStream 不认为被截断，仍按正常结束处理",
      ],
    });
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return out;
}

// ---------- 落盘与汇总 ----------

async function save(capture: Capture): Promise<void> {
  const file = join(outDir, `${capture.scenario}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  console.log(`  已落盘 ${file}`);
}

function summarize(capture: Capture): Record<string, unknown> {
  return {
    scenario: capture.scenario,
    source: capture.source,
    layer: capture.layer,
    httpStatus: capture.http?.status ?? null,
    rateLimitHeaders: capture.http?.rateLimitHeaders ?? {},
    responseHeadersMs: capture.timing.responseHeadersMs,
    firstBodyByteMs: capture.timing.firstBodyByteMs,
    totalMs: capture.timing.totalMs,
    endedWithDone: capture.stream?.endedWithDone ?? null,
    streamErrorEvent: capture.stream?.errorEvent !== null && capture.stream?.errorEvent !== undefined,
    failure: capture.failure ? `${capture.failure.name}: ${capture.failure.message.slice(0, 160)}` : null,
  };
}

/**
 * 只重建索引，不发任何请求。
 * 样本本来就要分多次采集（429 要单独开、断连要长输出），索引必须覆盖目录里已有的全部文件，
 * 不能只记"最后一次进程跑过的那几个"。
 */
async function rebuildIndex(): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(outDir)).filter((f) => f.endsWith(".json") && f !== "index.json").sort();
  } catch {
    throw new Error(
      `读不到输出目录 ${resolve(outDir)}：--out 是相对当前工作目录的，默认值假设从 mini-harness/ts 运行`,
    );
  }
  const samples: Record<string, unknown>[] = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(outDir, file), "utf8")) as Capture;
    samples.push(summarize(data));
  }
  const indexFile = join(outDir, "index.json");
  await writeFile(
    indexFile,
    `${JSON.stringify({ rebuiltAt: new Date().toISOString(), model, badModel, samples }, null, 2)}\n`,
    "utf8",
  );
  console.log(`索引已重建：${indexFile}（${samples.length} 个样本）`);
  for (const row of samples) console.log(JSON.stringify(row));
}

async function main(): Promise<void> {
  console.log(`模型 ${model} / 坏模型 ${badModel}`);
  console.log(`输出目录 ${outDir}\n`);

  const all: Capture[] = [];

  if (wanted("bad-model")) {
    console.log("① 不存在的模型（流式 + 非流式）");
    const caps = await probeBadModel();
    for (const c of caps) {
      c.notes.push(
        c.http && c.http.status < 500
          ? `与清单假设不一致：清单写 5xx，实测 HTTP ${c.http.status}（OpenAI 语义里模型不存在是 404/400，不是 5xx）`
          : "实测为 5xx，符合清单假设",
        "响应体是网关自定义结构 {code,success,data,msg}，不是 OpenAI 的 {error:{message,type,param,code}}；且 HTTP 404 而 body.code 写 400，两个层级自相矛盾——错误分类不能只认 HTTP 状态码，也不能只按 OpenAI 规范解析 body",
      );
      await save(c);
      all.push(c);
    }
    const [nonstream, streaming] = caps;
    const same = nonstream.http?.bodyJson !== null && streaming.http?.bodyJson !== null
      ? JSON.stringify(nonstream.http?.bodyJson) === JSON.stringify(streaming.http?.bodyJson)
      : false;
    nonstream.notes.push(`与流式版本响应体是否一致：${same ? "一致" : "不一致（见另一份样本）"}`);
    console.log(
      `  非流式 HTTP ${nonstream.http?.status} / 流式 HTTP ${streaming.http?.status} / 响应体一致=${same}\n`,
    );
  }

  if (wanted("bad-params")) {
    console.log("② 非法参数");
    const c = await probeBadParams();
    c.notes.push(
      c.http && c.http.status >= 500 ? "实测 5xx，属于服务端未校验" : `实测 HTTP ${c.http?.status}，请求校验阶段被拒`,
      "响应体是 OpenAI 标准结构 {error:{message,type,param,code}}，与 bad-model 的自定义结构不同：同一个网关的两类 4xx 用了两套错误体，解析必须两种都兜住",
    );
    await save(c);
    all.push(c);
    console.log(`  HTTP ${c.http?.status} ${c.http?.statusText}\n`);
  }

  if (wanted("disconnect")) {
    console.log("③ 断连：流中途 abort");
    const c = await probeDisconnect();
    c.notes.push(
      `abort 发生在第 ${c.stream?.eventCount ?? 0} 个事件之后（${c.timing.abortedAtMs}ms）`,
      c.failure ? `抛出的错误：${c.failure.name}: ${c.failure.message}` : "未抛出错误：说明消费循环已正常退出",
      "controller.abort(new Error(...)) 后，读流抛出的是该 reason 原样（name='Error'），不是 DOMException AbortError；按 name === 'AbortError' 判断本地取消会漏",
      "已解析的事件保留、未成事件的半截数据丢弃：这正是 tool-accum 需要的语义（截断进 broken，不产生半截 JSON）",
    );
    await save(c);
    all.push(c);
    console.log(`  layer=${c.layer} failure=${c.failure?.name ?? "none"}\n`);
  }

  if (wanted("timeout-first-byte")) {
    console.log("④ 超时：首字节");
    const c = await probeFirstByteTimeout();
    c.notes.push(
      `首字节是否到达：${c.timing.firstBodyByteMs !== null ? "是" : "否"}`,
      `是否拿到 HTTP 状态：${c.http ? String(c.http.status) : "否（fetch 阶段就失败）"}`,
      "与总时长超时的本质区别：这里连 fetch 都没 resolve，没有状态码、没有响应头、没有任何事件，只能看到一个本地 abort 错误",
    );
    await save(c);
    all.push(c);
    console.log(`  failure=${c.failure?.name ?? "none"} abortedBy=${c.failure?.abortedBy ?? "none"}\n`);
  }

  if (wanted("timeout-total")) {
    console.log("④ 超时：总时长");
    const c = await probeTotalTimeout();
    c.notes.push(
      `首字节 ${c.timing.firstBodyByteMs}ms 已到达，abort 在 ${c.timing.abortedAtMs}ms，属流中途中断（不是连接层超时）`,
      `abort 前已收到 ${c.stream?.eventCount ?? 0} 个事件`,
      "与首字节超时的本质区别：HTTP 200 已到手、事件已大量落袋，失败发生在流中途；此时若直接重试，已消耗的 token 全部作废",
    );
    await save(c);
    all.push(c);
    console.log(`  首字节 ${c.timing.firstBodyByteMs}ms / 事件 ${c.stream?.eventCount ?? 0} / failure=${c.failure?.name ?? "none"}\n`);
  }

  if (wanted("stream-error-long-prompt") || wanted("stream-normal-long")) {
    console.log("⑤ 尝试在真实网关上制造 200 + 流中 error");
    for (const c of await probeGatewayStreamError()) {
      if (!wanted(c.scenario)) continue;
      c.notes.push(
        c.http && c.http.status >= 400
          ? "在进入流之前就被拒：属于连接层失败，不是流中 error"
          : c.stream?.errorEvent
            ? "复现了 200 + 流中 error"
            : c.scenario === "stream-error-long-prompt"
              ? "约 3.6 万字符的 prompt 仍返回 200 正常完成，未触发 context 超限，也就没给出流中 error 的样本"
              : "对照组：正常收到 [DONE]，说明断连样本里的中断确实来自客户端 abort，不是网关自己断的",
      );
      await save(c);
      all.push(c);
      console.log(`  ${c.scenario}: HTTP ${c.http?.status} layer=${c.layer}\n`);
    }
  }

  if (wanted("stream-error-mock-done") || wanted("stream-error-mock-close")) {
    console.log("⑤ 本地 mock 验证「200 + 流中 error」的解析器行为");
    for (const c of await probeMockStreamError()) {
      if (!wanted(c.scenario)) continue;
      await save(c);
      all.push(c);
      console.log(
        `  ${c.scenario}: 收到 ${c.stream?.eventCount ?? 0} 个 chunk / endedWithDone=${c.stream?.endedWithDone} / failure=${c.failure?.name ?? "none"}\n`,
      );
    }
  }

  if (withRateLimit) {
    console.log(`① 429：${rateLimitConcurrency} 个并发请求冲击限流`);
    const caps = await probeRateLimit(rateLimitConcurrency);
    const statuses = caps.map((c) => c.http?.status ?? "no-response");
    const retryAfter = caps.filter((c) => Object.keys(c.http?.rateLimitHeaders ?? {}).length > 0);
    const aggregate: Capture = {
      scenario: "429-rate-limit",
      source: "gateway",
      capturedAt: new Date().toISOString(),
      layer: statuses.some((s) => s === 429) ? "connection" : "none",
      hypothesis: "连续快速请求触发限流，重点看 Retry-After 是否存在；Day1 已发现网关无 x-ratelimit-* 头",
      request: { endpoint: `${redact(api)}/chat/completions`, concurrency: rateLimitConcurrency, model },
      http: null,
      timing: {
        requestStartedAt: new Date().toISOString(),
        responseHeadersMs: null,
        firstBodyByteMs: null,
        lastEventMs: null,
        totalMs: 0,
        abortedAtMs: null,
      },
      stream: null,
      failure: null,
      notes: [
        `并发 ${rateLimitConcurrency} 个请求，HTTP 状态分布：${JSON.stringify(statuses)}`,
        statuses.includes(429)
          ? `出现 429；其中带限流头/Retry-After 的响应数：${retryAfter.length}`
          : "未复现 429：该网关当前不做限流（或阈值远高于本次并发），重试策略不能依赖 429 一定会出现",
        `限流头样本：${JSON.stringify(retryAfter[0]?.http?.rateLimitHeaders ?? {})}`,
        `各请求失败形态：${JSON.stringify(caps.map((c) => c.failure?.name ?? null))}`,
      ],
    };
    // 有 429 就用它当代表样本，否则用第一个 200 —— http 字段是"代表样本"，不是聚合值
    const representative = caps.find((c) => c.http?.status === 429) ?? caps[0];
    if (representative) {
      aggregate.http = representative.http;
      aggregate.stream = representative.stream;
      aggregate.failure = representative.failure;
      aggregate.notes.push(
        `http / stream / failure 字段取自单个代表样本，不是这 ${rateLimitConcurrency} 个响应的聚合`,
      );
    }
    await save(aggregate);
    all.push(aggregate);
    console.log(`  状态分布 ${JSON.stringify(statuses)}\n`);
  }

  console.log("\n=== 本次采集 ===");
  for (const row of all.map(summarize)) console.log(JSON.stringify(row));

  // 索引要覆盖目录里的全部样本，不是只有本次进程采到的这些
  console.log("");
  await rebuildIndex();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (args.includes("--reindex")) {
    await rebuildIndex();
  } else {
    await main();
  }
}
