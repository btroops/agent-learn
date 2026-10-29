# 流式协议笔记（W1 交付物）

> 规矩：本文件只写**亲手跑过并验证**的结论。没验证的写成 `待验证`，验证失败的写"实测不支持"。
> 每日过程与原始样本见 `notes/devlog.md` 与 `notes/samples/`；本文只沉淀可复用的结论。

状态：**编写中**（§0 基线 / §1 SSE / §4 双语言差异已完成；§2/§3/§5 随 Day 4/6/5 补齐）

---

## 0. 基线事实（Day 1-2 实测，后续所有判断的前提）

| 事实 | 实测值 | 为什么重要 |
|---|---|---|
| 后端 | vLLM（`system_fingerprint: vllm-0.0.0-tp4-pp2-...`） | 行为可能偏离 OpenAI 官方，不能照文档推断 |
| 工具定义计费 | 1 个工具定义 = 289 prompt tokens（35 → 324） | 工具越多，每轮成本线性上升 |
| 推理模型 | `completion_tokens` 含 `reasoning_tokens`（实测占比 21%~75%） | 预算统计不能只看 `content` |
| tool_calls 响应 | `content: null`，参数在 `function.arguments` 一个完整 JSON 串里 | 非流式是 Day 4 流式拼接的对照物 |
| prefix cache | 存在，`cached_tokens` 实测 256/324；**per-instance**，网关多实例轮询（`x-vllm-instance` 变化） | W5 实验必须同时记录实例号 |
| 限流头 | **不存在 `x-ratelimit-*`** | 429 无法读 `Retry-After`，退避策略要自己定 |
| 流式首块 | `delta = {role:"assistant", content:""}`，content 是空串而非缺字段 | 用 `content === ""` 判"没输出"会误伤 |
| 流式 usage | `stream_options.include_usage` 才返回，且在 `finish_reason` **之后**，`choices` 为 `[]` | `choices[0].delta` 在此必崩 |
| 流式 usage 字段 | `prompt_tokens_details` 里**没有** `multimodal_tokens`（非流式有） | 同一 `Usage` 类型两边硬套会与现实不符 |
| 推理增量 | `delta.reasoning` 独立推，本次 35/50 块 | 与 content / tool_calls 可能任意交错，顺序不是契约 |
| 分片粒度 | **客户端栈决定**：TS(undici) 2 片/15KB，Py(httpcore) 66 片/276B | 任何"片有多大"的假设都是错的 |
| 分片 vs 事件边界 | Py 侧 65/66 片正好以事件边界结尾；TS 侧 1/2 | 服务端逐事件 flush，半包只在客户端合并时产生 |
| 分隔符实测 | 两侧各 70 个事件全是 `\n\n`，**没有一个 `\r`** | CRLF 分支仅单测覆盖，未真实验证 |
| UTF-8 切分 | 真实分片均未切断字符 | 字符级切分仅单测覆盖 |

---

## 1. SSE 解析的 4 个陷阱

实现见 `ts/src/sse.ts`，单测 `ts/src/sse.test.ts`（11 条）+ `ts/src/stream.test.ts`（3 条），全部离线。

### 1.1 半包：事件被从中间切断

```
chunk1 = 'data: {"city":"北'
chunk2 = '京"}\n\n'
```

`chunk1` 到达时**一个事件都不能吐**。正确做法是维护 `buffer`，只处理"已被分隔符终结的完整行"，最后一段永远留在 buffer 里等下个 chunk。

> 后果对照：若每块都 `JSON.parse(buffer)`，这里会解析 `{"city":"北` 并抛错，而错误发生的位置跟真正的故障点毫无关系。

### 1.2 粘包：一个 chunk 含多个事件

```
chunk = 'data: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\n'
```

必须返回 3 个事件。所以 `push()` 的返回类型是**数组**而不是单个事件——把"一块最多一事件"写死，会在网关合并推送时静默丢数据。

### 1.3 终止：`data: [DONE]` 不是控制行

