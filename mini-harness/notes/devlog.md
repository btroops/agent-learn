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

---

## Day 4 — 2026-10-29 增量 tool_calls 拼接

**目标**：写对 W1 唯一会被后续所有周复用的组件。先取证据，再写代码。

### 1. 先取证据：真实的增量形状

命令：`node --env-file=../.env src/stream.ts --tools --raw-save=../notes/samples/day4-toolcalls-raw`

21 个事件，原始流见 `samples/day4-toolcalls-raw.sse`。逐条展开：

```
ev#0        delta={role,content:""}
ev#1..#6    delta={reasoning}                                ← 思维链先来
ev#7..#9    delta={content}                                  ← 正文"我会同时查询这两项信息。"
ev#10       tc.index=0  id="chatcmpl-tool-b8a9..."  type="function"  name="get_weather"  arguments=【不存在】
ev#11       tc.index=0  function={arguments:"{\"city\": \""}
ev#12       tc.index=0  function={arguments:"北京"}
ev#13       tc.index=0  function={arguments:"\"}"}
ev#14       tc.index=1  id="chatcmpl-tool-b574..."  type="function"  name="get_time"      arguments=【不存在】
ev#15..#17  tc.index=1  function={arguments} 分三段
ev#18       delta={}  finish_reason="tool_calls"             ← 空 delta 携带结束标志
ev#19       choices=[]  只有 usage
ev#20       [DONE]
```

**四处与"课本描述"的实质差异：**

1. **首块没有 `arguments` 字段，不是空串。** 类型里若写 `arguments: string`，这里会拿到 `undefined`，拼接时直接变成字符串 `"undefined"`。
2. **后续分片里 `function` 对象只剩 `arguments`**，`id` / `type` / `name` 全缺席——用 id 分桶会从第 2 片起全部丢失。
3. **结束标志与数据共用 `delta` 对象**：`finish_reason` 与 `delta: {}` 同时出现，`delta` 里什么也没有。
4. **`usage` chunk 在 `finish_reason` 之后才到**，且 `choices: []`。这条是"流会活过 finish_reason"的直接证据（见第 5 节）。

### 2. 设计

| 决策 | 选择 | 理由 |
|---|---|---|
| 分桶 key | `index` | id 只在首块出现 |
| 何时 parse | 只在 `finish()` | 片段中途 parse 必炸 |
| 解析失败 | 进 `broken[]`，不抛 | W2/W3 要把失败转成 isError 工具结果，而不是中断整轮 |
| 输出顺序 | 按 index 升序 | 即源顺序；并行执行时 toolResult 也按这个顺序落盘（W2） |
| 过早封口 | `sealed` 标志，之后再 push 抛错 | 把"在 finish_reason 处封口"这个静默 bug 变成显式崩溃 |
| 缺 id / 缺 name | 进 `broken[]` 并给出原因 | 缺 id 无法与 tool 结果配对 |

### 3. 单测：TS 10 条 + Python 10 条

覆盖：单工具 5 片、双工具（照抄真实样本）、交错到达、空串片与缺字段片、第二个工具首块无 id、半截 JSON、封口后 push、无参数工具得 `{}`、源顺序输出、缺 index 快速失败。

### 4. 真实接口验证（两侧各跑一次）

```
TS : #0 get_weather({"city": "北京", "unit": "celsius"}) -> {"city":"北京","unit":"celsius"}
     #1 get_time({"city": "上海"})                        -> {"city":"上海"}
Py : #0 get_weather({"city": "北京", "unit": "celsius"}) -> {"city": "北京", "unit": "celsius"}
     #1 get_time({"city": "上海"})                        -> {"city": "上海"}
```

两个 `arguments` 都能 `JSON.parse` 成功，Day 4 的核心验收达成。

### 5. 为什么 `finish_reason` 到达时不能认为参数已完整

