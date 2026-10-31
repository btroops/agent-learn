# OpenAI Chat Completions 协议实录

> 不引入任何 SDK，只用原生 `fetch` 打一次真实请求，然后从响应反推协议设计。
>
> 目的不是"背字段"，而是搞清楚**每个字段为什么长这样**——因为后面所有的流式拼接、上下文裁剪、prefix cache 实验，都是这些设计的直接推论。

---

## 0. 读法：证据等级

本文每条结论都带标记。这是这份文档和你随手搜到的协议教程最大的区别。

| 标记 | 含义 | 出处 |
|---|---|---|
| **【实测】** | 对本仓库网关真实请求得到的结论 | `notes/samples/day1-*.json`，2026-10-27 |
| **【官方】** | 官方 SDK 类型定义原文（由 OpenAPI 规范生成） | `openai@7.45.0` 的 `.d.ts`，见第 9 节核对记录 |
| **【文档】** | OpenAI 文档正文，经第三方镜像站抓取；该站自述与 OpenAI 无关联，**逐条与 SDK 类型核对一致才采信** | `developers.openai.ac.cn`，见 9.1 / 9.5 |
| **【规范】** | 公开协议描述的行为，未在官方 SDK 里找到原文，**本仓库也未验证** | 二手资料 |
| **【推断】** | 由实测结果反推出的设计动因 | 无第二网关交叉验证 |
| **【待验证】** | 已列入 W1 任务，但还没跑 | `weeks/W1.md` |

> 为什么这么绕：`platform.openai.com` 与 `developers.openai.com` 对本机一律返回 **403**（Cloudflare，连 `robots.txt` 都 403），官网正文抓不到。所以走了两条替代路：**npm 上的官方 SDK 类型**（由 OpenAPI 规范自动生成，字段必填性/字面量联合最精确）与**文档镜像站正文**（用于取散文说明）。两者的取法、可信度、交叉验证方式见第 9 节。

三条铁律：

1. 【实测】的结论必须能在样本文件里找到对应字段，否则删掉。
2. 【文档】的结论必须能在【官方】SDK 类型里找到对应字段，否则降级为【规范】。
3. 任何规范结论换到本项目网关都可能不成立——本网关后端是 vLLM，不是 OpenAI 官方服务（见第 6 节）。

---

## 1. 请求：一个 JSON，六种 role

### 1.1 最小可用请求

```json
{
  "model": "DeepSeek-V4.1-Flash",
  "messages": [{ "role": "user", "content": "北京现在天气怎么样？" }]
}
```

**【实测】** 只有这两个字段就能拿到 200。`model` 必填，`messages` 必填，其余全部可选。

`types.ts` 当前建模的完整字段集：

```ts
export interface ChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
}
```

注意这个字段列表很短。不是因为协议简单，而是因为**只写真实用过的**。`temperature`、`max_tokens`、`top_p`、`n`、`stop`、`seed`、`parallel_tool_calls`、`stream_options` 都存在，但还没发过一次，所以不进类型。用到再加，避免"看起来支持"的假象。

### 1.2 协议是无状态的，state 全在 `messages` 里

这是整个协议最重要的一句话。

服务端不记得你上一轮说了什么。所谓"多轮对话"，是客户端每轮把**全部历史**重新发一遍。推论：

- 第 N 轮的 `prompt_tokens` 包含前 N-1 轮的全部内容 → 成本随轮次线性甚至超线性增长
- 想让服务端少算钱，唯一手段是让它**命中前缀缓存**（见 4.3）
- 上下文压缩、裁剪、摘要，本质上都是在改写这个数组

后面 W4（预算裁剪）、W5（压缩 + prefix cache）、W6（session 持久化）三周的工作，全部是这一句话的展开。

### 1.3 六种 role 各自能带什么

**【官方】** `ChatCompletionMessageParam` 是 6 个类型的联合，不是 4 个：

```ts
type ChatCompletionMessageParam =
  | DeveloperMessageParam | SystemMessageParam | UserMessageParam
  | AssistantMessageParam | ToolMessageParam | FunctionMessageParam;
// ChatCompletionRole = 'developer' | 'system' | 'user' | 'assistant' | 'tool' | 'function'
```

| role | 必带 | 可选 | 说明 |
|---|---|---|---|
| `developer` | `content` | — | **【官方】** 新一代模型里替代 `system` 的位置，优先级更高 |
| `system` | `content` | — | 指令/人设。**实测**放在数组首位 |
| `user` | `content` | — | 用户输入，可以是字符串或多模态 part 数组 |
| `assistant` | — | `content`、`tool_calls`、`refusal` | 模型输出，回传时要**原样** |
| `tool` | `content`、`tool_call_id` | — | 工具执行结果，`tool_call_id` 指向它回应的那次调用 |
| `function` | `content`、`name` | — | **【官方】** 遗留类型，配 `function_call` 用，新代码不要碰 |

注意我在这里改过一个错误：最初本表只写了 4 种，漏了 `developer` 与遗留的 `function`，并把 vLLM 非标的 `reasoning` 当成了 `assistant` 的标准可选字段——**【官方】** `ChatCompletionMessage` 里**根本没有** `reasoning`，见第 9 节。

两个反直觉点：

1. `assistant` 消息的 `content` **可以是 `null`**（【实测】见 3.2）。所以 `Message.content` 的类型是 `string | null`，不是 `string`。
2. `tool` 消息的 `content` 永远是字符串，哪怕工具返回的是对象——要自己 `JSON.stringify`。协议不分"结构化结果"，一切皆文本。

---

## 2. 响应：三层嵌套

### 2.1 骨架

```
ChatResponse
├── id / object / created / model      元信息
├── system_fingerprint                 后端指纹
├── choices[]                          ← 数组，所以永远读 choices[0] 之前要先判空
│   ├── index
│   ├── message                        ← 真正的输出
│   └── finish_reason                  ← 为什么停
└── usage                              ← 计费明细
```

### 2.2 为什么 `choices` 是数组

**【规范】** 请求可以带 `n`（一次生成多个候选）。本项目永远 n=1，永远只有 `choices[0]`。

但代码里**不要**写成 `response.choices[0]` 就完事——先判 `length > 0`。网关异常时返回空数组是完全合法的 JSON，直接取下标会 `undefined` 崩在很远的地方。

### 2.3 顶层字段逐个核对

以 `samples/day1-chat-toolcall.json` 为例：

