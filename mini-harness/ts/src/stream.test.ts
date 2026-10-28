import assert from "node:assert/strict";
import { test } from "node:test";
import type { SSEEvent } from "./sse.ts";
import { readSSEStream } from "./stream.ts";

/** 手工构造字节流，全程不碰网络 */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of readSSEStream(streamOf(chunks))) events.push(event);
  return events;
}

test("UTF-8 边界：中文字符被切在两个 chunk 之间仍能正确解码", async () => {
  const encoder = new TextEncoder();
  const payload = 'data: {"c":"北京😀"}\n\n';

  // 切点落在"京"的第一个字节后面，即三字节序列的中间
  const cut = encoder.encode('data: {"c":"北').length + 1;
  const all = encoder.encode(payload);
  assert.ok(all.length > cut, "构造的切点必须落在 payload 内部");

  const events = await collect([all.slice(0, cut), all.slice(cut)]);
  assert.equal(events.length, 1);

  const parsed = JSON.parse(events[0].data) as { c: string };
  assert.equal(parsed.c, "北京😀", "用 buf.toString() 或非 stream 解码器这里会是乱码/替换字符");
});

test("[DONE] 之后的内容被忽略，[DONE] 本身作为事件产出", async () => {
  const encoder = new TextEncoder();
  const events = await collect([
    encoder.encode('data: {"i":0}\n\ndata: {"i":1}\n\ndata: [DONE]\n\n'),
    encoder.encode("data: 这之后的数据不应再被消费\n\n"),
  ]);

  assert.equal(events.length, 3);
  assert.equal(events[2].data, "[DONE]");
});

test("流被截断：不吐半截事件，且抛错说明残留内容", async () => {
  const encoder = new TextEncoder();
  let emitted = 0;

  await assert.rejects(async () => {
    for await (const _event of readSSEStream(streamOf([encoder.encode('data: {"a":1}\n')]))) {
      emitted += 1;
    }
  }, /SSE 流被截断/);

  assert.equal(emitted, 0, "截断时一个事件都不该交出去");
});