1. **规范其实有承诺，但只承诺"生成"。** `finish_reason` 非空即表示该 choice 生成结束，其后不应再有该 choice 的 `delta`；但承诺的对象是服务端生成，不是"我们本地已收全"，而本网关是 vLLM，是否严格遵守不可验证。
2. **观测只能证明"流没结束"。** `usage` chunk（`choices: []`）在 `finish_reason` 之后到达，说明 `finish_reason` 不是流结束标志；但它不携带任何 delta，证明不了"之后还可能有 tool_calls 片段"。
3. **代价不对称（决策论，不是存在性证据）。** 后补片段存在与否无法排除：早封口的代价是参数残缺，甚至"合法但错误"的前缀（`{"city":"北"}` 恰好闭合）让工具用错误参数执行；晚封口只多等一个 `[DONE]`。

判定完整用**防御性**写法：**流已结束（`[DONE]` 或连接正常关闭）+ JSON 解析成功**。若网关严格守规范，`finish_reason` + 解析成功也够，但那个前提无法验证。

> 更正记录：本节初稿写成"协议没保证""usage chunk 证明之后可能还有 tool_calls 片段"。前者说反了，后者是 `非 sequitur`（usage chunk 的 `choices` 恒为空数组）。完整版见 `streaming-notes.md` §2.3。

### 6. 遗留

- [ ] Day 5：结构化输出两条路径（`response_format` / `tool_choice`）
- [ ] W2 的 loop 要消费 `AssembleResult`：`broken` 直接转 `isError` 工具结果，且 `calls` 按源顺序落盘

---

## Day 5 — 2026-10-29 结构化输出两条路径

**目标**：同一任务、同一 prompt 下对比 `json_schema` / `tool_choice` / 纯 prompt，拿出三列对比表与选型结论。

脚本：`ts/src/structured.ts`，原始响应落 `samples/day5/day5-<场景>-run<N>.json`（11 个场景共 15 次请求）。

### 1. 先承认一个自己踩的设计缺陷

第一轮我让"纯 prompt 对照组"只收到 `只输出 JSON，不要解释`，**没有给字段名**。结果模型很合理地输出了中文键 `{"会议主题":...}`，schema 校验全红。

这不是"纯 prompt 不行"的证据，只是"没告诉它，它当然不会猜中字段名"。同理 A5（`json_object` 只保证 JSON 语法，schema 是我在脑子里想的、根本没发给模型）。

**修正**：把同一份 schema 用自然语言完整写进 prompt（`SCHEMA_TEXT`），重跑 C2 与 A5b。修正前后结论完全相反——这条写下来提醒自己：**对照组不公平，整个实验作废**。

### 2. 实测结果（同一句中文任务）

| 场景 | HTTP | schema 校验 | prompt/completion tokens | 关键观察 |
|---|---|---|---|---|
| A1 `json_schema`（嵌套 + 枚举） | 200 | 通过 | 75 / 169 | 完全符合 schema |
| A2 `+ minimum:0` | 200 | 通过 | 75 / 266 | **没被拒**，与 OpenAI strict 行为不同 |
| A3 `+ additionalProperties:true` | 200 | 通过 | 75 / 187 | **没被拒** |
| A4 `required` 里去掉 `owner` | 200 | 通过¹ | 75 / 172 | 首次输出没有 owner（复跑 2/3 又出现，见 §12.4） |
| A5 `json_object`（无文字 schema） | 200 | 失败（中文键） | 75 / 163 | 只保证是 JSON，不保证结构 |
| A5b `json_object` + 文字 schema | 200 | 通过 | 198 / 212 | 补齐 schema 描述后可用 |
| B1 `tool_choice` 指定函数名 | 200 | 通过 | 451 / 295 | 参数在 `tool_calls[0].arguments` |
| B2 `tool_choice:"required"` | 200 | 通过 | 451 / 233 | 同上 |
| C 纯 prompt（无字段名） | 200×3 | 3/3 失败 | 75 / 209,232,242 | 中文键，设计缺陷组 |
| C2 纯 prompt + 文字 schema | 200×3 | **3/3 通过** | 198 / 245,229,248 | 修正后的公平基线 |
| A2b `+ minimum:100` | 200 | 通过 | 75 / 216 | **`duration_hours` 输出了 205** |

