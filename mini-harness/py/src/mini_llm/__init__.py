"""mini_llm：手写 LLM 协议层，不依赖任何官方 SDK。

与 ts/src 一一对应：
    types.py  ↔ types.ts
    sse.py    ↔ sse.ts
    stream.py ↔ stream.ts
"""

from .sse import SSEEndReport, SSEEvent, SSEParser, create_sse_parser, is_done_event
from .stream import TextChunk, aiter_sse_events, stream_chat_completion

__all__ = [
    "SSEEndReport",
    "SSEEvent",
    "SSEParser",
    "TextChunk",
    "aiter_sse_events",
    "create_sse_parser",
    "is_done_event",
    "stream_chat_completion",
]
