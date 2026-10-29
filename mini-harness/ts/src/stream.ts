/**
 * 流式消费层：fetch → TextDecoder → SSEParser → JSON chunk。
 *
 * 分工：
 * - sse.ts 只认文本，不知道字节与 UTF-8 边界
 * - 本文件负责 UTF-8 增量解码（TextDecoder 的 stream 模式），这是 TS 侧独有的坑
 *
 * 另起一层 readSSEStream 的好处：单测可以直接喂手工构造的 ReadableStream，不需要网络。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createSSEParser, isDoneEvent, type SSEEvent } from "./sse.ts";
import { ToolCallAccumulator } from "./tool-accum.ts";
import type { ChatCompletionChunk, ToolDefinition } from "./types.ts";

/** 单块 JSON 形状见 types.ts 的 ChatCompletionChunk（Day 2 实测） */
export type StreamChunk = ChatCompletionChunk;

/** Day4 演示用：两个工具，用来逼模型产生并行的多次工具调用 */
const DEMO_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询指定城市的实时天气",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "查询指定城市的当前时间",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "城市名" } },
        required: ["city"],
      },
    },
  },
];

/**
 * 一次 reader.read() 拿到的原始分片。
 * bytes 是字节数（不是字符数），text 是解码后的文本，可见它是否把事件/字符切开了。
 */
export interface RawChunk {
  index: number;
  /** 原始字节，落盘 .sse 时用它保证逐字节保真 */
  data: Uint8Array;
  /** 本次解码出的文本；被扣住的不完整多字节字符不会出现在这里 */
  text: string;
  /**
   * 收到这一片的绝对时间（epoch ms）。
   * 不能用"相对 readSSEStream 开始"的偏移：请求在 fetch 里可能已经等了 9 秒，
   * 那样算出来首片"3ms 到达"，完全是假象。
   */
  receivedAtEpochMs: number;
}

export interface StreamOptions {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  /** 让服务端在流末尾补一个只有 usage 的 chunk（OpenAI 的 stream_options） */
  includeUsage?: boolean;
  /** 原始分片回调，用于抓包对比（不改动解析行为） */
  onRawChunk?: (chunk: RawChunk) => void;
}

/**
 * 把字节流读成 SSE 事件。会 yield 包含 [DONE] 在内的事件，不做业务判断。
 * 若流在事件中途断开，抛错而不是吐出半截事件。
 */
export async function* readSSEStream(
  body: ReadableStream<Uint8Array>,
  onRawChunk?: (chunk: RawChunk) => void,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSSEParser();
  let rawIndex = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 关键：stream: true 让解码器自己扣住不完整的 UTF-8 多字节序列。
      // 用 new TextDecoder().decode(value) 或 buf.toString() 会在中文/emoji 跨 chunk 时出乱码。
      const text = decoder.decode(value, { stream: true });
      onRawChunk?.({
        index: rawIndex++,
        data: value,
        text,
        receivedAtEpochMs: Date.now(),
      });
      for (const event of parser.push(text)) {
        yield event;
        if (isDoneEvent(event)) return;
      }
    }

    // 刷出解码器里剩余的字节（结尾恰好切断在多字节字符中间时才会有）
    const tail = decoder.decode();
    for (const event of parser.push(tail)) {
      yield event;
      if (isDoneEvent(event)) return;
    }

    // 走到这里说明没收到 [DONE]：要么正常关闭，要么中途断连
    const report = parser.end();
    if (report.leftoverLine !== "" || report.pendingData !== "") {
      throw new Error(
        `SSE 流被截断（未收到 [DONE]）：leftoverLine=${JSON.stringify(report.leftoverLine)} pendingData=${JSON.stringify(report.pendingData)}`,
      );
    }
  } finally {
    reader.releaseLock();
  }
}

/** 发一次流式请求，逐块 yield 解析后的 JSON */
export async function* streamChatCompletion(
  requestBody: Record<string, unknown>,
  options: StreamOptions,
): AsyncGenerator<StreamChunk> {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = { ...requestBody, stream: true };
  if (options.includeUsage) body.stream_options = { include_usage: true };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  }
  if (!res.body) throw new Error("响应没有 body，无法按流处理");

  for await (const event of readSSEStream(res.body, options.onRawChunk)) {
    if (isDoneEvent(event)) return;
    try {
      yield JSON.parse(event.data) as StreamChunk;
    } catch {
      // 绝不静默跳过：吞掉一块数据等于让模型"少说半句话"而无人知情
      throw new Error(`SSE data 不是 JSON：${event.data.slice(0, 300)}`);
    }
  }
}

// ---------- CLI：接真实接口，流式打印 ----------

