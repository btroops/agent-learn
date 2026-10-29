# 开发日志

> 逐日记录：做了什么 / 命令 / 实测结果 / 结论 / 遗留。
> 原始响应一律落 `notes/samples/`，正文只写从样本里读出来的结论，不复述整段 JSON。
> 落盘时 URL 的 path token 打码为 `/s/u/***/`，API Key 只存在于 `.env`（已 gitignore）。

---

## Day 1 — 2026-10-27 环境与第一次非流式裸调

**目标**：打通"一个请求 → 一个完整响应"，让 `types.ts` 的字段有真实响应作对照。

### 1. 环境实测

| 项 | 本机实测 | 判定 |
|---|---|---|
| Node | 22.19.0 | OK（≥22.18，可直接 `node x.ts`） |
| 系统 Python | 3.8.10 | 禁用（EOL，无 `TaskGroup`） |
| 项目 Python | 3.12.13（`.venv/`） | OK |
| uv | 0.11.32 | OK |
| httpx | 0.28.1 | OK |
| typescript / @types/node | 7.0.2 / 26.6.5 | devDependencies，仅编译期 |

### 2. 网关画像

- 自建 OpenAI 兼容网关，后端 **vLLM**：`system_fingerprint = vllm-0.0.0-tp4-pp2-ep-8d310e51`
- `/models` 实测可用：`bge-m3`、`bge-reranker`、`DeepSeek-V4.1-Flash`、`GLM-5.3-Flash`、`Qwen3-ASR-1.7B`、`Qwen3.8-27B`、`SimOCR`、`Z-Image-Turbo`
- 选用 `DeepSeek-V4.1-Flash`（**推理模型**，有独立 reasoning 字段）

复现命令（在 `mini-harness/ts` 下）：

```bash
node --env-file=../.env src/smoke.ts --models --save=../notes/samples/day1-models.json
node --env-file=../.env src/smoke.ts --save=../notes/samples/day1-chat-plain.json
node --env-file=../.env src/smoke.ts --with-tools --save=../notes/samples/day1-chat-toolcall.json
```

### 3. 实测结论

**① 工具定义全额计入 `prompt_tokens`**（A/B：同 prompt，只差一个 `tools` 字段）

| 场景 | prompt_tokens | 差值 |
|---|---|---|
| 无工具 | 35 | — |
| 带 1 个 `get_weather` 定义 | 324 | **289** |

→ 1 个工具 ≈ 289 tokens，20 个工具 ≈ 5800 tokens/轮。W3 的"description 长度预算"有硬成本依据，不是洁癖。

**② `tool_calls` 的非流式形状（Day 4 的对照物）**

```
finish_reason: "tool_calls"
message.content: null                    ← 不能用 content 判断有无结果
message.tool_calls[0].id: "chatcmpl-tool-a2ef45781e431c95"
message.tool_calls[0].function.arguments: "{\"city\": \"北京\", \"unit\": \"celsius\"}"   ← 一次完整的 JSON 串
message.reasoning: "The user asks about Beijing weather..."     ← vLLM 非标字段
```

→ 非流式下参数天然完整；流式下同一串会被按 `index` 切成碎片并可能交错，这是 W1 的唯一硬骨头（Day 4）。

**③ 推理模型的成本结构**

| 样本 | completion_tokens | reasoning_tokens | 占比 |
|---|---|---|---|
| plain | 121 | 91 | 75% |
| toolcall | 71 | 15 | 21% |

→ `reasoning_tokens` 单独计费且波动极大。W4 的 token 预算若只统计 `content`，会低估 2-4 倍。

**④ 网关自带 prefix cache，且缓存是 per-instance 的**（意外发现，W5 直接用）

- `toolcall` 样本：`prompt_tokens 324` 中 `cached_tokens 256`（命中 79%）；`plain` 样本为 0。
- 两次调用的响应头 `x-vllm-instance` 从 `b` 变成 `a` → 网关在**多实例间轮询**。
- 推论：命中率取决于"有没有被路由回同一实例"，不稳定。W5 做 "prefix cache 友好布局" 时，必须同时记录 `x-vllm-instance`，否则实验数据不可复现——这条是本仓库第一个"不看响应头就会得出错误结论"的坑。

**⑤ 没有任何限流头**

响应头只有网关自加的 `req-arrive-time` / `req-cost-time` / `resp-start-time` / `x-envoy-upstream-service-time`，**无 `x-ratelimit-*`**。

→ Day 6 的 429 大概率拿不到 `Retry-After`，重试策略不能依赖该头，得改用指数退避 + 本地计数。

### 4. 产出与取舍

