# 流式协议笔记（W1 交付物）

> 规矩：本文件只写**亲手跑过并验证**的结论。没验证的写成 `待验证`，验证失败的写"实测不支持"。
> 每日过程与原始样本见 `notes/devlog.md` 与 `notes/samples/`；本文只沉淀可复用的结论。

状态：**编写中**（§0 / §1 SSE / §2 tool_calls / §4 双语言差异 / §5 结构化输出已完成；仅剩 §3 故障样本随 Day 6 补齐）

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
| tool_calls 增量 | 首块带 `id`/`name` 但**没有 `arguments` 字段**；后续只有 `index` + `arguments` | 用 `id` 分桶会把这些片段并进同一个 `undefined` 桶、互相拼接（串味），见 §2.1 |
| 结束标志 | `finish_reason` 与 `delta:{}` 同块出现 | 它到达不代表参数收完，见 §2.3 |

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

实现见 `ts/src/tool-accum.ts` / `py/src/tool_accum.py`，单测各 10 条，原始证据 `samples/day4-toolcalls-raw.sse`。

### 2.0 先看真实形状

```
首块  { index:0, id:"chatcmpl-tool-...", type:"function", function:{ name:"get_weather" } }   ← 没有 arguments 字段
后续  { index:0, function:{ arguments:"{\"city\": \"" } }                                      ← 只有 index + arguments
结束  { delta:{}, finish_reason:"tool_calls" }                                                ← 空 delta 带结束标志
之后  { choices:[], usage:{...} }                                                             ← 流还活着
```

**首块的 `arguments` 是"字段不存在"而不是空串。** 类型写成 `arguments: string` 会在拼接时得到字符串 `"undefined"`。

### 2.1 陷阱一：必须用 `index` 分桶

`id` 只在首块出现。若用 `id` 当 key，第 2 片起 `delta.id` 就是 `undefined`，而 `undefined` 在 Map 里是**合法且稳定的键**（SameValueZero 比较），于是：

- **主因**：`buckets.get(undefined)` 从第二片起必然命中，**所有调用的后续片段并入同一个 `undefined` 桶**，不同调用的参数互相拼接；
- **表现**：带 id 的桶只剩首块 → `argumentsText === ""` → 按约定当 `{}` → 工具以空参数**静默执行**；`undefined` 桶拼成非法 JSON，进 `broken[]`；
- **报错落在最不重要的地方**：唯一被记录的错误在 `undefined` 桶，而两个真正执行错的调用看起来完全健康。

次生形态（只有给 `id` 加了守卫之后才会出现）：每片新建桶 → N 个半截调用；或直接丢弃 → 参数全空。

这是 §1.1「错误位置与故障点无关」的升级版：这次连报错都没有，只剩两个"成功"的空参调用。

`index` 是唯一在**每一片**都出现的字段。代价是必须容忍缺字段：`id` / `type` / `function.name` 全部 optional，只有 `index` 必填；缺 `index` 直接失败，不做猜测。

三点补充（都不依赖具体实现）：

- **类型声明不提供运行时保护**：`id: string` 只是让编译器相信，运行到的仍是 `undefined`，TS 在这一行不会报警；
- **Python 是同一个 bug 的另一种打扮**：`delta.get("id")` 得到 `None`，`None` 可哈希且稳定，合并行为与 `undefined` 完全一致（写成 `delta["id"]` 则当场 `KeyError`，吵但安全）；
- **哨兵值必须可靠**：内部用 `null` 表示"还没收到 id"，就只能做条件赋值（`if (delta.id !== undefined)`）；否则 `undefined` 会绕过 `draft.id === null` 的检查，直接以 `id: undefined` 混进 `calls`。

### 2.2 陷阱二：多工具的片段会交错到达

真实样本里两次调用是"先后完成"的（index 0 的 4 片走完才出现 index 1），但**这不是契约**。只要换个模型或网关，完全可能出现 `0,1,0,1,0`。

唯一的硬推论：**累积器必须按 `index` 独立维护状态**，不能用"当前正在拼哪一个"的游标——交错输入下游标必然把 A 的片段写进 B 的桶。

