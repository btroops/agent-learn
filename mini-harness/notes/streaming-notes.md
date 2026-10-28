# 流式协议笔记（W1 交付物）

> 规矩：本文件只写**亲手跑过并验证**的结论。没验证的写成 `待验证`，验证失败的写"实测不支持"。
> 每日过程与原始样本见 `notes/devlog.md` 与 `notes/samples/`；本文只沉淀可复用的结论。

状态：**编写中**（§0 基线 + §1 SSE 已完成，§2/3/4/5 随 Day 4/6/3/5 补齐）

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
| 分片粒度 | 15~16KB/片，由中间代理缓冲决定；首片 2.9~3.2s | **TTFT 客户端测不出来**，"首字节"≠"首 token" |
| 分片 vs 事件边界 | 5 个真实分片里 4 个切在 JSON 中间 | 半包是常态，不是边角 |
| 分隔符实测 | 144 个事件全是 `\n\n`，**没有一个 `\r`** | CRLF 分支仅单测覆盖，未真实验证 |
| UTF-8 切分 | 5 个真实分片均未切断字符 | 字符级切分仅单测覆盖 |

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

依据：`samples/day2-stream-raw.sse`（17KB）+ `day2-stream-long.sse`（37KB），各配一份 `.chunks.json` 记录分片边界。

```
样本   总字节   分片数   各片大小                到达偏移                片尾是事件边界
raw    17126    2        15218 / 1908            2932 / 2989 ms          否 / 是
long   37132    3        15211 / 16030 / 5891    3218 / 5768 / 6719 ms   否 / 否 / 是
```

- **片大小稳定在 15~16KB** → 中间代理在攒包，客户端看到的不是逐 token 流。首片 2.9s 是"缓冲满或上游结束"，不是首 token。做 trace 时该字段只能叫 first byte。
- **4/5 个分片的切点在 JSON 中间**，long #1 甚至切在 `"finish_reason"` 键名内部。这是半包逻辑每天都会被真实流量触发的证据。
- **没有 `\r`**：全部 144 个事件用 `\n\n`。CRLF 支持属于"规范要求 + 单测覆盖"，不能写成"已实测支持"。
- **没有切断 UTF-8 字符**：每片"解码后重新编码"字节数与网络字节数相等。字符级切分仍是理论风险。

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
