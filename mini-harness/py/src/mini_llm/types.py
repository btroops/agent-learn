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


class StreamDelta(TypedDict, total=False):
    # 首块就带 role，且 content 为空串
    role: Literal["assistant"]
    content: str
    # 非标准（vLLM）：思维链与正文分开推
    reasoning: str
    # tool_calls 的增量形状 Day4 实测后补，此处不凭记忆写


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