> ¹ 原先记为"失败（缺 owner）"，是**校验用错 schema** 所致：本场景实际发出的 schema 里 `required` 已不含 `owner`，输出少该字段完全合规。`205` 同理——它满足 `minimum: 100`，本来就合法。两处口径问题与离线复验见本节末尾「补充实验」。
>
> 复跑（§12.4）显示 owner 3 次里出现 2 次：它只是**可选**，不能据此判断 `required` 是否被执行。

### 3. 三个实质发现

**① 这个网关在 `response_format` 通道上真的在做语法级强制解码（guided decoding），而不只是"建议"。**（`tools` 需开 `strict` 才强制，见 §11）

证据以数值/枚举为主：

- A2b 给 `duration_hours` 加 `minimum: 100`，而原文明明是"预计 2 小时"，模型输出了 **205**；复跑 3 次为 `2731 / 2000 / 2123`（§12.4）。它无法输出 `<100` 的合法值，只能编一个。
- A4 把 `owner` 从 `required` 里去掉，首跑输出少了 `owner`，但复跑 2/3 又带上了——只能说明 `owner` 可选，**不能**证明 `required` 被执行（§12.4）。

**这条比"支持 json_schema"重要得多**：约束不可满足时，模型不会报错，而是**静默扭曲语义**去满足语法。所以 schema 校验通过 ≠ 数据正确，业务校验不能省。

**② 但它不校验 OpenAI 的 strict 模式限制。** `additionalProperties: true`、`minimum`、`required` 缺字段，三种 OpenAI 明确会拒绝的 schema，这里全部 200。换句话说：**不要拿 OpenAI 的 strict 文档来推断这个网关的行为**，它只关心能不能编译成语法。

> **2026-10-31 复核**：`minimum` 的封禁状态随版本与模型类型变化，并非永久结论（见 §10.1）；另外"tools 通道不校验 strict"**未验证**，因为 B 路径根本没写 `strict`（见 §10.2）。

**③ schema 不计入 prompt_tokens。** 同一任务：A 组 75 tokens，C2 组 198（+123 是文字 schema），B 组 451（+376 是工具定义）。

也就是说 A 的 schema 走的是"带外"通道（编译成 grammar），一次复杂 schema 在 A 里是**零 prompt 成本**。这是 guided decoding 实现的共性（OpenAI 同样不计，见 §10.3），不是本网关独有；但 strict 校验与关键字支持范围因供应商而异，换供应商后这些结论必须重测。

> **2026-10-31 复核**：原句"OpenAI 会把 schema 序列化进 prompt 计费"已删除，依据见 §10.3。

### 4. 三列对比表

| 维度 | A `json_schema` | B `tool_choice` | C 纯 prompt |
|---|---|---|---|
| 兼容性 | 本网关支持；但**不校验** strict 限制（A2/A3/A4 全 200） | 支持；指定函数名与 `"required"` 都生效 | 任何网关可用 |
| schema 表达力 | 完整 JSON Schema 子集（嵌套/枚举/数值约束） | 同左（`parameters` 就是 JSON Schema） | 受模型理解力限制 |
| 强制力 | **语法级**：`minimum` / `maximum` / `enum` 实测生效 | **不强制**：同一份 `minimum` 被无视（见 §9 S4） | 无，只能事后校验 |
| 是否 100% 合法 JSON | 是（语法层保证） | 是（语法层保证） | 实测 3/3 通过，但无任何保证 |
| prompt token（本任务） | 75（schema 不进 prompt） | 451（工具定义 +376） | 198（文字 schema +123） |
| 失败形态 | 约束不可满足时**静默扭曲语义**（2 小时 → 205 小时） | 同 A | 中文键 / 漏字段 / markdown 包裹 |
| 语义错误的可发现性 | 低（校验全绿，但值是错的） | 低（同左） | 高（经常直接校验失败） |