| 文件 | 说明 |
|---|---|
| `ts/src/types.ts` | 只纳入真实出现过的字段；恒为 null 的 `prompt_logprobs` / `kv_transfer_params` / `metrics` 不纳入类型 |
| `ts/src/smoke.ts` | 非流式裸调，`--models` / `--with-tools` / `--headers` / `--save=` 四个开关 |
| `ts/tsconfig.json` | **计划外新增**，理由见下 |

计划外新增 `tsconfig.json` 的取舍：

- 不引入会带来问题的依赖，只装了 `typescript` + `@types/node`（纯编译期，不是 LLM SDK，不违反"不引入官方 SDK"铁律）。
- 收益 1：`erasableSyntaxOnly: true` 把 AGENTS 的"不能用 `enum` / `namespace` / 构造函数参数属性"从口头约定变成**编译期报错**。
- 收益 2：`npm run typecheck` 可当门禁，`npx tsc --noEmit` 当前 exit 0。
- 被放弃的方案：手写 `declare const process` 垫片。零依赖但后续用到 `fs` / `path` 时必然要重写。

### 5. 遗留

- [x] Day 2：`sse.ts` + 畸形 chunk 单测（见下）
- [ ] Day 6：429 的触发方式要重新设计（无 `Retry-After` 可读）

---

## Day 2 — 2026-10-28 SSE 解析器（TS）

**目标**：不依赖任何库手写 SSE 解析器，并接真实接口验证中文/emoji 不乱码。

### 1. 分层取舍

| 层 | 文件 | 职责 | 为什么这么切 |
|---|---|---|---|
| 协议层 | `sse.ts` | 只吃**已解码文本**，输出完整事件 | 纯文本、零 IO，单测不需要构造字节流 |
| 传输层 | `stream.ts` | `fetch` → `TextDecoder(stream:true)` → 解析器 → JSON | UTF-8 边界是字节层问题，塞进协议层会污染可测性 |

另一处分层：`readSSEStream(body)` 与 `streamChatCompletion(body, opts)` 分开。前者接受任意 `ReadableStream<Uint8Array>`，所以单测可以直接喂手工构造的字节流，**全程不发一次网络请求**。

### 2. 按规范实现、与直觉相反的地方

| 行为 | 直觉写法 | 规范要求（已按规范实现） |
|---|---|---|
| 单独的 `data:` 行 | 派发一个 data 为空串的事件 | **不派发**：data 缓冲为空则整个事件丢弃 |
| `data:  x`（两个空格） | 全部 trim 掉 | 只剥**一个**前导空格，值是 `" x"` |
| 行分隔符 | 只 `\n` | `\r\n`、`\n`、`\r` 都要支持 |
| chunk 结尾是孤立 `\r` | 立刻当行结束 | **必须扣住**，等下一块确认是不是被切开的 `\r\n` |
| 流结束未以空行收尾 | 把残留当事件吐出 | 规范规定丢弃；但要把残留交回调用方（本实现 `end()` 返回 `leftoverLine`/`pendingData`） |

### 3. 单测

计划要 8 条，实际写了 **11 条 sse + 3 条 stream = 14 条**，多出的 6 条各有明确目标：

- `sse.test.ts` #9/#10：截断检测（`end()` 能说出残留是什么，而不是静默丢弃）
- `sse.test.ts` #11：`event:` / `id:` 透传
- `stream.test.ts`：UTF-8 边界（切点落在"京"的三字节序列中间）、`[DONE]` 之后的数据不再消费、截断时**一个事件都不交出**且抛错

跑法：`node --test src/*.test.ts`，348ms 跑完，无网络。

### 4. 真实流式实测（`samples/day2-stream-usage.json`，50 个 chunk）

```
chunk 0        : delta = {role:"assistant", content:""}      ← 首块 content 是空串
chunk 1..35    : delta.reasoning 逐块推送（35 块）
chunk 36..48   : delta.content   逐块推送（13 块）
chunk 48       : delta = {content:" 📡。"} 且 finish_reason = "stop"   ← 同一块里既正文又结束标志
chunk 49       : choices = []，只有 usage                            ← finish 之后才补 usage
```

**四个新事实：**

1. **usage-only chunk 出现在 `finish_reason` 之后，且 `choices` 是空数组。** 任何 `chunk.choices[0].delta` 都会在这里抛 `Cannot read properties of undefined`。这就是 W1 点名的那条陷阱，在本网关**实测成立**，不是理论可能。
2. **`delta.reasoning` 是独立字段**，本次 50 块里 35 块是 reasoning。它和 `content` 本次是"先全部 reasoning、再全部 content"，但**不能把顺序当契约**——Day 4 拼 tool_calls 时要按"任意交错"设计。
3. **流式 usage 的 `prompt_tokens_details` 缺 `multimodal_tokens`**（非流式响应里有这个 null 字段）。同一份 `Usage` 类型不能两边硬套，字段必须 optional，否则解析流式 usage 时类型与现实不符。
4. **首块 `content` 是空串而不是缺字段。** 用 `content === ""` 判断"没有输出"会误伤，必须判 `undefined`/真值。