`[DONE]` 走的是普通 data 通道，只是负载不是 JSON。本实现的边界：

- `sse.ts` 原样返回 `{data:"[DONE]"}`，**不对它做任何特殊处理**；
- `stream.ts` 见到它才停止，并且**不 yield 给上层**（上层拿到的都是可解析 chunk）；
- `[DONE]` 之后同一连接上的数据一律丢弃。

> 若把 `[DONE]` 当 JSON 解析，会在流正常结束时抛一次"意外结束"的假错误；若忽略它只等 `reader` 返回 `done`，则多等一个 RTT，且在 keep-alive 连接上可能永远等不到。

### 1.4 注释：`:` 开头的行是 keep-alive

```
: ping
```

整行丢弃，且**不参与事件边界判断**——它后面如果紧跟空行，那个空行仍是一个"事件结束"信号（此时 data 为空，按规范不派发）。

### 1.5 附：只有写了测试才会发现的 3 条

| 陷阱 | 反直觉之处 | 证据 |
|---|---|---|
| 行分隔符三选一 | `\r\n` / `\n` / `\r` 都合法，且 chunk 可能恰好切在 `\r` 与 `\n` 之间 | 单测 #7 |
| `data:` 只剥一个空格 | `data:  x` 的值是 `" x"`，不是 `"x"` | 单测 #4 |
| 空 data 不派发 | 孤立的 `data:\n\n` 按规范**产生不了事件** | 单测 #5 |

**UTF-8 边界**（字节层，不在 `sse.ts` 里）：中文 3 字节、emoji 4 字节，会被 chunk 边界切断。必须 `decoder.decode(value, {stream: true})` 逐块解，再在结束时 `decoder.decode()` 冲刷。用 `buf.toString()` 会在断点处产生 `�`，而**这个替换字符不会报错**，会静默污染模型输入。证据：`stream.test.ts` 把切点精确放在"京"的三字节序列中间。

### 1.6 为什么不能"chunk 到达就 `split("\n\n")`"

四个原因，前两个是致命的：

1. **事件会被切开**：切点落在 JSON 中间时，`split` 的前半段是半截数据，后半段是另一个半截数据，两边都不是合法事件。
2. **分隔符不止 `\n\n`**：`\r\n\r\n` 才是 HTTP 实际最常见的形态，只按 `\n\n` 切会把事件边界算错。
3. **一个 chunk 可能是 0 个事件、也可能是 N 个**：`split` 天然只能处理"恰好 1 个"的心智模型。
4. **UTF-8 边界在字节层**，`split` 之前就要求你拿到正确文本，这一步已经需要 `TextDecoder` 的 stream 模式。

本质区别：`split` 是**无状态**的一次性操作，而流式解析是**有状态**的——必须跨 chunk 保留"未完成的行"和"已经累积但未派发的 data"。

### 1.7 真实流量的分片画像（原始字节抓包，非解析后 JSON）

依据：`day3-ts-raw.*` 与 `day3-py-raw.*`（同一天、同 prompt、同一网关的配对样本），以及 `day2-*` 的历史样本。

```
客户端        总字节   分片数   片大小 min/avg/max   首片→末片        片尾=事件边界
TS(undici)    18341    2        3128 / 9171 / 15213  2987→3233 ms    1/2
Py(httpcore)  18203    66       90 / 276 / 789       3466→3722 ms    65/66
```