> **2026-10-31 复核**：上表 B 列的"100% 合法 JSON = 是（语法层保证）"、"失败形态 = 同 A"、"语义错误可发现性 = 低"三行沿用旧口径，已被 §9 S4 推翻——B 没开 `strict`，参数只是文本，没有语法保证；它不是"为满足约束而扭曲"，而是可能直接无视约束或产出不合法 JSON（客户端校验能发现，故可发现性应为高）。以 §10.2 为准。

### 5. 什么时候必须用 `tool_choice` 而不用 `json_schema`

1. **需要"动作"而不是"数据"。** 工具调用带 `id`、要被执行、结果要以 `role:"tool"` 回填；`json_schema` 只产出 `content`，没有调用语义，也拿不到配对键。
2. **需要与工具注册表共用一份 schema。** W3 的工具注册中心是唯一真源，用 `tools` 定义就不会出现"schema 两处维护、慢慢漂移"。
3. **需要在一次响应里同时给文本和调用。** `json_schema` 的输出只能是一段 JSON。
4. **跨厂商兼容。** `json_schema` strict 的支持差异最大（本网关连校验都不做），`tool_choice` 支持面更广。

反过来的场合用 `json_schema`：纯抽取、无副作用、schema 复杂（嵌套 + 数值范围 + 枚举），因为强制力最强且（本网关）不花 prompt token。

### 6. 本项目的选型结论

- **有副作用的动作 → 路径 B**（`tools` + `tool_choice`），工具定义是唯一真源；
- **纯数据抽取 → 路径 A**（`json_schema`），强制力最强、token 最省；
- **路径 C 只作降级**：网关不支持 A/B 时用文字 schema，且**必须**在客户端 `JSON.parse` + schema 校验，失败要重试或回退，不能当成功；
- **无论走哪条，schema 校验之后还要业务校验**。A2b 已经证明：语法强制会为了满足约束而扭曲数值，`duration_hours: 205` 是"完全合法"的 JSON。

### 7. 遗留

- [ ] Day 6：故障样本（429 / 5xx / 断连 / 超时）
- [ ] 换供应商（或网关升级）后重测第 3 节的三条结论，尤其是"schema 不计 prompt token"

### 8. 补充实验：校验口径的离线复验（2026-10-31，0 次请求）

用 `node ts/src/structured.ts --revalidate=notes/samples/day5` 重算 15 份样本，发现第 2 节那张表的"schema 校验"列有两处口径问题：

1. **校验用错了 schema。** `runOnce` 里写死 `validate(parsed, EVENT_SCHEMA)`，而 A2 / A2b / A3 / A4 发出的都是 EVENT_SCHEMA 的变体。拿原件去校验变体，等于换了一把尺子。
2. **校验器不实现数值约束。** `validate()` 的 number 分支只查 `typeof`，`minimum` / `maximum` 形同不存在。

两处都已修：新增 `sentSchema(requestBody)` 从样本的 `requestBody` 反推该场景实际发出的那份 schema；`validate()` 补上 `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` 与 `integer`。同时加 `--revalidate=<dir>` 模式，不读 `.env`、不发请求。

复验结果（旧口径 10/15 通过，新口径 11/15）：

| 样本 | 旧口径（EVENT_SCHEMA） | 新口径（实际发出的 schema） |
|---|---|---|
| `a-missing-required` | 失败：`$.owner` 缺失 | **通过** ← 唯一翻转 |
| `a-minimum-100` | 通过 | 通过（`205 ≥ 100`） |
| 其余 13 份 | 同 | 同 |

两条结论：

