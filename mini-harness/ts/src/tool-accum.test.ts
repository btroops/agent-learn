import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallAccumulator } from "./tool-accum.ts";
import type { ToolCallDelta } from "./types.ts";

/** 构造分片的简写：args 传 undefined 表示"本片没有 arguments 字段"（真实首块就是这样） */
function frag(index: number, args?: string, head?: { id: string; name: string }): ToolCallDelta {
  const delta: ToolCallDelta = { index };
  if (head) {
    delta.id = head.id;
    delta.type = "function";
    delta.function = { name: head.name };
  } else {
    delta.function = {};
  }
  if (args !== undefined) delta.function!.arguments = args;
  return delta;
}

test("1. 单工具：arguments 分布在 5 个分片里", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "call_a", name: "get_weather" })]);
  for (const part of ['{"city"', ': "北', "京\", \"unit", '": "ce', 'lsius"}']) {
    acc.push([frag(0, part)]);
  }

  const { calls, broken } = acc.finish();
  assert.deepEqual(broken, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call_a");
  assert.equal(calls[0].name, "get_weather");
  assert.equal(calls[0].argumentsText, '{"city": "北京", "unit": "celsius"}');
  assert.deepEqual(calls[0].arguments, { city: "北京", unit: "celsius" });
});

test("2. 两个工具并行（真实形状：首块带 id/name 无 arguments，后续只有 index + arguments）", () => {
  const acc = new ToolCallAccumulator();
  // 完全照抄 samples/day4-toolcalls-raw.sse 的 ev#10~#17
  acc.push([frag(0, undefined, { id: "chatcmpl-tool-b8a9", name: "get_weather" })]);
  acc.push([frag(0, '{"city": "')]);
  acc.push([frag(0, "北京")]);
  acc.push([frag(0, '"}')]);
  acc.push([frag(1, undefined, { id: "chatcmpl-tool-b574", name: "get_time" })]);
  acc.push([frag(1, '{"city": "')]);
  acc.push([frag(1, "上海")]);
  acc.push([frag(1, '"}')]);

  const { calls, broken } = acc.finish();
  assert.deepEqual(broken, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].arguments, { city: "北京" });
  assert.deepEqual(calls[1].arguments, { city: "上海" });
  assert.equal(calls[0].name, "get_weather");
  assert.equal(calls[1].name, "get_time");
});

test("3. 分片交错到达：按 index 分桶而非按到达顺序", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "t0" })]);
  acc.push([frag(1, undefined, { id: "b", name: "t1" })]);
  acc.push([frag(0, '{"x":')]);
  acc.push([frag(1, '{"y":')]);
  acc.push([frag(0, "1}")]);
  acc.push([frag(1, "2}")]);

  const { calls } = acc.finish();
  assert.deepEqual(calls[0].arguments, { x: 1 });
  assert.deepEqual(calls[1].arguments, { y: 2 });
});

test("4. 某片 arguments 为空串 / 某片根本没有 arguments 字段", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "t" })]);
  acc.push([frag(0, "")]); // 空串片段
  acc.push([frag(0, '{"k":')]);
  acc.push([frag(0, undefined)]); // 连字段都没有
  acc.push([frag(0, "true}")]);

  const draft = acc.snapshot()[0];
  assert.equal(draft.fragments, 5, "空片与缺字段也要计一片，用于诊断");
  const { calls } = acc.finish();
  assert.deepEqual(calls[0].arguments, { k: true });
});

test("5. 第二个工具的首块不带 id：不能凑成可执行调用，但要报出原因", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "t0" })]);
  acc.push([frag(0, "{}")]);
  // 网关只在第一次调用时给 id 的情况
  acc.push([{ index: 1, function: { name: "t1", arguments: "{}" } }]);

  const { calls, broken } = acc.finish();
  assert.equal(calls.length, 1, "第一个调用仍应可用");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].index, 1);
  assert.equal(broken[0].name, "t1");
  assert.match(broken[0].reason, /缺少 id/);
});

test("6. 截断保护：半截 JSON 不抛异常，进 broken 并保留原文", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "t" })]);
  acc.push([frag(0, '{"city": "北')]); // 流在这里断了

  const { calls, broken } = acc.finish();
  assert.equal(calls.length, 0, "半截参数绝不能被执行");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].argumentsText, '{"city": "北');
  assert.match(broken[0].reason, /不是合法 JSON/);
});

test("7. finish() 之后再 push：显式抛错，不静默丢数据", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "t" })]);
  acc.push([frag(0, '{"k":1}')]);
  acc.finish();

  assert.throws(() => acc.push([frag(0, "late")]), /已封口/);
});

test("8. 无参数工具：arguments 一个字符都没出现，得到 {}", () => {
  const acc = new ToolCallAccumulator();
  acc.push([frag(0, undefined, { id: "a", name: "ping" })]);

  const { calls, broken } = acc.finish();
  assert.deepEqual(broken, []);
  assert.deepEqual(calls[0].arguments, {});
});

test("9. 输出按源顺序（index 升序），不是完成顺序", () => {
  const acc = new ToolCallAccumulator();
  // index 1 先完成，index 0 后完成
  acc.push([frag(1, undefined, { id: "b", name: "t1" })]);
  acc.push([frag(1, '{"v":2}')]);
  acc.push([frag(0, undefined, { id: "a", name: "t0" })]);
  acc.push([frag(0, '{"v":1}')]);

  const { calls } = acc.finish();
  assert.deepEqual(
    calls.map((c) => c.index),
    [0, 1],
  );
});

test("10. 缺 index 的分片：直接失败而不是猜", () => {
  const acc = new ToolCallAccumulator();
  assert.throws(() => acc.push([{ function: { arguments: "{}" } } as unknown as ToolCallDelta]), /缺少 index/);
});