> **附注（工程选择，非协议要求）：拼完后按 `index` 升序输出。**
> 协议上没有顺序要求：配对靠 `tool_call_id`，把两条 `tool` 消息调换仍然合法。之所以仍这么做：
> ① `Map` / `dict` 的插入顺序取决于片段首次出现的顺序（`1,0,1,0` 就得到 `1,0`），排一下输出才是确定的；
> ② 按"完成顺序"输出不携带任何信息，只反映网络时序；③ 部分实现按位置回填 `tool` 结果，源顺序对它们最安全。
> W2 同理：并行执行下 `toolResult` 按源顺序写历史，prefix cache 才不会抖。见 `openai-protocol.md` §3.4。

### 2.3 陷阱三：`finish_reason` 不是参数完整的信号

三条论证的**强度并不相同**，不能并列成同等硬的柱子（初版正是这么写的，其中第 2 条是错的）：

1. **协议层面：规范有承诺，但只承诺"生成"，不承诺"你本地收全"。** `finish_reason` 非空即表示该 choice 生成结束，按规范其后不应再有该 choice 的 `delta`（usage-only chunk 在 `[DONE]` 之前到达且 `choices` 恒为 `[]`，见 `openai-protocol.md` §5.5）。所以"最后一片参数应在 finish 之前"**是有规范依据的**——初版写成"没有任何规范保证"是反向拔高。真正的问题是：本仓库面对 vLLM 网关，这份承诺能否兑现不可验证。
2. **观测层面：只能证明"流未结束"，证明不了"还有 delta"。** 样本里 `finish_reason` 之后确实还有 chunk，但那是 `choices: []` 的 usage-only chunk。它说明 `finish_reason ≠ 流结束标志`，**不携带任何 choice 的 delta**，因此推不出"之后还可能有 tool_calls 片段"。初版从"还有事件"跳到"还可能有 tool_calls 事件"，把事件当成了不加区分的整体——`非 sequitur`，属于硬伤。这条论证唯一能支撑的结论是：**不要在 `finish_reason` 处断连，否则会丢 usage。**
3. **代价不对称：这是决策论，不是存在性证据。** 它是条件论证——"**若**存在晚到片段"。而前两条都没有建立这个前提。它的独立价值在于：后补片段存在与否**无法排除**（你无法逐一验证每个网关都严格遵守规范），早封口的错误代价高且静默（`{"city":"北"}` 本身就是合法 JSON），晚封口只多等一个 `[DONE]`。不确定下选后者是理性的，但不能说成"后补片段一定存在"。

**结论（比初版收窄）**：在无法信任网关严格遵守"`finish_reason` 后无 delta"的前提下，等流真正结束再解析是**防御性最强**的判定。若规范被严格遵守，`finish_reason` + 解析成功也足够；但那个前提无法验证，而多等一个 `[DONE]` 成本极低。所以是"不可信环境下最稳"，不是"唯一正确"。

实现上的保险要分清语义：`finish()` 之后 `push()` 抛错，捕获的是**调用方 bug**（流已结束仍喂数据，或过早 `finish()`），作用是"拒绝处理并暴露问题"，**不是"处理晚到片段"**。正确性来自"不在 `finish_reason` 处封口、一直累积到流结束"，`sealed` 只是把静默错误转成显式崩溃。调试期这个取舍明显划算；上生产要评估崩溃代价——网关若真的晚到片段，更稳的做法是继续累积而不是崩掉。

### 2.4 参数残缺怎么处理

解析失败**不抛异常**，进 `broken[]` 并带上原文与原因（缺 id / 缺 name / 半截 JSON）。W2 的 loop 会把它转成 `isError` 的工具结果回填给模型——让模型知道"这个工具没执行成功"，比让整轮任务崩掉更划算。

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

实测见 `notes/devlog.md` Day 5，原始样本 `samples/day5/`。同一任务、同一句中文下的数据：