- **A4 的"失败"是假象，但"required 被执行"也不是结论。** 该场景的 schema 本就不要求 `owner`，输出没有 `owner` 完全合规；复跑 3 次里 2 次又带上了 `owner`（§12.4），说明它只是可选字段。A4 无法区分"`required` 被执行"与"`required` 被忽略"，第 2 节该行的"最强证据"说法已收回。
- **"205 会被更严的校验挡住"这个假设不成立。** `205 ≥ 100`，任何正确的校验器都会放行。所以 5.1 的结论要说得更硬：这类错误**只能靠业务校验**发现，schema 层再怎么加严都拦不住。

教训：`schema 校验=通过/失败` 这一列，只有在"校验器实现了该 schema 的全部关键字"且"校验的是实际发出的那份 schema"时才成立，否则它只是个装饰性字段——我自己就先被它误导了一轮。

### 9. 第三轮：真实接口补充实验（2026-10-31，4 次请求）

判据在跑之前先定好，样本落 `samples/day5b/`（文件名仍是 `day5-*` 前缀，脚本里写死）。这一轮有一处**推翻了第 4 节的表格**。

| 场景 | 约束 | 输出 | 解读 |
|---|---|---|---|
| S1 `maximum:1`（原文 2 小时） | `duration_hours <= 1` | `1` | 约束**双向**生效，2 被压到边界值 |
| S2 `enum:["low"]`（原文"优先级高"） | `priority ∈ {low}` | `"low"` | 枚举生效，静默改值 |
| S3 `minimum:100` + 原文"200 小时" | `>= 100` | `200` | 控制组：语义与约束不冲突时不扭曲 |
| S4 **B 路径** `minimum:100` | `>= 100` | **`2`** | **未生效**，本地校验直接判失败 |

两条结论：

1. **A2b 的 205 不是"模型爱编大数"。** S3 把原文改成"200 小时"后输出就是 `200`，说明模型读得懂数值；205 是"2 不合法、只能往上凑"的产物。加上 S1/S2，A 路径的 `minimum` / `maximum` / `enum` 三个关键字全部实测生效。
2. **强制力是通道相关的，不是 schema 相关的。** 同一份 `minimum:100`，A 输出 205（被顶住），B 输出 2（无视）。S4 的 reasoning 里模型自己写着"minimum 100 与 2 小时冲突……它应该会校验失败……我还是调一下试试"——**它看见了约束，然后选择违反它**。反过来 A 路径的 reasoning 是"字段名可用中文还是英文？没指定"——**模型压根没看见 schema**。prompt token 也印证：B 从 451 涨到 457，多出的正是 `minimum` 那几个 token。

因此第 4 节"强制力"一行，B 列由"同左"改为"**不强制**"。B 的 `required` / `enum` 是否生效**未测**，不能推广。

> **2026-10-31 复核（已拆开）**：`EMIT_TOOL` 没有 `function.strict: true`，而 A 路径是 `strict: true`。所以这组对比实际是"strict 开 vs strict 没开"；§11 的 P0 结果证实：**strict 才是开关，原"通道"结论作废**。

**一处需要打问号的观测**：S2 同时出现了与约束无关的漂移——`owner` 从"张三"变成"李四"，`start_time` 变成编造的绝对日期（reasoning 里还臆造了"系统日期 2026-05-07"）。单次观测无法判断这是采样噪声还是约束冲突的副作用，**未计入结论**；要归因得重复跑。

对 W3 的直接影响：**用 `tools` 定义工具时，参数正确性不能指望网关**。注册表里的 schema 是"给模型看的说明书"，不是服务端的校验器；执行前必须自己按同一份 schema 校验，否则 `get_weather({"city": 2})` 这类调用会直接打到工具实现里。

### 10. 2026-10-31 复核：strict 的真实规则、A 组判别力、一处事实更正

本节不改前面已归档的观测与数字，只补口径；凡是推翻前文的，都在原文处留了指针。

#### 10.1 OpenAI strict 到底要求什么