| 字段 | 实测值 | 记住什么 |
|---|---|---|
| `id` | `chatcmpl-b88d7e47-6420-...` | 每次请求唯一，日trace 关联用 |
| `object` | `"chat.completion"` | **【规范】** 流式是 `"chat.completion.chunk"`，可用来判断拿到的是不是流式帧 |
| `created` | `1793069692` | **秒**级，不是毫秒。和 `Date.now()` 差 1000 倍，时间计算容易错 |
| `model` | `"DeepSeek-V4.1-Flash"` | 回显请求值，网关可能改写别名 |
| `system_fingerprint` | `vllm-0.0.0-tp4-pp2-ep-8d310e51` | 后端实例指纹。变化 = 换实例 = 缓存大概率失效 |
| `service_tier` | `null` | 未开通，忽略 |
| `usage` | 见第 4 节 | — |

### 2.4 `message` 实测有 8 个字段，我们只用 3 个

```json
{
  "role": "assistant",
  "content": null,
  "refusal": null,
  "annotations": null,
  "audio": null,
  "function_call": null,
  "tool_calls": [ ... ],
  "reasoning": "The user asks about Beijing weather. I should call get_weather."
}
```

`refusal` / `annotations` / `audio` / `function_call` 实测恒为 `null`，所以**不进类型**。

其中 `refusal` 要单独说：即使 system 强制拒答，该字段仍为 `null`，拒答落在 `content`；而带 `json_schema` 时，拒答意图会被 grammar 覆盖，最终输出的是完整任务 JSON（P3-5）。所以不能靠 `refusal` 判断模型是否拒绝。

`function_call` 是需要单独说一句的：它是工具调用的**旧版字段**（单数，一次只能一个），`tool_calls` 是它的替代品（数组，可并行）。有些老网关只实现旧字段。**【规范】** 两者不要同时用。

如果哪天换网关后 `tool_calls` 一直是 `null` 但 `finish_reason` 是 `tool_calls`，第一件事就是去看 `function_call`。

---

## 3. 工具调用协议（本文核心）

### 3.1 请求侧：怎么声明一个工具

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的实时天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名，例如：北京" },
            "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

结构是**两层嵌套**：`tools[]` 每一项有 `type`，具体定义在 `function` 里。

四个关键点：

**(1) `type` 有两个取值，不是只有一个。** 我最初写的是"只有 `function`"，**【官方】** 已修正：

```ts
type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;
// { type: 'function', function: { name, description?, parameters?, strict? } }
// { type: 'custom',   custom:   { name, description?, format?: {type:'text'} | {type:'grammar', grammar:{...}} } }
```

`custom` 是 2026 年新增的：**不给 JSON Schema，让模型直接吐自由文本**（可选用语法约束）。调用侧返回的不是 `function.arguments`，而是 `custom.input`。适用场景是"参数就是一段代码/一段 SQL/一整篇文章"，用 JSON Schema 包一层反而是浪费。

本项目（W1-W15）只用 `function`，但**知道有 `custom` 这件事很重要**：这解释了为什么响应侧 `tool_calls` 现在是个联合类型，而不是单一定义。

**(2) `name` 是模型唯一认得的标识符，且有格式约束。** **【官方】** 原文：`Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64`。模型输出 `tool_calls[].function.name` 时回的就是这个字符串，它同时充当"路由 key"。所以 **name 冲突是致命的**，W3 的工具注册中心第一件事就是名称冲突检测；长度 64 与字符集是服务端会直接拒绝的硬约束。

**(3) `description` 是 prompt，不是注释。** 这是最容易被当成"写给人看"的地方。模型是否调用这个工具、调用时填什么参数，基本由 description 和 parameters 里的 `description` 决定。**它每轮都计费**（见 4.2），所以 W3 要做"description 长度预算"——这是成本问题，不是代码洁癖。

**(4) `parameters` 是 JSON Schema，不是 TypeScript 类型。** **【官方】** 补一条：**省略 `parameters` 等于声明一个无参函数**，不是"参数随便填"。两者不等价：

| JSON Schema | TS | 差异 |
|---|---|---|
| `required: ["city"]` | `city: string` | TS 里必填，但模型可能不填，运行时仍需校验 |
| `enum: ["celsius"]` | `"celsius" \| "fahrenheit"` | 枚举语义一致 |
| 无 | `?:` 可选 | JSON Schema 里"不在 required 里"才表示可选 |
| 无 | 嵌套对象类型 | 要靠 `$defs` / `properties` 手写 |

结论：**schema 只约束模型的输出倾向，不保证运行时合法**。参数校验必须自己做（W3 用 zod / pydantic），校验失败要把错误信息回传给模型让它自我修正。

**(5) `strict: true` 不是"随便什么合法 JSON Schema 都能用"。** **【文档】** 规则很具体；Day 5 实测的是本网关**不检查**这些规则（见 devlog Day 5 §10）：

1. `parameters` 里的**每个对象**都必须写 `"additionalProperties": false`（嵌套对象也要）
2. `properties` 里的**所有字段**都必须进 `required`

那"可选参数"怎么写？**不是不放进 required，而是把类型改成含 `null` 的联合**：

```json
"unit": { "type": ["string", "null"], "enum": ["celsius", "fahrenheit"] }
```

这条反直觉度很高：**JSON Schema 里常见的"可选"写法在 strict 模式下是非法的**，你必须在 required 里列出它、用 `null` 表达缺省。

其余硬约束（**【文档】+【外部资料，2026-10 复核】**）：

- **不支持的关键字**：`allOf`、`not`、`if/then/else`、`dependentRequired`、`dependentSchemas`；`anyOf`、`$defs`/`$ref` 支持，但每个分支自身也得是合法 strict schema。
- **根节点**：`response_format` 的根用 object；root 为 `anyOf` 不被支持。
- **规模上限**：5000 个对象属性、10 层嵌套、1000 个枚举值、12 万字符（名称 + 枚举）。
- **数值/字符串约束的封禁范围随版本变化**：2024 首发时 `minimum`/`maximum`/`multipleOf`/`minLength`/`maxLength` 均不支持；2026 年外部资料称标准模型已支持数值约束，**微调模型仍不支持**。官方页本次访问 403、未直读，标【待官方复核】。
- **错误形态**：入口校验失败是 400，消息带上下文路径，如 `Invalid schema for response_format 'event': In context=(), 'additionalProperties' is required to be supplied and to be false.`；tools 通道是 `Invalid schema for function 'emit_event': ...`。
- **两个例外会让"保证"失效**：`refusal` 非空、`finish_reason: "length"`。解析前先看这两个。
- `strict` 也出现在 `response_format.json_schema.strict`，但两个通道行为不同：`response_format` 只要给 `json_schema` 就编译，`strict` 缺省 / `false` / `true` 都强制（P3）；`tools` 则必须显式 `strict:true` 才强制，否则参数只是说明书（P0/S4）。两侧入口都不校验元规则（P0-2 返回 200）。