### 5. 产出

| 文件 | 行数量级 | 说明 |
|---|---|---|
| `ts/src/sse.ts` | ~130 | `SSEParser` + `createSSEParser` + `isDoneEvent` |
| `ts/src/stream.ts` | ~180 | `readSSEStream` / `streamChatCompletion` / CLI |
| `ts/src/sse.test.ts` | 11 条 | 畸形 chunk，纯离线 |
| `ts/src/stream.test.ts` | 3 条 | 字节层 UTF-8 边界、`[DONE]`、截断 |
| `samples/day2-stream-usage.json` | 50 chunk / 20.7KB | Day 4 的对照物 |

### 6. 原始抓包（补做：此前落盘的是解析后 JSON，不是线上字节）

**产出**

| 文件 | 内容 |
|---|---|
| `samples/day2-stream-raw.sse` | 17,126 字节，逐字节原样（`Buffer` 直接写，不经文本层） |
| `samples/day2-stream-raw.chunks.json` | 每个网络分片的字节数、字符数、**相对请求发起的偏移**、原文 |
| `samples/day2-stream-long.sse` | 37,132 字节，长输出样本 |
| `samples/day2-stream-long.chunks.json` | 同上 |

**实测（两样本共 5 个网络分片）**

| 样本 | 总字节 | 分片 | 各片大小 | 到达偏移 | 片尾是事件边界 |
|---|---|---|---|---|---|
| raw | 17,126 | 2 | 15218 / 1908 | 2932ms / 2989ms | 否 / 是 |
| long | 37,132 | 3 | 15211 / 16030 / 5891 | 3218ms / 5768ms / 6719ms | 否 / 否 / 是 |

**四个结论**

1. ~~分片由中间代理的缓冲区决定~~ —— **归因错误，Day 3 已推翻**：片大小是**客户端网络栈**的合并结果，不是服务端行为。同一网关、同一 prompt，Python(httpx/httpcore) 侧看到 66 片、平均 276B、**65/66 片正好以事件边界结尾**；TS(undici) 侧被合并成 2 片。说明服务端确实是逐事件 flush 的，只是 Node 侧把连续到达的事件合并成大块读。
   连带收回一条结论：曾据此断言"TTFT 在客户端测不出来"，这是错的。两侧都能在最后约 250ms 内看到连续流（TS 2987→3233ms，Py 3466→3722ms），首片偏移可测；它包含排队与预填充，只是**不等于模型出第一个 token 的时刻**。
   另：最初用 `performance.now()` 相对 `readSSEStream` 起点计时，算出"首片 3ms"，完全是小作文级别的假象。改成 epoch 时间戳后才看出真相。
2. **5 个分片里 4 个切在 JSON 事件中间**，其中 long 样本 #1 直接切在 `"finish_reason"` 这个键名里（`..."fini` | `sh_reason"...`）。半包不是边角情况，是**每一次**都在发生。
3. **144 个事件全部用 `\n\n` 分隔，一个 `\r` 都没有。** 所以解析器的 CRLF 分支目前**只有单测覆盖，真实流量没验证过**——笔记里必须保持"未实测"，不能因为单测绿了就宣称网关会发 CRLF。
4. **5 个分片都没有切断 UTF-8 字符**（每片"解码后重新编码"字节数 == 网络字节数）。字符级切分目前仍是"理论风险 + 单测覆盖"，没有真实样本。

### 7. 遗留

- [ ] Day 3：Python 侧同构实现 + 分片边界对比（现在有了可比的 `.chunks.json`，正好逐片对齐）
- [ ] Day 4：`delta.tool_calls` 增量形状（types.ts 的 `StreamDelta` 里故意留了空位，不凭记忆填）
- [ ] Day 6：实测"200 + 流中 error 事件"时，当前实现会把 `chunk.error` 打印出来但不中断——这条要变成明确策略

---

## Day 3 — 2026-10-29 Python 侧对齐 + 双语言差异

**目标**：用 `httpx` 重写同一套逻辑，重点看两侧在"分片边界"上到底同不同。

### 1. 环境补充