**【文档】+【外部资料，2026-10 复核；官方页 403 未直读】**：

| 规则 | 内容 |
|---|---|
| 对象 | 每个 `object` 节点都**显式**写 `additionalProperties: false`，嵌套对象同样 |
| 必填 | 所有 `properties` 必须全部进 `required`；可选字段只能写成含 `null` 的联合 |
| 不支持关键字 | `allOf`、`not`、`if/then/else`、`dependentRequired`、`dependentSchemas`；`anyOf`、`$defs/$ref` 支持，但每个分支自身也要合法 |
| 根节点 | `response_format` 的根用 object；root 为 `anyOf` 不被支持 |
| 规模上限 | 5000 个属性、10 层嵌套、1000 个枚举值、12 万字符 |

入口拒绝形态是 400，消息通常带上下文路径（历史文档形态）：

```
Invalid schema for response_format 'event': In context=(), 'additionalProperties' is required to be supplied and to be false.
```

tools 通道对应 `Invalid schema for function 'emit_event': ...`。

**时效性**：`minimum`/`maximum`/`multipleOf`/`minLength`/`maxLength` 在 2024 首发时属于不支持关键字；2026 年外部资料称标准模型已支持数值约束、微调模型仍不支持。官方文档本次无法直接访问，所以第 3 节"三种 OpenAI 明确会拒绝的 schema"只有 `additionalProperties: true` 与 `required` 缺字段两项站得住，`minimum` 要按"版本 + 模型类型"标注，不能当永久结论。

**两阶段模型**（本次讨论的固定结论）：

| 阶段 | 做什么 | 失败表现 |
|---|---|---|
| 入口 strict 校验 | 静态检查 schema 是否符合 OpenAI 元规则 | 400，请求不进入推理 |
| 编译器编译 | 把 schema 编译成语法/FSM 供 guided decoding 使用 | 可能报错、回退或按支持的子集弱化，不一定报错 |

A3/A4 都返回 200，只能证明**第一阶段在本网关缺位**；第二阶段怎么处理被改坏的 schema，需要看输出证据（见 10.2）。

#### 10.2 A 组判别力分级

| 场景 | 能证明 | 不能证明 |
|---|---|---|
| A1 | 正常 schema 可用、输出合法 | 任何强制力 |
| A2 `minimum:0` | 入口不拒该 schema | `minimum` 是否执行（`2 ≥ 0` 恒真） |
| A3 `additionalProperties:true` | 入口不拒 | 编译器是否接受 `true`；"输出没多字段"无法区分"允许但没加"与"按 false 处理" |
| A4 去掉 `owner` | 入口不校验 strict；`owner` 只是可选（3 次重复 2 次出现、1 次缺失） | **不能证明 `required` 被执行**（与"`required` 被忽略"无法区分）；原单次结论已收回（§12.4） |
| A2b `minimum:100` | 数值约束被执行 + 约束冲突时静默扭曲语义；重复 3 次值为 `2731 / 2000 / 2123` | — |
| A5 `json_object` | 只保证 JSON 语法 | 不能当"纯 prompt 不行"的基线（prompt 未给字段名） |
| A5b | 文字 schema 能补位；成本 +123 token | — |

**容易过度的推断**："A3 返回 200 就说明编译器把 `additionalProperties: true` 编译成了允许额外键"——不成立。模型本就没有理由添加额外键，所以输出"没有多余字段"无法区分"允许但没加"与"不支持 true、按 false 处理"。

**B 路径的混淆变量（比 A3 更要紧）**：`EMIT_TOOL` 没有 `function.strict: true`，A 路径却是 `strict: true`。§9 的对比实际是"strict 开 vs 没开"，不是"两个通道"；S4 只能支持"**没开 strict 的** tools 不强制"。两个拆解场景已跑（细节见 §11）：