| 维度 | A `json_schema` | B `tool_choice` | C 纯 prompt（附文字 schema） |
|---|---|---|---|
| 兼容性 | 本网关支持，但**不校验** OpenAI strict 限制 | 支持，指定函数名与 `"required"` 均生效 | 通用 |
| 表达力 | JSON Schema 子集（嵌套/枚举/数值约束） | 同左（`parameters` 即 schema） | 受模型理解力限制 |
| 强制力 | **语法级**（`minimum` / `maximum` / `enum` 实测生效） | **只有开 `strict:true` 才强制**（P0-1；不开 strict 的 S4 无视 `minimum`，见 5.5） | 无 |
| 100% 合法 JSON | 是（**可满足的** schema，语法层保证） | **无保证**：参数只是文本（实测 2/2 可解析） | 实测 3/3，但无保证 |
| prompt token | 75（schema **不进 prompt**） | 451（+376 工具定义） | 198（+123 文字 schema） |
| 失败形态 | 约束不可满足时**静默扭曲语义** | 无视约束 / 参数可能不是合法 JSON | 中文键 / 漏字段 / markdown |

### 5.1 最反直觉的一条：强制力会骗人

给 `duration_hours` 加 `minimum: 100`，而原文明明是"预计 2 小时"，模型输出了 **205**。

原因：语法级约束让它**无法输出 <100 的合法值**，于是编了一个满足语法的数。它没有报错，也不会告诉你"你的约束和事实冲突"。

推论：**schema 校验通过 ≠ 数据正确**。任何"看起来结构完美"的输出都必须再过一遍业务校验（范围、单位、与原文的一致性）。

补一刀（Day 5 离线复验）：`205` 满足 `minimum: 100`，**任何正确的 schema 校验器都会放行它**。所以这类错误在 schema 层无论怎么加严都拦不住，只能靠"与原文比对"这类业务规则发现。

复跑 3 次（P2）：`duration_hours` 分别是 `2731 / 2000 / 2123`，全部 ≥100 但值每次不同。强制的是"合法"，不是"正确"；具体编成哪个数，模型自己也不稳定。

### 5.2 不要拿 OpenAI 的 strict 文档推断网关行为

`additionalProperties: true` 与 `required` 缺字段——这两种按 OpenAI strict 规则必然被拒，本网关全部返回 200。`minimum` 的封禁状态随版本变化：2024 首发时属于不支持关键字，2026 年外部资料称标准模型已支持、微调模型仍不支持（官方页未直读，标【待官方复核】）。

本网关只关心"能不能编译"，不关心 OpenAI 的合规性检查。但要注意证据强度：**200 只证明入口没拒，不证明编译器如何解释坏 schema**（A3 的输出"没多字段"就无法区分"允许但没加"和"不支持 true、按 false 处理"）。P1 补了两种失败形态：语法死路（`minimum:100` + `maximum:1`、`enum:[]`）在编译期直接 400；但 `required` 指向不存在的字段时却返回 200，并**静默弱化**，输出违反实际发出的 schema（§12.3）。

另外，A 路径只要给了 `json_schema` 就会编译，`strict` 缺省或 `false` 都不影响（P3）；`strict` 只对 tools 通道起开关作用。换供应商后本节的数字都要重测。

### 5.3 选型规则（本项目采用）

1. **有副作用的动作 → B**（`tools` + `tool_choice`）：需要 `id`、需要执行、需要 `role:"tool"` 回填，这些 `json_schema` 给不了。但必须显式开 `function.strict:true`，否则参数只是说明书（见 5.5）；开了之后与 A 一样受语法约束，仍要做业务校验。
2. **纯数据抽取 → A**（`json_schema`）：优势是带外 schema 不占 prompt token、延迟低、结构有保证；2×2 显示文字 schema 也能 5/5 合规，所以 A 的优势不是"更正确"，而是成本与保证（见 5.8）。
3. **C 只作降级**：网关不支持 A/B 时用文字 schema + 客户端 `JSON.parse` + schema 校验，失败要重试，不能当成功。
4. 无论哪条路径，**业务校验不能省**（见 5.1）。

### 5.4 一个实验方法上的教训

第一轮我把"纯 prompt 对照组"的 prompt 写成"只输出 JSON"，没给字段名，结果 3/3 产出中文键。看上去是"纯 prompt 不行"，实际上是**对照组根本没拿到同样的信息**。

把 schema 用自然语言补进 prompt 重跑后，3/3 通过——结论完全反转。凡是"某方案不可靠"的结论，先检查是不是自己没给对方同样的输入。

### 5.5 强制力跟着 strict 开关走，不跟着通道走（P0 已证实）

同一份 `minimum: 100`、同一句"预计 2 小时"，只改 `strict` 与 schema 挂在哪：