另外几个行为差异也要记住：

- **Chat Completions 在不写 `strict` 时默认是"非严格"**；只有 Responses API 才会尝试自动规范化 schema。
- **微调模型 + 单会话多次调用** → 严格模式会被**自动禁用**。
- strict 的 schema 会被**缓存**（为了性能），所以它**不适用于零数据保留（ZDR）策略**。

### 3.2 响应侧：`tool_calls` 长什么样

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "chatcmpl-tool-84e66557a902b011",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\": \"北京\", \"unit\": \"celsius\"}"
      }
    }
  ]
}
```

**三个必记事实（全部【实测】）：**

| 事实 | 值 | 后果 |
|---|---|---|
| `content` | `null` | **不能用 content 判空来判断有没有工具调用** |
| `finish_reason` | `"tool_calls"` | 这才是判据 |
| `arguments` | **一个 JSON 字符串**，不是对象 | 必须 `JSON.parse`，且必须等完整 |

注意 `arguments` 的引号：它是一层被转义的字符串。打印出来看到 `{\"city\": ...}` 是正常的，不是双重编码 bug。

### 3.3 为什么 `arguments` 是字符串而不是对象

这是整个工具协议里**最值得想明白的设计**。三条动因：

**动因 1：流式增量传输。** JSON 对象无法"传半个对象"——你没法把一个 `{` 和它的闭合 `}` 分两次发给客户端还保持结构合法。字符串可以任意 append。为了让同一套字段在流式/非流式下形状一致，只能选字符串。

**动因 2：解析责任归属。（【推断】→【文档】已证实）** 我原本是从"模型在生成文本"这个前提推出来的，后来在文档里找到了明确表述：

> `arguments` 为模型生成的 JSON 字符串，**不保证是合法 JSON**，也可能幻觉出 schema 未定义的参数，调用前需在代码中校验。

这句话比任何解释都有用——它等于官方承认：**协议只保证"有一个字符串字段"，不保证内容合法**。所以校验不是防御性编程，是规范要求。

**动因 3：长度与结构解耦。** 客户端不需要在 token 流中途维护 JSON 解析状态机，只需要做"字符串拼接"，等结束了再 parse 一次。

代价很直接，也就是 W1 Day 4 的全部难点：

- 必须处理 parse 失败（**文档明说可能不是合法 JSON**）
- 必须校验"schema 里没有的字段"（**文档明说可能幻觉出多余参数**）
- 必须等所有分片到齐才能 parse，中途不能"试解析"
- 流式下同一串会被切成碎片，且多个工具的碎片会**交错**

### 3.4 三轮闭环：工具结果怎么送回去

这是本仓库**还没实现**的部分（W2 的 loop 才写），但形状必须现在记住。

```
第 1 轮请求
  messages: [user]
  ↓
响应
  choices[0].message = { role:"assistant", content:null, tool_calls:[{id:"call-1", ...}] }
  finish_reason: "tool_calls"
  ↓
本地执行工具，拿到结果 "晴，12℃"
  ↓
第 2 轮请求 —— messages 数组变成 3 条
  [
    { role:"user",      content:"北京现在天气怎么样？" },
    { role:"assistant", content:null, tool_calls:[{ id:"call-1", type:"function", function:{name,arguments} }] },   ← 原样回传
    { role:"tool",      tool_call_id:"call-1", content:"晴，12℃" }                                                   ← 结果
  ]
  ↓
响应
  choices[0].message.content = "北京现在晴，气温 12 摄氏度。"
  finish_reason: "stop"
```

**三条硬约束：**

1. **`assistant` 那条必须原样回传**，包括 `tool_calls` 里的 `id`、`name`、`arguments` 字符串。你可以不传 `reasoning`，但不能只传 `content`。
2. **每条 `tool_calls[i]` 必须有且只有一条对应的 `role:"tool"` 消息**，靠 `tool_call_id` 配对。少一条、多一条、id 对不上，历史就是非法的。
3. **不能只回 tool 消息、不回 assistant 消息。** 否则模型看到的是一条"凭空出现的工具结果"，无法理解上下文。

**另有一条工程建议，不是协议要求：并行调用时，`tool` 消息按 `tool_calls` 的源顺序排列。**

配对依据是第 2 条的 `tool_call_id`，不是数组位置——**公开文档里没有任何关于顺序的条款**，所以把 A、B 两条 tool 消息调换，协议上依然成立。仍建议按源顺序排，理由不在正确性：

- 兼容按位置回填的实现（`zip(tool_calls, results)` 这类写法很常见，顺序一乱就配错）；
- 让历史确定可复现：并行执行后若按"完成顺序"写，同一批调用的消息序每次不同，prefix cache 命中率会抖，日志也没法逐次比对；
- 代价为零。

本网关是否容忍乱序仍**【待验证】**——但按源顺序排不需要先验证它。这条在 W2 会变成一个具体的设计问题：**并行执行下，`toolResult` 按源顺序写入历史，而不是按完成顺序。**

### 3.5 `finish_reason` 的取值，语义完全不同

**【实测】** 见过 `stop` 和 `tool_calls`；**【官方】** 全集是 5 个：

```ts
// 非流式：必填，不会是 null
finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
// 流式：中间 chunk 为 null
finish_reason: ... | null;
```

| 值 | 含义 | 能不能直接给用户看 | 能不能执行工具 |
|---|---|---|---|
| `stop` | 模型自然收尾 | 能 | — |
| `tool_calls` | 模型要求调用工具 | 不能（content 是 null） | 能，但**流式下要等参数收完** |
| `length` | 被 token 上限截断 | 不能 | **绝对不能**，参数是半截 JSON |
| `content_filter` | 被内容策略拦截 | 不能 | 不能 |
| `function_call` | **【官方】** 遗留值，配 `function_call` 字段 | 不能 | 同 `tool_calls`，但参数在 `function_call.arguments` |

注意"必填 vs 可空"这个差别：**非流式的 `finish_reason` 不会缺失，流式中间 chunk 一定是 `null`**。所以流式判断"这一轮结束没有"不能看 `finish_reason === null`，要看它变成非 null。

这里藏着一条容易被忽略的因果关系：

> `finish_reason` 描述的是"**这一轮生成为什么停下**"，不是"**任务结束了**"。

所以 `tool_calls` 不是终点，是控制权转移的交接点——从模型转给你。W2 那条"`stopReason === "length"` 时不执行任何工具调用、回填 isError"的规则，依据就是上表第三行：**半截 JSON 解析出来的对象可能"看起来合法"但字段缺失，执行它等于用编造的参数产生副作用。**

这也是 W1 Day 7 的自检问题"为什么 finish_reason 到了也不能马上执行工具"的答案前半句。后半句在 5.4。

### 3.6 `tool_choice` 的五个取值，有一个专为缓存而设

**【官方】** 类型定义是 `'none' | 'auto' | 'required' | NamedToolChoice | AllowedToolChoice`。前三个好懂，"强制调用某个函数"也好懂。有意思的是第 5 个：

```json
{
  "tool_choice": {
    "type": "allowed_tools",
    "mode": "auto",
    "tools": [{ "type": "function", "function": { "name": "get_weather" } }]
  }
}
```

**【文档】** 给出的理由值得单独记一行：

> `allowed_tools` 的用途：在不修改传入的完整 `tools` 列表的前提下，只让本轮部分工具可调用——**这样可最大化保留提示词缓存的收益**。

这句话把三件事串起来了：**前缀缓存要求前缀稳定 → 动态增删 `tools` 会让前缀失效 → 所以官方提供了"tools 不动、只改本轮可见子集"的机制。**

我的判断：本项目 W1-W3 用不到 `allowed_tools`（工具少），但**它证明了"工具列表抖动会破坏缓存"是官方承认的事实**，W5 做缓存布局时可以直接引用这条，不用自己再论证一遍。

另外两个**官方明确的叫法**，避免我在别处看混：

- 强制指定函数在 **Chat Completions** 里是 `{"type":"function","function":{"name":"..."}}`（多一层嵌套）
- 在 **Responses API** 里是 `{"type":"function","name":"..."}`（扁平）

文档正文两个 API 混着举例，**照抄会 400**。本仓库只碰 Chat Completions，按前者写。

### 3.7 官方给的规模建议，正好对上我的实测

**【文档】** 两条软性建议：

- **每轮开始时同时可用的函数 < 20 个**
- 工具多时用 `tool_search` 延迟加载（仅 gpt-5.4+）

这和我 4.2 节实测的"1 个工具 ≈ 289 tokens/轮"是同一个结论的两个侧面：**官方从"准确率"角度建议少于 20 个，我从"成本"角度算出 20 个 ≈ 5800 tokens/轮。** 两条独立证据指向同一件事，W3 的"工具数量预算"就有了双向依据。

---

## 4. usage 与计费

### 4.1 实测两组数字

| 场景 | prompt_tokens | completion_tokens | total | reasoning_tokens | cached_tokens |
|---|---|---|---|---|---|
| 纯对话（plain） | 35 | 121 | 156 | 91 | 0 |
| 带 1 个工具（toolcall） | 324 | 71 | 395 | 14 | 256 |

### 4.2 `prompt_tokens` 到底包含什么

**A/B 实验设计**【实测】：两次请求的 `messages` 完全相同（都是那句"北京现在天气怎么样？"），唯一差异是第二次多了 `tools` 字段。

```
324 - 35 = 289
```

结论：**1 个 `get_weather` 工具定义 ≈ 289 prompt tokens**，其中主要是 description 和 JSON Schema，不是那个短 name。

推论（W3 的成本依据）：

- 工具定义**不是一次性开销**，每一轮请求都要重新付一次
- 20 个工具 ≈ 5800 tokens/轮；10 轮对话 ≈ 58000 tokens 只为"让模型知道有哪些工具"
- 所以工具数量、description 长度，本身就是上下文预算的一部分

`prompt_tokens` 的完整拆分：

```
system 提示词
+ 全部工具定义（tools 数组整体序列化后的 token）
+ 全部历史消息（user / assistant / tool 的 content 与 tool_calls）
+ 本轮 user 输入
= prompt_tokens
```

一个容易忽略的点：**历史里的 `tool_calls` 参数也算 prompt tokens**。一次工具调用塞了 2KB 的 JSON 参数，之后每一轮都在为这 2KB 付钱。

### 4.3 `cached_tokens` 是"已包含"不是"额外"

```json
"prompt_tokens_details": {
  "cached_tokens": 256,
  "created_cache_tokens": 0,
  "multimodal_tokens": null
}
```

- `cached_tokens: 256` 表示 324 个 prompt token 里有 256 个命中了前缀缓存，**不是 324+256**
- 命中的部分通常单价更低（本网关未验证折扣比例）
- **【实测】缓存是 per-instance 的**：响应头 `x-vllm-instance` 在两次请求间从 `b` 变到 `a`，命中率随之变化

这条是"不看响应头就会得出错误结论"的典型案例：如果你做 prefix cache 实验时只记录 `cached_tokens` 不记录实例号，会得到一组**无法复现**的抖动数据，然后误以为缓存策略无效。

`created_cache_tokens` 是 **vLLM 非标字段**，表示本次写入缓存的 token 数。W5 做"缓存友好布局"时它是核心指标：**写入多、命中少 = 布局错了**。

**【官方】** 补一个关键对照：标准 `prompt_tokens_details` 里其实有对应物，只是名字不同：

| 标准字段 | 本网关字段 | 含义 |
|---|---|---|
| `cached_tokens` | `cached_tokens` | 命中缓存的 token 数 |
| `cache_write_tokens` | `created_cache_tokens` | 本次写入缓存的 token 数 |
| `text_tokens` / `image_tokens` / `audio_tokens` | `multimodal_tokens`（恒 null） | 按模态拆分 |

这条对照有实际价值：**写跨网关的代码时要认标准名，读本网关的日志时要认 vLLM 名**。同一件事两个名字，是最容易写错分支的地方。而且标准里这几个字段全是可选的（`?`），本网关却是必填且带 null 占位——所以类型不能照抄任何一边。

### 4.4 `reasoning_tokens`：算钱但不进 `content`

```json
"completion_tokens_details": { "reasoning_tokens": 14 }
```

`completion_tokens` = 思维链 + 正式输出。`reasoning` 字段里那段英文思考过程就是思维链。

实测占比 20%~75%（plain 样本 91/121 ≈ 75%，toolcall 样本 14/71 ≈ 20%）。

**后果**：任何"用 `content.length` 估算成本"的代码都会低估 2~4 倍。W4 的 token 预算器必须直接读 `usage.completion_tokens`，不能自己数。

同一条原因还影响**预算预留**：你设 `max_tokens: 1000`，模型可能只输出 200 字 content，剩下 800 全烧在 reasoning 上——用户看到的是"回答被截断"。

**关思考的两种写法（【实测】Day 5 P1）**：`reasoning_effort: "none"` 与 `chat_template_kwargs: {"thinking": false}` 都被接受，响应里 `reasoning` 为空、`reasoning_tokens` 为 0。同一句 prompt：开思考时 `prompt_tokens` 75，关思考 49（模板少了 thinking 提示）；大 schema 场景的 `completion_tokens` 从 176–213 降到 10–13。跨思考模式比较 token 不能直接相减；做延迟/缓存实验应先关思考。

---

## 5. 流式：官方规范（**本仓库尚未实测**）

> 本节形状来自 **【官方】** SDK 类型定义，行为全部是 **【待验证】**。逐条对应 W1 Day 2/4/6 的验证任务。
> 换句话说：**"字段长什么样"可以信，"这个网关会不会这么干"不能信。**

### 5.1 传输层

**【规范】** `stream: true` 后，响应头 `content-type: text/event-stream`，走 SSE。（SSE 本身是 W3C 规范，与 OpenAI 无关。）

SSE 帧格式：

```
data: {"id":"...","object":"chat.completion.chunk",...}\n\n
data: {"id":"...","object":"chat.completion.chunk",...}\n\n
data: [DONE]\n\n
```

几个细节：

- 帧之间是**双换行** `\n\n` 分隔
- `data:` 后面的空格可能有一个、可能有零个（规范允许两者）
- `[DONE]` **不是 JSON**，直接 `JSON.parse` 会抛异常
- 以 `:` 开头的行是注释（keep-alive 心跳），必须丢弃

**【官方】** 还有一个多数教程不会提的字段：`delta.obfuscation`。

> Stream obfuscation adds random characters to an `obfuscation` field on streaming delta events to normalize payload sizes as a mitigation to certain side-channel attacks.

也就是说官方会在每个 delta 里塞一段随机字符，把包长抹平，防的是**按响应长度推断内容的侧信道攻击**。它**默认开启**，可用 `stream_options.include_obfuscation: false` 关掉。

对我的影响只有一个：**解析器必须忽略不认识的字段**，不能写 `Object.keys(delta).length === 1` 之类的判断。顺带这也解释了一个常见困惑——"为什么每个 chunk 大小看起来差不多"。

**【待验证】** 本网关实际用什么做心跳、是否发送 `retry:` 字段、是否带 `obfuscation`。

### 5.2 流式 chunk 的骨架

**【官方】** 和[非流式](#23-顶层字段逐个核对)的结构差异只有两处：

| | 非流式 | 流式 |
|---|---|---|
| `object` | `"chat.completion"` | `"chat.completion.chunk"` |
| `choices[0]` | `message` | `delta` |

`delta` 是"增量"，只包含本次新增的部分：

```json
{"choices":[{"index":0,"delta":{"content":"北"},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{"content":"京"},"finish_reason":null}]}
{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
```

注意最后一个 chunk：`delta` 是**空对象**，只有 `finish_reason`。所以不能写 `if (delta.content)` 完事，`finish_reason` 可能和空 delta 一起到。

### 5.3 流式工具调用：碎片序列

**【规范】** 工具调用在流式下会被切成碎片。示意（**非实测，Day 4 验证**）：

```
chunk 1: delta.tool_calls = [{index:0, id:"call_1", type:"function", function:{name:"get_weather", arguments:""}}]
chunk 2: delta.tool_calls = [{index:0, function:{arguments:"{\"ci"}}]
chunk 3: delta.tool_calls = [{index:0, function:{arguments:"ty\": \"北"}}]
chunk 4: delta.tool_calls = [{index:0, function:{arguments:"京\"}"}}]
chunk 5: delta = {}, finish_reason = "tool_calls"
data: [DONE]
```

**【官方】** 证据（`ChatCompletionChunk.Choice.Delta.ToolCall`）：

```ts
interface ToolCall {
  index: number;                 // 必填，唯一一个没有 ? 的字段
  id?: string;
  function?: { arguments?: string; name?: string };
  custom?: { input?: string; name?: string };
  type?: 'function' | 'custom';
}
```

`index` 是**唯一必填**字段，其余全部可选——这不是文档措辞，是类型定义。它等价于官方在说："你只能靠 `index` 认领分片"。

四条必须记住的规则：

**(1) 首块带 `index` + `id` + `name` + 空 `arguments`；后续块通常只有 `index` + `arguments` 片段，没有 `id`。** 这是 Day 4 最容易翻车的地方——如果你在第一块之后用 `id` 做桶 key，第二块没有 id，会被丢进"未知名"桶，参数永远拼不完整。

**(2) 唯一正确的桶 key 是 `index`。** 不是 `id`，不是 `name`，不是数组下标（多个工具交错时数组下标会变）。上图的 `index: number`（无 `?`）就是这条规则的官方依据。

**(3) 多工具并行时碎片会交错到达。** 示意：

```
chunk: [{index:0, args:"..."}, {index:1, args:"..."}]
chunk: [{index:0, args:"..."}, {index:1, args:"..."}]
```

所以累积器必须是 `Map<index, {id, name, argsBuffer}>`，不是一个变量。

**(4) `arguments` 可能是空串。** 空串合法，不是错误，直接 append 即可（`""+x === x`），不要特判跳过——特判反而可能丢掉边界。

### 5.4 完整性判定：整套协议里最容易写错的一条

**【规范】** `finish_reason` 非空表示该 choice 生成结束，**其后不应再有该 choice 的 `delta`**——所以"参数会在 finish 之前发完"是有规范承诺的，别反过来讲成"规范没保证"。

但那是**对生成的承诺**，不是**对你本地已收全的承诺**，两件事必须拆开：

1. **`finish_reason` ≠ 流结束标志。** 【官方】usage-only chunk 在 `data: [DONE]` 之前到达，且 `choices` **恒为空数组**（见 §5.5），【实测】已在本网关观察到。结论：在 finish 处断连会丢 usage。
2. **它是否可能带 `tool_calls` 片段，本仓库没有证据。** 初版曾用"usage chunk 在 finish 之后到达"推出"之后还可能有 tool_calls 片段"，这是把"事件"当成不加区分的整体：usage chunk 的 `choices` 是空数组、不携带任何 delta，推不出该结论。没有观测到任何 late delta，也没有找到写"某些实现会这么做"的可靠来源。

所以完整性判据应写成**防御性选择**，而非"唯一合法"：

```
流已结束（收到 [DONE] 或连接正常关闭）
  AND
累积的 arguments 字符串 JSON.parse 成功
```

理由不是"已证明会有晚到片段"，而是三条：

- 无法验证每个网关都严格遵守"finish 后无 delta"；
- 早封口的错误代价高且静默（前缀 `{"city":"北"}` 本身就是合法 JSON，parse 不报错）；
- 晚封口只多等一个 `[DONE]`。

只满足第一个条件 → 参数可能被截断（`length`）。
只满足第二个条件 → 流可能还没完，parse 的只是前半段（而前半段有时恰好是合法 JSON，这就是最阴险的情况）。

这就补上了 3.5 留下的话题：`finish_reason === "tool_calls"` 只说明"模型停止生成、把控制权交给你"，与"参数完整"是两件事。

**【待验证】** 本网关是否会在 finish 之后补发**带 delta 的** chunk（usage-only chunk 已实测存在）。这一项决定"多等到 `[DONE]`"是纯保险还是必需。

### 5.5 流式下的 `usage`

**【官方】** 原文（`ChatCompletionStreamOptions.include_usage`）：

> If set, an additional chunk will be streamed before the `data: [DONE]` message. The `usage` field on this chunk shows the token usage statistics for the entire request, and the `choices` field will always be an empty array. All other chunks will also include a `usage` field, but with a null value. **NOTE:** If the stream is interrupted, you may not receive the final usage chunk.

```json
{ "stream": true, "stream_options": { "include_usage": true } }
```

四条可直接落成代码的结论：

1. usage chunk 在 `[DONE]`**之前**
2. 它 `choices: []`，所以解析代码必须先判空再读 `choices[0]`
3. **其余每个 chunk 都有 `usage` 字段，值为 `null`**——不是"没有这个字段"。所以判据是 `chunk.usage != null`，不是 `'usage' in chunk`
4. **流被中断就拿不到 usage**。这条最要命：`AbortController.abort()` 之后你连花了多少 token 都不知道，只能靠估算。W7 的"取消并落盘部分结果"必须接受这个事实

**【待验证】** 本网关是否支持 `stream_options`。如果不支持，流式请求就拿不到 token 数——那 W4 的预算器只能靠估算，这是个需要提前知道的限制。

---

## 6. 这个网关的偏差（vLLM 后端）

**【官方】** 对照过 `openai@7.45.0` 之后，"偏差"这一节才有底气。换网关后整段失效。

| 字段/行为 | 标准里有没有 | 本网关实测 | 影响 |
|---|---|---|---|
| `message.reasoning` | ❌ **【官方】确认不存在** | 有，独立字段 | 思维链不混进 content，好处理；但要单独计入成本 |
| `usage.prompt_tokens_details.created_cache_tokens` | ❌ 非标（标准叫 `cache_write_tokens`） | 有 | W5 缓存实验的核心指标 |
| `usage...multimodal_tokens` | ❌ 非标 | 恒 null | 忽略 |
| `choices[].stop_reason` / `token_ids` / `routed_experts` | ❌ 非标 | 恒 null | 忽略，不进类型 |
| `message.refusal` | ✅ 标准 | 恒 null | 类型里可以留，成本为零 |
| `message.annotations` / `audio` | ✅ 标准 | 恒 null | 同上 |
| `choices[].logprobs` | ✅ 标准（非流式必填，可为 null） | 恒 null | 同上 |
| `x-vllm-instance` 响应头 | ❌ 非标 | 有，值会变 | **必须记录**，否则缓存实验不可复现 |
| `x-ratelimit-*` 响应头 | ✅ 标准 | **完全没有** | 429 拿不到 `Retry-After`，退避策略要自己定 |
| `system_fingerprint` | ⚠️ 标准但 **【官方】已标 `@deprecated`** | `vllm-0.0.0-tp4-pp2-ep-...` | 仍可用来看后端是否换实例，但别指望长期存在 |

"`reasoning` 不是标准字段"这件事现在是**可证的**：`ChatCompletionMessage` 的 8 个字段里没有它，SDK 里 `reasoning` 只出现在两个地方——请求参数 `reasoning_effort` 和用量统计 `reasoning_tokens`。**模型把思维链原文吐回给你，是本网关独有的能力**，不是 OpenAI 协议的通用行为。

实测存在的响应头只有这些（`day1-chat-plain.json`）：

```
server, server-flag, req-arrive-time, req-cost-time, resp-start-time,
x-envoy-upstream-service-time, x-vllm-instance, content-type, transfer-encoding,
access-control-*, strict-transport-security, x-content-type-options, ...
```

其中 `req-arrive-time` / `req-cost-time` / `resp-start-time` 是网关自加的排队与耗时观测，**可用于区分"排队慢"和"生成慢"**——这是排查延迟问题的免费信息。

**这个网关的画像一句话：** OpenAI 兼容接口 + vLLM 私有字段 + 无任何限流头。所以照 OpenAI 文档写代码，会在三个地方踩空：`reasoning` 不认识、429 没有退避依据、缓存命中不稳定。

---

## 7. 坑清单（可直接抄进 checklist）

按"踩了会浪费半天"排序：

1. **用 `content` 判空来判断有没有工具调用** → content 是 null，永远判不中。判据是 `finish_reason === "tool_calls"`。
2. **`arguments` 当对象用** → 它是字符串，直接 `JSON.parse`，且要处理 parse 失败。
3. **流式工具调用用 `id` 分桶** → 后续分片没有 id。只能用 `index`。
4. **`finish_reason` 到了就执行工具** → 参数可能还没收完，或被 `length` 截断。
5. **用 `content.length` 估成本** → 漏掉 `reasoning_tokens`，低估 2~4 倍。
6. **只回 `role:"tool"` 不回带 `tool_calls` 的 assistant 消息** → 历史非法，模型看不懂上下文。
7. **`tool_call_id` 对不上** → 每个 tool_call 必须有且只有一条 tool 消息配对。
8. **直接 `response.choices[0]`** → 空数组时崩在远处。
9. **把工具定义当一次性开销** → 每轮都计费，289 tokens/工具/轮。
10. **拿 `[DONE]` 去 `JSON.parse`** → 抛异常，要特判。
11. **`buf.toString()` 拼流式文本** → UTF-8 多字节字符被 chunk 边界切断会出乱码。用 `TextDecoder({stream:true})`（Python 的 `aiter_text()` 已内置）。
12. **`created` 当毫秒用** → 它是秒。
13. **缓存实验不记 `x-vllm-instance`** → 数据不可复现。
14. **以为 429 有 `Retry-After`** → 本网关没有，只能指数退避 + 本地计数。
15. **解析 delta 时假设字段固定** → **【官方】** 默认会带 `obfuscation` 随机字段，写 `Object.keys(delta).length === 1` 这类判断必崩。只读你要的字段，忽略其余。
16. **用 `'usage' in chunk` 判断有没有 usage** → 流式下每个 chunk 都有 `usage` 字段，值为 `null`。判据是 `chunk.usage != null`。
17. **以为 `tools[].type` 只有 `"function"`** → **【官方】** 还有 `"custom"`（自由文本工具），响应侧对应 `custom.input` 而不是 `function.arguments`。写分派逻辑时要按 `type` 分支，别硬编码读 `function`。
18. **照抄文档里的 `tool_choice` 示例** → 文档把 Chat Completions 与 Responses 混着举例：Chat 是 `{"type":"function","function":{"name":"x"}}`，Responses 是 `{"type":"function","name":"x"}`。抄错形状直接 400。
19. **以为 `strict: true` 可以随便加** → OpenAI 侧每个对象必须 `additionalProperties: false`、全部字段必须进 `required`，否则 400；可选字段要用 `["string","null"]` 表达。本网关不校验这些元规则（P0-2 返回 200），不能指望它兜底。
20. **以为 guided decoding 保证 100% 合法** → `required` 指向不存在字段时，本网关返回 200 且输出缺该字段（devlog §12.3）；客户端校验仍不可省。
21. **把首次建连当成 schema 编译开销** → 进程内首次请求多出的 250–280ms 是 TCP/TLS；排除建连后，16k 字符 schema 的编译/缓存差约 20ms（devlog §12.6）。
22. **以为 `refusal` 会告诉你模型拒答** → 本网关恒 `null`；有 `json_schema` 时拒答意图会被 grammar 覆盖成合法任务 JSON（devlog §13.3）。
23. **`finish_reason:"length"` 还去 `JSON.parse`** → 输出是半截 JSON；先判 `finish_reason`（devlog §13.2）。

---

## 8. 样本索引

本文所有【实测】结论的出处：

| 文件 | 内容 | 支撑的结论 |
|---|---|---|
| `notes/samples/day1-models.json` | `GET /models` 原始响应 + 响应头 | 可用模型列表 |
| `notes/samples/day1-chat-plain.json` | 纯对话非流式 | 35 prompt tokens、91 reasoning tokens、无 tools 时的基线 |
| `notes/samples/day1-chat-toolcall.json` | 带 1 个工具的非流式 | 324 prompt tokens、`content:null`、`arguments` 字符串、`x-vllm-instance` |

代码对照：

| 文件 | 作用 |
|---|---|
| `mini-harness/ts/src/types.ts` | 协议类型，字段只来源于上述样本 |
| `mini-harness/ts/src/smoke.ts` | 非流式裸调 + A/B 计费实验 |
| `mini-harness/notes/devlog.md` | 每日过程与取舍 |

> ⚠️ 已知问题：`--save=` 用固定文件名，重跑会覆盖。`devlog.md` 里记的 tool_call `id`（`a2ef45...`）与 `reasoning_tokens`（15）和当前样本（`84e66557...`、14）**已经对不上了**，说明样本被后续运行覆盖过。要保住"样本可验证结论"这条，落盘文件名得带时间戳。

---

## 9. 官方规范核对记录（2026-10-27）

### 9.1 官网为什么抓不到

先给出结论：**不是我方法不对，是这台机器的 IP 被 Cloudflare 挡了。**

```bash
curl -sS https://platform.openai.com/robots.txt        # → 403
curl -sS https://platform.openai.com/docs/api-reference/chat/create | head -c 60
# → <title>Attention Required! | Cloudflare</title>
```

连 `robots.txt` 都 403，说明拦的是 IP/ASN 而不是某个页面；带完整浏览器头（`Sec-Fetch-*`、`Accept-Language`、真 UA）结果一样。

| 尝试 | 结果 |
|---|---|
| `platform.openai.com/docs/...` | 403（Cloudflare） |
| `developers.openai.com/api/reference/...` | 403 |
| `cookbook.openai.com/...` | 308 → `developers.openai.com/...` → **403** |
| `api.openai.com/v1/models` | 连接超时（无 key，网络层就不通） |
| `raw.githubusercontent.com/openai/openai-openapi/...` | 连接超时（本机不通 GitHub） |
| `r.jina.ai`（文本代理） | 连接超时 |
| **`registry.npmjs.org/openai`** | **200** |
| **`developers.openai.ac.cn`** | **200** |
| `model-spec.openai.com` / `status.openai.com` / `openai.github.io` | 200（说明是**针对性**封锁，不是全域断网） |

所以有两条可用通道，各补一半：

| 通道 | 给什么 | 可信度 |
|---|---|---|
| npm 官方 SDK `openai@7.45.0` | 字段的**必填/可选**、字面量联合、deprecated 标记 | 最高：OpenAPI 规范自动生成 |
| 文档镜像站 `developers.openai.ac.cn` | **散文说明**：为什么这么设计、限制与坑 | 次高：**该站自述与 OpenAI 无关联**，但逐条与 SDK 类型一致才采信 |

### 9.2 复现命令

```bash
mkdir -p .tmp-openai-spec && cd .tmp-openai-spec
V=$(curl -sS https://registry.npmjs.org/openai/latest | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')
curl -sSL "https://registry.npmjs.org/openai/-/openai-${V}.tgz" -o pkg.tgz
tar xzf pkg.tgz

# 请求参数
grep -n "export interface ChatCompletionCreateParamsBase" -A 120 package/resources/chat/completions/completions.d.ts
# 工具与工具调用
grep -n "export type ChatCompletionTool =" -A 2 package/resources/chat/completions/completions.d.ts
grep -n "interface ToolCall {" -A 12 package/resources/chat/completions/completions.d.ts
# 响应与用量
grep -n "export interface ChatCompletion {" -A 45 package/resources/chat/completions/completions.d.ts
grep -n "export interface CompletionUsage" -A 30 package/resources/completions.d.ts
```

本次核对版本：**`openai@7.45.0`**。包里的模型示例已出现 `gpt-6-astra`，文档域已迁到 `developers.openai.com`——说明这套接口在 2026 年仍是主推形态（`Responses API` 并行存在，但不是本文范围）。

### 9.3 diff：我原来写错的

| # | 我原来的说法 | 官方实际 | 严重度 |
|---|---|---|---|
| 1 | `tools[].type` 只有 `"function"` | 有 `function` 和 `custom` 两种，`custom` 用 `format` 约束自由文本 | **高**：按 `function` 硬编码分派会漏掉一类工具 |
| 2 | role 只有 4 种 | 实际 6 种参数类型，含 `developer`（system 的新位置）和 `function`（遗留） | 中 |
| 3 | `finish_reason` 4 个取值 | 5 个，多一个遗留值 `function_call` | 中 |
| 4 | `assistant.reasoning` 是"可选字段" | **标准里不存在该字段**，vLLM 独有 | 中：影响"能不能换网关"的判断 |
| 5 | `created_cache_tokens` 是"非标，无对应" | 标准有 `cache_write_tokens`，只是换了名字 | 低 |
| 6 | 没提 `delta.obfuscation` | 默认开启的防侧信道字段，每个 delta 都可能带 | 低但会崩解析器 |

落地情况：**第 3 条已修**——`types.ts` 的 `FinishReason` 补上 `"function_call"`（带"规范补入、未实测"注释）。
其余 5 条**只修文档不改代码**：1/2/4/6 都是本网关未出现过的分支，按"用到再加"处理；第 5 条属命名差异，等真做跨网关适配时再抽象。

这次改动也顺带修正了 `types.ts` 的头注释：原来写"字段全部来自真实响应"，现在改成**两级来源**——实测优先，规范补入必须逐字段注明来源与验证状态。否则补 `function_call` 这件事本身就会打破自己的规矩。

### 9.4 diff：官方给我背书的

这几条原来是"经验之谈"，现在是**类型系统保证**：

1. **`Delta.ToolCall.index: number` 是唯一必填字段**，`id` / `function` / `type` 全是可选。所以"必须用 index 分桶"不是技巧，是类型定义逼出来的唯一解——后续分片根本没有 `id`。
2. **`arguments: string`**，`content: string | null`，`finish_reason` 在非流式 Choice 上必填、在流式 delta 上可空。
3. **`stream_options.include_usage` 的语义**：多推一个 chunk 在 `[DONE]` 前，`choices` 恒为空数组，其余 chunk 的 `usage` 是 `null`（不是缺字段），流中断则收不到。
4. **`FunctionDefinition.name` 约束**：`a-z A-Z 0-9 _ -`，最长 64。

### 9.5 镜像渠道补到的散文事实

类型定义只能告诉我"有哪个字段"，说明不了"为什么"。镜像站补上了这一层，共 6 条（均已与 SDK 类型交叉核对）：

| 事实 | 出处 | 对本项目的用处 |
|---|---|---|
| `arguments` **不保证是合法 JSON**，可能幻觉出 schema 未定义的参数，调用前须校验 | 函数调用指南 | 把 3.3 的动因 2 从【推断】升为【文档】，W3 校验器的直接依据 |
| `strict: true` 要求**每个对象** `additionalProperties:false` + **所有字段**进 `required`；可选字段靠 `type: ["string","null"]` | 函数调用指南 | Day 5 必踩，写 schema 前先知道 |
| Chat Completions **不写 `strict` 默认非严格**；Responses 才会自动规范化 | 函数调用指南 | 不要以为加个 schema 就自动严格 |
| `allowed_tools` 存在的理由是**保住提示词缓存**（不改 `tools` 只改可见子集） | 函数调用指南 | 官方承认"工具列表抖动破坏缓存"，W5 可直接引用 |
| 建议每轮同时可用函数 **< 20 个**；工具多时用 `tool_search` 延迟加载 | 函数调用指南 | 与实测"1 工具 = 289 tokens/轮"互为佐证 |
| `custom` 工具的文法支持 `lark` 与 `regex`，采样由 LLGuidance 约束 | 函数调用指南 | 本项目用不到，但知道边界在哪 |

另外两条**会坑人的细节**：

- **微调模型 + 单会话多次调用 → 严格模式被自动禁用**。
- **`gpt-4.1-nano-2025-04-14` 在并行调用下可能对同一工具重复调用**，官方建议关掉 `parallel_tool_calls`。

### 9.6 仍未被验证的空缺

- 镜像站不是官方站（页脚自述"与 OpenAI, Inc. 无关联"），所以它的每一句都要能在 SDK 类型里找到锚点。`grammar` 的文法子集属于**无法被类型锚定**的部分，我标【文档】但不当结论用。
- 本网关对新字段（`custom`、`allowed_tools`、`stream_options`、`obfuscation`、`strict`）**一个都没测过**，全部【待验证】。

"待验证"不能只是四个字，得能被执行。逐个拆成可跑的判定：

| 待验证项 | 怎么验 | 判定"支持"的标准 | 归属 |
|---|---|---|---|
| `stream_options.include_usage` | 流式请求加该字段，把原始 chunk 全打出来 | `[DONE]` 前出现 `choices: []` 且带 `usage` 的 chunk | Day 4 |
| `obfuscation` | 同上，看每个 chunk 顶层有无 `obfuscation` | 有则该网关也开了防侧信道；没有则解析器可省一条"忽略未知字段"的兜底 | Day 4 |
| `strict: true` | 带 `strict` 的工具 + 故意缺失 `additionalProperties` | 400 且错误信息点名缺哪条约束，才算"真支持" | **已验（Day 5 + P0）**：入口两侧都不校验元规则（A3/A4、P0-2 均 200）；tools 开 strict 后 `minimum` 生效（P0-1 输出 200） |
| `response_format: json_schema` | 嵌套对象 + enum 的 schema | 返回体可直接 `JSON.parse` 且符合 schema | **已验（A1/P1）**：通过；16k 字符 schema 仍只占 75 `prompt_tokens`；语法死路 400，但 `required` 指向不存在字段时会静默弱化（devlog §12） |
| `custom` 工具 | `type:"custom"` + `format:{type:"text"}` | 响应 `tool_calls[].custom.input` 是纯文本，或明确 400 | Day 5（顺带） |
| `tool_choice.allowed_tools` | 传两个工具、只允许一个 | 模型不会调用被排除的那个；若报 400 则记"不支持" | Day 5（顺带） |
| `grammar` 子集 | 不在本仓库验证范围内 | — | 不排期 |

表里最值得先做的是 `stream_options`：它决定 W4 的 token 预算器**能不能拿到真实用量**。拿不到就只能估算，整个预算体系要换设计。

- 结论：**协议形状可以照 SDK 抄，设计动机可以照文档抄，行为必须照本网关实测写。** 这三件事永远不能混。

---

## 10. 一句话总结

> OpenAI 工具协议的设计核心是**把"结构化调用"降级成"一段可以流式传输的字符串"**：请求侧用 JSON Schema 描述意图，响应侧用字符串承载参数，用 `finish_reason` 标记控制权转移，用 `tool_call_id` 把结果接回历史。
>
> 理解这个降级，就能自己推出全部工程约束：为什么要按 `index` 分桶、为什么要等流结束才 parse、为什么 `length` 时绝不能执行工具。
>
> 而这个网关的非标字段（`reasoning`、`created_cache_tokens`、`x-vllm-instance`）提醒另一件事：**"OpenAI 兼容"只保证接口形状，不保证行为**。协议要照文档写，成本与缓存要照实测写。