| 场景 | 请求 | 结果 |
|---|---|---|
| B + strict | `tools` + `function.strict:true` + `minimum:100`，原文"2 小时" | 输出 `200`（≥100）→ **strict 开关生效**，原"通道"结论作废 |
| tools 入口校验 | 同上但 `parameters` 故意缺 `additionalProperties` | 200 → 网关对 tools 也**不做** strict 元规则校验 |

#### 10.3 更正：OpenAI 也不把 schema 计入 prompt_tokens

§3 ③ 曾写"OpenAI 会把 schema 序列化进 prompt 计费，所以零 prompt 成本是本网关特有"（该句已于 2026-10-31 从原文删除）。**这条不成立**：

- 2024-08 的公开实验（gpt-4o-mini，固定 prompt，未在本仓库存档）：schema 字段越加越多，`prompt_tokens` 恒定 18，说明 schema 不在计费上下文里；
- 2026 年外部资料同样写"no extra token cost，只多一次编译延迟（约 200–400ms，之后缓存）"。

所以 A 组 75 vs C2 组 198 的正确解读是：**带外 schema 不占 prompt token，这是 guided decoding 实现的共性，不是本网关独有**。真正的网关差异在 strict 校验与关键字支持范围。以上均为外部资料、未在本仓库自测，换供应商不适用。

#### 10.4 对 W3 的影响（不变，但理由更硬）

工具参数的运行时校验仍然必须做：即使网关将来支持 strict，strict 也只保证结构与类型，不保证值正确（A2b 的 `205` 已经证明语法层会为满足约束而扭曲语义）。另外 strict 的保证还有两个缺口——`refusal` 与 `finish_reason: "length"`，harness 解析前必须先检查。

### 11. P0 结果：strict 是开关，不是通道（2026-10-31，2 次请求）

实现：`structured.ts` 的 `b-strict-minimum` / `b-strict-invalid`；样本 `samples/day5c/`。判据在跑之前由 §10.2 定好。

| 场景 | 请求差异 | HTTP | 输出 | prompt/completion | 关键观察 |
|---|---|---|---|---|---|
| P0-1 `b-strict-minimum` | `tools` + `function.strict:true` + `minimum:100`，原文 2 小时 | 200 | `duration_hours: 200` | 462 / 560 | reasoning 明确计划传 `2` 并预期被拒，实际 arguments 是 `200` |
| P0-2 `b-strict-invalid` | `strict:true`，但 `parameters` 缺 `additionalProperties` | 200 | 只有 `title` | 340 / 198 | 入口没拒；reasoning 里明确说 "strict: true but no additionalProperties" |

**结论一：§9 的"通道相关"作废，改为"strict 开关相关"。** 同一份 `minimum:100`、同一句原文：不开 strict 的 S4 输出 `2`，开 strict 的 P0-1 输出 `200`。更关键的是 P0-1 的 reasoning 与实际输出不一致——模型自己写的是"先按 2 调用试试"，最后 arguments 却是 `200`。这不是模型改主意，而是采样阶段被约束（服务端至少对 `minimum` 做了强制）。

**结论二：入口 strict 校验在 tools 通道上同样缺位。** P0-2 的坏 schema 返回 200，与 A3/A4 在 `response_format` 通道上的表现一致：网关只把 schema 交给编译器，不按 OpenAI 元规则在入口拒绝。

**证据限制**（不要把这两条推得太远）：

- P0-1 是单次样本；`strict` 会进 prompt（S4 457 → P0-1 462，+5 token），模型能看见它。"reasoning 想传 2、实际 200"能区分"模型自觉遵守"与"被约束"，但仍建议重复 3 次加固。
- P0-2 只能证明入口不拒。输出只有 `title` 也可能来自模型遵守可见 schema，无法区分"编译器接受了坏 schema"与"回退/忽略约束"。
- 仍未测：B + strict 下 `required` / `enum` 是否同样生效；以及 `strict` 是否只对 `tool_choice` 强制的那个工具生效。

