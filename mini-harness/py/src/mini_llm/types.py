"""OpenAI 兼容协议类型，与 ts/src/types.ts 一一对应。

字段口径完全相同：只写实测出现过的字段。
用 TypedDict 而不是 pydantic：这里是"读懂协议"，不是"校验外部输入"；
W3 做工具参数校验时才会引入 pydantic。
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, Required, TypedDict

Role = Literal["system", "user", "assistant", "tool"]
FinishReason = Literal["stop", "length", "tool_calls", "content_filter"]


class FunctionDefinition(TypedDict, total=False):
    name: Required[str]
    description: str
    parameters: dict[str, Any]
    strict: bool


class ToolDefinition(TypedDict):
    type: Literal["function"]
    function: FunctionDefinition


class FunctionCall(TypedDict):
    name: str
    # 非流式：一条完整 JSON 字符串；流式：会被切成多段且可能交错
    arguments: str


class ToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: FunctionCall


class Message(TypedDict):
    role: Role
    # 实测：带 tool_calls 的 assistant 消息里 content 为 None
    content: str | None
    tool_calls: NotRequired[list[ToolCall]]
    tool_call_id: NotRequired[str]
    # 非标准（vLLM）：思维链独立成字段，不混进 content
    reasoning: NotRequired[str | None]


class PromptTokensDetails(TypedDict):
    cached_tokens: int
    # 非标准（vLLM）：本次写入前缀缓存的 token 数
    created_cache_tokens: int
    # 非流式有、流式没有，必须 optional
    multimodal_tokens: NotRequired[None]


class CompletionTokensDetails(TypedDict):
    reasoning_tokens: int


class Usage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    prompt_tokens_details: PromptTokensDetails
    completion_tokens_details: CompletionTokensDetails


class ChatChoice(TypedDict):
    index: int
    message: Message
    finish_reason: FinishReason
    logprobs: None


class ChatResponse(TypedDict):
    id: str
    object: Literal["chat.completion"]
    created: int
    model: str
    choices: list[ChatChoice]
    system_fingerprint: str
    usage: Usage
    service_tier: None


class ToolCallFunctionDelta(TypedDict, total=False):
    name: str
    # 片段，可能缺失或为空串；拼接完成前绝不能 json.loads
    arguments: str


class ToolCallDelta(TypedDict):
    """流式 tool_calls 的一个分片（Day 4 实测形状）。

    首块: {index:0, id:"chatcmpl-tool-...", type:"function", function:{name:"get_weather"}}
    后续: {index:0, function:{arguments:"{\\"city\\": \\""}}
    除 index 外全部 optional，且必须用 index 分桶。
    """

    index: int
    id: NotRequired[str]
    type: NotRequired[Literal["function"]]
    function: NotRequired[ToolCallFunctionDelta]


class StreamDelta(TypedDict, total=False):
    # 首块就带 role，且 content 为空串
    role: Literal["assistant"]
    content: str
    # 非标准（vLLM）：思维链与正文分开推
    reasoning: str
    # 多工具并行时片段可能交错到达，见 tool_accum.py
    tool_calls: list[ToolCallDelta]


class StreamChoice(TypedDict):
    index: int
    delta: StreamDelta
    logprobs: None
    finish_reason: FinishReason | None


class ChatCompletionChunk(TypedDict):
    id: str
    object: Literal["chat.completion.chunk"]
    created: int
    model: str
    # usage-only chunk 的 choices 是空数组，取 [0] 前必须判空
    choices: list[StreamChoice]
    # 只在 stream_options.include_usage=true 时出现，且在 finish_reason 之后
    usage: NotRequired[Usage]
    system_fingerprint: NotRequired[str]


class ChatRequest(TypedDict, total=False):
    model: Required[str]
    messages: Required[list[Message]]
    stream: bool
    tools: list[ToolDefinition]
    tool_choice: str | dict[str, Any]
    response_format: dict[str, Any]