async function main(): Promise<void> {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) throw new Error("缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL");

  const args = process.argv.slice(2);
  const includeUsage = args.includes("--usage");
  const saveTarget = args.find((a) => a.startsWith("--save="))?.slice("--save=".length);
  const rawSaveTarget = args.find((a) => a.startsWith("--raw-save="))?.slice("--raw-save=".length);
  const withTools = args.includes("--tools");
  const prompt = withTools
    ? "请同时获取北京现在的天气，以及上海当前的时间。两个都要查。"
    : (args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length) ??
      "用两句话说明什么是 SSE，并带一个 emoji。");
  const captured: ChatCompletionChunk[] = [];
  const rawChunks: RawChunk[] = [];

  console.log(`模型 ${model} / usage chunk: ${includeUsage} / tools: ${withTools}`);
  console.log(`prompt: ${prompt}`);

  const requestStartedAtEpochMs = Date.now();
  const startedAt = performance.now();
  let firstChunkLogged = false;
  let chunkCount = 0;
  const deltaKeys = new Set<string>();
  const finishReasons: string[] = [];
  let usage: unknown = null;
  const acc = new ToolCallAccumulator();

  const requestBody = withTools
    ? { model, messages: [{ role: "user", content: prompt }], tools: DEMO_TOOLS }
    : { model, messages: [{ role: "user", content: prompt }] };

  const stream = streamChatCompletion(requestBody, {
      apiKey,
      baseUrl,
      includeUsage,
      onRawChunk: rawSaveTarget ? (chunk) => rawChunks.push(chunk) : undefined,
    },
  );

  for await (const chunk of stream) {
    chunkCount += 1;
    captured.push(chunk);

    if (!firstChunkLogged) {
      console.log("\n=== 首块原样（据此确定 delta 形状）===");
      console.log(JSON.stringify(chunk, null, 2));
      firstChunkLogged = true;
    }

    // 应用层错误形态：连接是 200，但流里塞了一个 error 对象（Day6 专门构造）
    if ("error" in chunk) {
      console.error("\n[流中出现 error 事件，但连接是 200]", JSON.stringify(chunk));
    }

    // usage-only chunk 的 choices 是空数组，必须防空
    const choice = chunk.choices[0];
    if (choice) {
      for (const key of Object.keys(choice.delta)) deltaKeys.add(key);
      const content = choice.delta.content;
      if (content) process.stdout.write(content);
      // 只累积，不解析：json.parse 必须等流结束
      acc.push(choice.delta.tool_calls);
    }
    if (choice?.finish_reason) {
      finishReasons.push(choice.finish_reason);
      console.log(`\n[finish_reason chunk 原样] ${JSON.stringify(chunk)}`);
    }
    if (chunk.usage) {
      usage = chunk.usage;
      console.log(`\n[usage chunk 原样] ${JSON.stringify(chunk)}`);
    }
  }

  // 封口时机：能走到这里说明 for await 已结束，即收到 [DONE] 或连接正常关闭之后。
  // 绝不能在 finish_reason 到达时封口 —— 网关可能在它之后再补参数片段。
  if (acc.size > 0) {
    const { calls, broken } = acc.finish();
    console.log("\n=== tool_calls 拼装结果 ===");
    for (const call of calls) {
      console.log(`#${call.index} ${call.name}(${call.argumentsText}) -> ${JSON.stringify(call.arguments)}`);
    }
    for (const bad of broken) {
      console.log(`#${bad.index} 不可执行：${bad.reason}｜原文=${JSON.stringify(bad.argumentsText)}`);
    }
  }

  console.log("\n\n=== 汇总 ===");
  console.log("chunk 数:", chunkCount);
  console.log("delta 出现过的键:", [...deltaKeys]);
  console.log("finish_reason:", finishReasons);
  console.log("usage:", usage ?? "流中未返回 usage（试 --usage）");
  console.log("耗时:", `${Math.round(performance.now() - startedAt)}ms`);

  if (saveTarget) {
    await mkdir(dirname(saveTarget), { recursive: true });
    const endpoint = `${baseUrl.replace(/\/s\/u\/[^/]+\//, "/s/u/***/").replace(/\/+$/, "")}/chat/completions`;
    await writeFile(
      saveTarget,
      `${JSON.stringify(
        { capturedAt: new Date().toISOString(), endpoint, model, includeUsage, chunks: captured },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`已落盘: ${saveTarget}`);
  }

  if (rawSaveTarget) {
    await mkdir(dirname(rawSaveTarget), { recursive: true });
    const endpoint = `${baseUrl.replace(/\/s\/u\/[^/]+\//, "/s/u/***/").replace(/\/+$/, "")}/chat/completions`;

    // (a) 原始线格式：逐字节拼接 reader.read() 拿到的内容，不做任何重排/缩进/换行转换
    const rawBytes = Buffer.concat(rawChunks.map((c) => Buffer.from(c.data)));
    const rawPath = `${rawSaveTarget}.sse`;
    await writeFile(rawPath, rawBytes);

    // (b) 分片边界：记录每次 reader.read() 拿到的内容，用于观察服务端怎么切
    //     data 是字节数组，只在 .sse 里体现，不重复写进 JSON
    const chunksPath = `${rawSaveTarget}.chunks.json`;
    const totalBytes = rawChunks.reduce((sum, c) => sum + c.data.byteLength, 0);
    const chunkMeta = rawChunks.map((c) => ({
      index: c.index,
      bytes: c.data.byteLength,
      chars: c.text.length,
      /** 相对"请求发出"的毫秒偏移，首片偏移即 TTFT（含 DNS/TLS/排队/首 token） */
      offsetMs: c.receivedAtEpochMs - requestStartedAtEpochMs,
      text: c.text,
    }));
    await writeFile(
      chunksPath,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          endpoint,
          model,
          includeUsage,
          requestBody: { model, messages: [{ role: "user", content: prompt }] },
          summary: {
            rawChunkCount: rawChunks.length,
            totalBytes,
            endsWithDone: rawBytes.includes(Buffer.from("data: [DONE]")),
            firstChunkOffsetMs: chunkMeta[0]?.offsetMs ?? null,
            lastChunkOffsetMs: chunkMeta.at(-1)?.offsetMs ?? null,
          },
          rawChunks: chunkMeta,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`已落盘原始流: ${rawPath}（${totalBytes} 字节，${rawChunks.length} 个网络分片）`);
    console.log(`已落盘分片边界: ${chunksPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