对选型的影响：`tools` 并不天然"只是说明书"——**开 `strict:true` 后它同样会被服务端约束**。但入口不校验元规则，坏 schema 仍会被放行；且参数正确性仍要客户端校验，因为 strict 只保证结构、不保证语义（P0-1 的 2 小时 → 200 小时就是新证据）。

### 12. P1/P2 结果：大 schema、语法死路与重复实验（2026-10-31，14 次请求）

样本：`samples/day5d/`（P1，5 次）、`samples/day5e/run{1,2,3}/`（P2，9 次）。

#### 12.1 大 schema：16k 字符仍不进 prompt

| 指标 | run1 | run2 |
|---|---|---|
| schema | 120 字段，16058 字符 / 25178 字节 | 同 |
| prompt_tokens | 75 | 75 |
| completion_tokens | 144 | 168 |
| 耗时 | 2405 ms | 2002 ms |
| 输出 | `{"field_001":"x"}` | `{"field_001":"x","field_002":"x"}` |

结论：**16k 字符的 schema 仍保持 75 prompt tokens**，带外通道不是小 schema 的偶然；若序列化进上下文，按中文约 1 token/字也应是数千 token。冷热两次差约 400ms，但 completion 不同（144 vs 168），**不能把差值归因于编译缓存**；要测缓存得固定输出长度或看首 token 延迟。

#### 12.2 语法死路：编译器在编译阶段就 400

| 场景 | HTTP | 耗时 | 错误 |
|---|---|---|---|
| `minimum:100` + `maximum:1` | 400 | 276 ms | `Grammar error: Unsatisfiable schema: required property 'duration_hours' is unsatisfiable` |
| `enum: []` | 400 | 135 ms | 同类，点名 `priority` |

所以死路不会静默卡住；vLLM 判定不可满足后直接拒绝。错误文案统一说 "required property ... unsatisfiable"，即使根因是数值区间或空枚举。

#### 12.3 `required` 指向不存在的字段：200，但输出违反 schema

`required` 里加 `ghost`（`properties` 没有，且 `additionalProperties:false`）：**200**，输出不含 `ghost`，本地校验报 `$.ghost 缺失`。

这说明编译器没有把这种冲突判为 unsatisfiable，而是**静默弱化**：返回成功，但产物不符合实际发出的 schema。这是"guided decoding 保证 100% 合法"的反例——坏 schema 可能被放行并弱化，客户端校验仍不可省。

#### 12.4 重复实验：A4 的原结论被推翻

A4（`required` 去掉 `owner`）重复 3 次：

| run | owner | completion |
|---|---|---|
| 1 | 张三 | 236 |
| 2 | 张三 | 211 |
| 3 | **缺失** | 235 |

首跑恰好落在"缺 owner"一侧，于是被写成"`required` 被执行"；复跑 2/3 又带上 owner。正确结论：**owner 只是可选字段**，A4 无法区分"`required` 被执行"与"`required` 被忽略"。§3① 与该场景原结论已收回；guided decoding 的硬证据是 A2b/S1/S2（数值与枚举）。

A2b 重复 3 次：`2731 / 2000 / 2123`，全部 ≥100，但值每次不同。再次证明 `minimum` 被强制，同时说明"合法值"是随机的，业务校验不能省。

S2 重复 3 次：`priority` 全部 `low`，`owner` 全部张三，`start_time` 全部"明天上午十点"。Day 5b 那次"李四 + 编造日期"**没有复现**，更可能是采样噪声（n=3 仍不足以定论）。

#### 12.5 修订清单

- §3①：guided decoding 证据从 A4 改为 A2b/S1/S2；A4 仅证明"owner 未被强制"。
- §4/§10.2 的 A4 行：从"`required` 被执行"改为"owner 可选，无法判别 required"。
- 大 schema：带外通道的规模边界至少到 16k 字符 / 120 字段。
- 死路：编译器会 400；但 `required` 指向不存在字段时会 200 并静默弱化。
