/**
 * OpenAI 兼容协议类型。
 *
 * 铁律（2026-10-27 修订）：
 * 1. 首选来源是对该网关（vLLM 后端）的真实响应，不凭记忆补全。
 * 2. 次选来源是官方 SDK 类型定义（openai@7.45.0，由 OpenAPI 规范生成）。
 *    凡从规范补入、本网关未实测的字段，必须在该字段注释里写明"规范补入 + 未实测"，
 *    否则视为违规——这条是为了让"看起来支持"的字段无法悄悄混进来。
 * 3. 只出现过 null 的字段仍不纳入类型。
 */

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * 实测 stop 与 tool_calls；length 需刻意构造 max_tokens 才能触发（Day4 验证）。
 *
 * function_call：规范补入，本网关未实测。来源 openai@7.45.0 的 ChatCompletion.Choice.finish_reason
 * 联合类型全集。属遗留字段，配套 ChatCompletionMessage.function_call（已被 tool_calls 取代）。
 * 补它的理由：让 switch 穷尽检查能暴露"未处理的停止原因"，而不是把它当成不可能发生。
 */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

// ---------- 工具定义（请求侧） ----------

export interface FunctionDefinition {
  name: string;
  description?: string;
  /** JSON Schema 对象 */
  parameters?: Record<string, unknown>;
  /** strict 模式是否被该网关接受，Day5 验证 */
  strict?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: FunctionDefinition;
}

// ---------- 结构化输出（请求侧） ----------

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

// ---------- 消息 ----------

export interface FunctionCall {
  name: string;
  /**
   * 非流式：一条完整 JSON 字符串。
   * 流式：会被切成多个分片且可能交错，必须按 index 分桶累积后再 parse，见 tool-accum.ts
   */
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface Message {
  role: Role;
  /** 实测：带 tool_calls 的 assistant 消息里 content 为 null，不要用 content 判断"有没有结果" */
  content: string | null;
  /** 仅 assistant 侧；下一轮请求原样回传 */
  tool_calls?: ToolCall[];
  /** 仅 role="tool"，指向被回应的 ToolCall.id */
  tool_call_id?: string;
  /**
   * 非标准（vLLM）：思维链独立成字段，不混进 content。
   * 实测一次 36 prompt tokens 的提问产生 77 reasoning_tokens，必须计入成本。
   */
  reasoning?: string | null;
}

// ---------- 用量 ----------

export interface PromptTokensDetails {
  cached_tokens: number;
  /** 非标准（vLLM）：本次写入前缀缓存的 token 数，W5 做 prefix cache 时是核心指标 */
  created_cache_tokens: number;
  /** 非流式响应里有这个 null 字段，流式 usage 里干脆不出现 —— 必须 optional */
  multimodal_tokens?: null;
}

export interface CompletionTokensDetails {
  reasoning_tokens: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: PromptTokensDetails;
  completion_tokens_details: CompletionTokensDetails;
}

// ---------- 响应 ----------

export interface ChatChoice {
  index: number;
  message: Message;
  finish_reason: FinishReason;
  /** 实测恒为 null：logprobs 未开 */
  logprobs: null;
  /** 非标准（vLLM）：stop_reason / token_ids / routed_experts 实测均为 null */
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  /** 实测形如 "vllm-0.0.0-tp4-pp2-ep-8d310e51"，可据此判断后端是否换实例 */
  system_fingerprint: string;
  usage: Usage;
  service_tier: null;
  /**
   * 实测存在的其余字段均为 null，不纳入类型：
   * prompt_logprobs / prompt_token_ids / prompt_text / kv_transfer_params / ec_transfer_params / metrics
   */
}

// ---------- 流式（Day 2 实测） ----------

/**
 * 流式 tool_calls 的一个分片（Day 4 实测形状）。
 *
 * 实测证据（samples/day4-toolcalls-raw.sse）：
 *   首块: { index:0, id:"chatcmpl-tool-...", type:"function", function:{ name:"get_weather" } }  ← 没有 arguments 字段
 *   后续: { index:0, function:{ arguments:"{\"city\": \"" } }                                     ← 只有 index + arguments
 *
 * 所以除 index 外全部 optional，且用 index 分桶（id 只在首块出现，用它做 key 会丢掉后续全部片段）。
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    /** 片段，可能为空串；拼接完成前绝不能 JSON.parse */
    arguments?: string;
  };
}

export interface StreamDelta {
  /** 首块就带 role，且 content 为空串 —— 实测如此，不是理论情况 */
  role?: "assistant";
  /** 增量文本，可能是空串 */
  content?: string;
  /** 非标准（vLLM）：思维链与正文分开推，与 content 交错到达 */
  reasoning?: string;
  /** 多工具并行时片段可能交错到达，见 tool-accum.ts */
  tool_calls?: ToolCallDelta[];
}

export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  logprobs: null;
  /** 与 delta.content 可能出现在同一个 chunk 里，实测如此 */
  finish_reason: FinishReason | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  /** usage-only chunk 的 choices 是空数组：任何 `choices[0].xxx` 都必须先判空 */
  choices: StreamChoice[];
  /** 只在 stream_options.include_usage=true 时出现，且出现在 finish_reason 之后 */
  usage?: Usage;
  system_fingerprint?: string;
}

// ---------- 请求 ----------

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
}