| 路径 | `strict` | schema 位置 | prompt token | 输出 | 是否强制 |
|---|---|---|---|---|---|
| A `response_format` | `strict:true` | 带外（编译成语法） | 75 | `205` | 是 |
| B `tools[].function.parameters`（S4） | 未写 | 带内（进 prompt） | 457 | `2` | **否** |
| B 同上（P0-1） | `strict:true` | 带内（进 prompt） | 462 | `200` | **是** |

决定性证据不再只是 token 数：

- **A 路径**：`字段名可用中文或英文？没指定` —— 模型**没看见** schema，字段名却是对的，说明约束在采样层。
- **B 未开 strict（S4）**：`...it would fail validation... I should attempt the call` —— 模型**看见了**约束，仍然违反。
- **B 开 strict（P0-1）**：reasoning 里明确说"先按 2 调用试试"，最终 arguments 却是 `200`——**模型想写 2，写不出来**，只能被约束到 ≥100。

所以正确结论是：**`response_format` 的 schema 默认带外编译；`tools` 的 schema 只有开 `strict:true` 时才被服务端约束，否则只是说明书。** 用工具时仍要客户端校验参数，因为 strict 只保证结构、不保证语义（P0-1 的 2 小时 → 200 小时）。

**证据限制**：P0-1 是单次样本，且 `strict` 会进 prompt（457 → 462），模型能看见它；"想传 2、实际 200"能区分"自觉遵守"与"被约束"，但仍建议重复 3 次加固。

**入口校验仍然缺位**：P0-2 用 `strict:true` + 故意缺 `additionalProperties` 的 schema，返回 **200**。也就是说网关不在入口按 OpenAI 元规则拒绝，坏 schema 会被直接交给编译器或回退——与 A3/A4 的表现一致。

【待验证】B + `strict:true` 下 `required` / `enum` 是否同样生效（目前只测了 `minimum`）；以及 `strict` 是否只对 `tool_choice` 强制指定的那个工具生效。

### 5.6 大 schema 的编译开销：约 20ms，别把建连当编译

16k 字符的 schema 在 A 路径仍只占 75 prompt tokens（§12.1）。冷热复测（§12.6）：固定输出 + 关思考 + `max_tokens:1`，先跑一次小 schema 建连，再发 121 字段全新文法——首次 304ms、第二次 282ms，**编译/缓存差约 20ms**，远小于最初观察到的 ~400ms。

最初那 400ms 来自两处：进程内首次请求的 TCP/TLS 建连（约 250–280ms），以及 reasoning token 长度波动（100–200 tokens）。另外，关思考会同时改 `prompt_tokens`（75 → 49），跨模式比 token 不能直接相减。

选型含义：大 schema 的编译成本可以忽略；真正的成本是**思考 token** 与**首次建连**。

### 5.7 保证失效的两种情形：length 与 refusal

- **`finish_reason:"length"`**：`max_tokens:8` 时 content 被截成 `{"title":"产品评审会","location`，JSON 不完整。解析前必须先看 `finish_reason`。
- **refusal**：本网关不填 `refusal` 字段（恒 `null`）。无 schema 时拒答落在 content；**有 schema 时，grammar 会覆盖拒答意图**——system 强制拒答、reasoning 也计划拒答，最终仍输出完整的事件 JSON。用 `json_schema` 时不能把"结构化成功"当成"模型同意执行"。

### 5.8 机器 schema vs 文字 schema：2×2 实测

H2/H3 是同 prompt、同 194 prompt tokens，唯一差异是 `response_format`：

| 组 | schema 通过 | completion | 耗时 |
|---|---|---|---|
| `json_schema`（机器，75 prompt tokens） | 5/5 | 180–224 | 1.7–3.0s |
| `json_schema` + 文字 | 5/5 | 624–1325 | 7.3–15.7s |
| `json_object` + 文字 | 5/5 | 561–1565 | 6.4–16.9s |
| `json_object`（无信息） | 0/5 | 195–265 | 1.9–2.5s |

结论：文字 schema 不是"做不对"，而是**贵**；机器 schema 的收益是零 prompt 成本 + 结构保证 + 低延迟，不是正确率。两者都会产出"合法但语义错"的值（grammar 组出现 `202002` 小时，文字组用空 `address` 占位）。详见 devlog §14。