- **分片粒度由客户端网络栈决定，不是服务端行为。** 服务端是逐事件 flush 的（事件约 276B），httpcore 原样透传（65/66 片正好以 `\n\n` 结尾），undici 则把连续到达的数据合并成大块读。结论：**任何"片有多大""一片最多一个事件"的假设都是错的**，必须两端都对 1 字节片和大片成立。
- **半包在 TS 侧是常态（1/2 片切在 JSON 中间），在 Py 侧几乎不出现（1/66）。** 所以"半包"必须靠离线构造的畸形 chunk 测，不能指望真实流量复现——反过来说，Python 侧如果只靠真实流量验证，会漏掉半包路径。
- **没有 `\r`**：两侧共 140 个事件全部用 `\n\n` 分隔。CRLF 支持属于"规范要求 + 单测覆盖"，不能写成"已实测支持"。
- **没有切断 UTF-8 字符**：每片"解码后重新编码"字节数等于网络字节数。字符级切分仍是理论风险。
- **历史错误**：Day 2 曾把 15~16KB 归因于"中间代理攒包"，并据此断言"TTFT 客户端测不出来"。Day 3 的 Python 配对样本推翻了它——服务端逐事件 flush，客户端都能看到约 250ms 的连续流。首片偏移可以测，但它包含排队与预填充，不等于模型出首个 token 的时刻。

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

### 4.1 `TextDecoder({stream:true})` 与 `aiter_text()` 各自解决了什么

**两者解决的是同一件事：把"可能切断多字节字符的字节块"变成"永远完整的字符串"。** 差别在于谁来做。

| | TS | Python |
|---|---|---|
| 增量解码 | 自己做：`new TextDecoder()` + 每块 `decode(bytes, {stream: true})` + 结束时 `decode()` 冲刷 | `response.aiter_text()` 内部就是 `codecs.getincrementaldecoder("utf-8")`（httpx `_decoders.py:312`），末尾自动 `flush()` |
| 非法字节 | 默认替换成 `U+FFFD`，**不报错** | `errors="replace"`，同样**不报错** |
| 需要自己写的部分 | 解码 + 跨块行残留 | **只有**跨块行残留 |

关键认知：**库只解决"字节 → 字符"，不解决"字符 → 事件"**。行残留（`\r` 扣住、半行 JSON）两侧都必须自己维护，这正是 `sse.ts` / `sse.py` 存在的理由。若误以为 `aiter_text()` 连事件都切好了，Python 侧就会写出"每块直接 `split("\n\n")`"的代码，然后在片大小变化时崩掉。

### 4.2 实测对比（同一天、同 prompt、同网关）

| 维度 | TS | Python |
|---|---|---|
| 分片数 | 2 | 66 |
| 片大小 min/avg/max | 3128 / 9171 / 15213 B | 90 / 276 / 789 B |
| 片尾正好是事件边界 | 1/2 | 65/66 |
| 首片 → 末片 | 2987 → 3233 ms | 3466 → 3722 ms |
| 事件总数 | 70 | 70 |
| `\r` 出现次数 | 0 | 0 |

**结论：差异来自客户端网络栈，不是服务端。** undici 合并、httpcore 透传。所以：

1. 两侧解析器都要对"1 字节片"和"15KB 大片"正确，不能依赖任何粒度假设；
2. 半包路径必须靠离线构造的 chunk 测——真实流量在 Python 侧 65/66 都是完整事件，只靠真机验证会漏掉半包分支。

### 4.3 一个真实的同构偏差（跑真机才暴露）

Python 首版里 `stream_chat_completion` 把 `aiter_sse_events` 吐出的 `[DONE]` 直接丢给了 `json.loads`，真实请求立刻抛 `SSE data 不是 JSON：[DONE]`。TS 侧因为在 `streamChatCompletion` 里先判了 `isDoneEvent` 才没暴露。

修法不是"加个 if"就完事：

- 补 `is_done_event` 判断（与 TS 对齐）；
- 顺手把 `httpx.AsyncClient` 改成可注入，让这个 bug 能用 `MockTransport` 写成回归测试（`test_stream_chat_completion_skips_done_marker`）。

教训：**双语言同构不能靠"我按 TS 抄一遍"来保证**，只能靠同一组用例 + 真机各跑一次。这个 bug 就是抄漏了一行控制流。

---

## 5. 结构化输出选型结论

> 待 Day 5 补齐。三列对比表（`json_schema` / `tool_choice` / 纯 prompt）+ 本项目选型一段话。

（待填）