- `pytest 9.2.0` 装进仓库根 `.venv`（`uv pip install --python .venv/bin/python pytest`）
- `pyproject.toml` 里 `pythonpath = ["src"]`，所以单测可直接 `import mini_llm`

### 2. 结构（与 TS 逐一对应）

| TS | Python | 说明 |
|---|---|---|
| `types.ts` | `types.py` | TypedDict，字段口径与 TS 完全一致；**不引入 pydantic**（那是 W3 工具参数校验的事） |
| `sse.ts` | `sse.py` | `SSEParser` / `create_sse_parser` / `is_done_event` |
| `stream.ts` | `stream.py` | `aiter_sse_events` / `stream_chat_completion` |

命名映射：`createSSEParser ↔ create_sse_parser`、`isDoneEvent ↔ is_done_event`、`readSSEStream ↔ aiter_sse_events`、`streamChatCompletion ↔ stream_chat_completion`。

### 3. 一处刻意的不照抄（取舍）

计划原文是"`sse.py`：同 Day 2 的状态机，**`async def` 版本**"。我没有把解析器本身写成 async：

- **放弃的方案**：`async def push(chunk) -> list[SSEEvent]`。状态机是纯计算，没有 await 点，async 只是套壳；会把单测全部变成 `await`，且与 TS 侧的同步 `push()` 不再同构（AGENTS 要求双语言行为一一对应）。
- **采用的方案**：`SSEParser.push()` 保持同步，另加 `async def aiter_sse_events(chunks: AsyncIterator[str])` 作为异步入口。真实 IO 的异步性体现在 `aiter_text()` 上，那才是需要 await 的地方。

### 4. 单测：15 条全绿，0.07s

11 条 `test_sse.py`（与 TS 的 11 条逐条对应）+ 3 条 `test_stream.py`（UTF-8 边界 / `[DONE]` / 截断）+ 1 条回归（见下）。

`test_stream.py` 用 `httpx.MockTransport` + 自定义 `AsyncByteStream` 构造分片，**不发网络**。UTF-8 那条刻意走 httpx 的真实解码路径——因为 Python 侧的字节解码不是我们写的代码，是 httpx 的保证，必须测出来才能写"已实测"。

### 5. 真实调用

69 个 chunk，`delta` 键 `{role, content, reasoning}`，`finish_reason: stop`，usage `reasoning_tokens 122 / completion_tokens 177`（69%）。

### 6. 分片边界对比（本日核心，也推翻了 Day 2 的结论）

同一天、同 prompt、同一网关：

| 客户端 | 分片数 | 片大小 min/avg/max | 片尾=事件边界 | 首片→末片 |
|---|---|---|---|---|
| TS（undici） | 2 | 3128 / 9171 / 15213 B | 1/2 | 2987→3233 ms |
| Py（httpcore） | 66 | 90 / 276 / 789 B | **65/66** | 3466→3722 ms |

两侧事件总数都是 70，`\r` 都是 0。

**结论：分片粒度是客户端网络栈的实现细节。**

- 服务端确实是**逐事件 flush**（约 276B），httpcore 原样透传，所以 65/66 片正好以 `\n\n` 结尾；
- undici 把连续到达的数据合并成大块读，于是 2 片、15KB，且 1/2 片切在 JSON 中间。

**连带影响**：

1. 半包在 TS 侧是常态，在 Py 侧几乎不出现 → **半包只能靠离线构造的 chunk 测**，只信真机验证的 Python 版会漏掉整条分支；
2. Day 2 曾把 15~16KB 归因于"中间代理攒包"，并据此断言"TTFT 客户端测不出来"——**这条被推翻**，已在 Day 2 段落与笔记 §1.7 中改正。首片偏移可测（约 2.9~3.5s），只是它包含排队与预填充，不等于模型出首个 token 的时刻。

### 7. 真机跑出来的 bug（同构靠抄是抄不出来的）

首版 `stream_chat_completion` 把 `aiter_sse_events` 吐出的 `[DONE]` 直接丢给 `json.loads`，真实请求立刻抛 `SSE data 不是 JSON：[DONE]`。TS 侧因为在 `streamChatCompletion` 里先判了 `isDoneEvent`，所以同一个 bug 不存在。

修法除了补判断，还做了可测性改造：`stream_chat_completion` 增加 `client` 参数（可注入 `httpx.AsyncClient`），于是这个 bug 能用 `MockTransport` 写成不发网络的回归测试。

### 8. 遗留

- [ ] Day 4：`tool_calls` 增量拼接（两侧都要；`StreamDelta` 的空位等着填）
- [ ] W3 引入 pydantic 时，回头评估 `types.py` 的 TypedDict 是否要换（当前选择：解析场景用 TypedDict 更轻）
