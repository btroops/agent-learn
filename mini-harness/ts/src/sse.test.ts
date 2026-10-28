import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSEParser, isDoneEvent, type SSEEvent } from "./sse.ts";

/** 所有用例都是手工构造的畸形 chunk，全程不发网络请求 */

test("1. 单个完整事件", () => {
  const parser = createSSEParser();
  const events = parser.push('data: {"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"a":1}');
  assert.equal(events[0].event, "message");
});

test("2. 半包：事件被从 JSON 中间切断，此时不能吐出任何事件", () => {
  const parser = createSSEParser();
  const first = parser.push('data: {"city":"北');
  assert.deepEqual(first, [], "半截事件必须憋住，不能交给 JSON.parse");

  const second = parser.push('京"}\n\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].data, '{"city":"北京"}');
});

test("3. 粘包：一个 chunk 里 3 个完整事件", () => {
  const parser = createSSEParser();
  const events = parser.push('data: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\n');
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.data),
    ['{"i":0}', '{"i":1}', '{"i":2}'],
  );
});

test("4. data: 后面没有空格", () => {
  const parser = createSSEParser();
  const events = parser.push('data:{"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"a":1}');
});

test("5. 空 data 行不派发事件（规范行为，不是遗漏）", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push("data:\n\n"), []);
  assert.deepEqual(parser.push("data: \n\n"), []);
  // 空 data 之后紧跟真实事件，仍然正常工作
  assert.equal(parser.push('data: {"a":1}\n\n').length, 1);
});

test("6. [DONE] 与前一事件粘在同一 chunk：原样返回，不当作 JSON 解析", () => {
  const parser = createSSEParser();
  const events = parser.push('data: {"a":1}\n\ndata: [DONE]\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[1].data, "[DONE]");
  assert.equal(isDoneEvent(events[1]), true);
  assert.equal(isDoneEvent(events[0]), false);
});

test("7. CRLF 分隔，且 chunk 恰好切在 \\r 与 \\n 之间", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push("data: x\r"), [], "结尾孤立的 \\r 必须扣住，等下一块判断是否 CRLF");
  const events = parser.push("\n\r\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "x");
});

test("8. 注释行丢弃 + 多行 data 用 \\n 连接", () => {
  const parser = createSSEParser();
  const events = parser.push(": keep-alive\n\ndata: line1\ndata: line2\n\n");
  assert.equal(events.length, 1, "注释与空行都不产生事件");
  assert.equal(events[0].data, "line1\nline2");
});

test("9. end() 报告截断：断连时不产生半截事件，但残留必须可见", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"partial":'), []);

  const report = parser.end();
  assert.equal(report.leftoverLine, 'data: {"partial":');
  assert.equal(report.pendingData, "");
});

test("10. 缺结束空行但 data 已成行：end() 里报告 pendingData", () => {
  const parser = createSSEParser();
  assert.deepEqual(parser.push('data: {"a":1}\n'), [], "没有空行收尾就不算完整事件");

  const report = parser.end();
  assert.equal(report.pendingData, '{"a":1}');
});

test("11. event / id 字段透传", () => {
  const parser = createSSEParser();
  const events: SSEEvent[] = parser.push("event: ping\nid: 42\ndata: hi\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "ping");
  assert.equal(events[0].id, "42");
});
