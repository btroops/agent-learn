# 流式协议笔记（W1 交付物）

> 规矩：本文件只写**亲手跑过并验证**的结论。没验证的写成 `待验证`，验证失败的写"实测不支持"。
> 每日过程与原始样本见 `notes/devlog.md` 与 `notes/samples/`；本文只沉淀可复用的结论。

状态：**编写中**（Day 1 已完成基线事实，其余章节随 Day 2/3/4/5/6 补齐）

---

## 0. 基线事实（Day 1 实测，后续所有判断的前提）

| 事实 | 实测值 | 为什么重要 |
|---|---|---|
| 后端 | vLLM（`system_fingerprint: vllm-0.0.0-tp4-pp2-...`） | 行为可能偏离 OpenAI 官方，不能照文档推断 |
| 工具定义计费 | 1 个工具定义 = 289 prompt tokens（35 → 324） | 工具越多，每轮成本线性上升 |
| 推理模型 | `completion_tokens` 含 `reasoning_tokens`（实测占比 21%~75%） | 预算统计不能只看 `content` |
| tool_calls 响应 | `content: null`，参数在 `function.arguments` 一个完整 JSON 串里 | 非流式是 Day 4 流式拼接的对照物 |
| prefix cache | 存在，`cached_tokens` 实测 256/324；**per-instance**，网关多实例轮询（`x-vllm-instance` 变化） | W5 实验必须同时记录实例号 |
| 限流头 | **不存在 `x-ratelimit-*`** | 429 无法读 `Retry-After`，退避策略要自己定 |

---

## 1. SSE 解析的 4 个陷阱

> 待 Day 2 补齐。必须覆盖：半包（chunk 从事件中间切断）、粘包（一个 chunk 含多个事件）、终止（`[DONE]` 不当作 JSON）、注释（`:` 开头的 keep-alive 丢弃）。
> 额外已知陷阱：UTF-8 多字节字符会被 chunk 边界切断，必须 `TextDecoder({stream: true})`，不能用 `buf.toString()`。

（待填）

---

## 2. 增量 tool_calls 拼接的 3 个陷阱

> 待 Day 4 补齐。必须覆盖：`index` 分桶（用 id 会丢后续分片）、多工具交错到达、完整性判定（`finish_reason` 到达 ≠ 参数收完）。

已确认的前置事实：非流式下 `arguments` 是完整 JSON 串，见样本 `samples/day1-chat-toolcall.json`。

（待填）

---

## 3. 4 类故障样本与处置策略

> 待 Day 6 补齐。样本存 `notes/error-samples/`，每个标注"连接层失败 / 应用层失败"。
> 已知难点：本网关无限流头，429 的 `Retry-After` 不可依赖。

（待填）

---

## 4. TS 与 Python 的实测差异

> 待 Day 3 补齐。必须包含：同一接口同一 prompt 下两侧的 chunk 边界实测对比；`TextDecoder({stream:true})` 与 `httpx` 的 `aiter_text()` 各自解决了什么问题。

（待填）

---

## 5. 结构化输出选型结论

> 待 Day 5 补齐。三列对比表（`json_schema` / `tool_choice` / 纯 prompt）+ 本项目选型一段话。

（待填）
