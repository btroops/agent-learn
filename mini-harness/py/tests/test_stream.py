"""与 ts/src/stream.test.ts 对应：手工构造字节流喂给 httpx，不发网络请求。

这里刻意走 httpx 的真实解码路径（aiter_text → codecs 增量解码器），
因为 Python 侧"UTF-8 边界"这件事不是我们写的代码，而是 httpx 的保证 ——
把它测出来，才能在笔记里写"已实测"而不是"文档说它行"。
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from mini_llm.sse import SSEEvent
from mini_llm.stream import SSEStreamTruncated, aiter_sse_events, stream_chat_completion


class _ByteStream(httpx.AsyncByteStream):
    """按给定字节块顺序产出，模拟 TCP 分片。"""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):  # type: ignore[override]
        for chunk in self._chunks:
            yield chunk


def _collect(chunks: list[bytes]) -> list[SSEEvent]:
    async def run() -> list[SSEEvent]:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                stream=_ByteStream(chunks),
                headers={"content-type": "text/event-stream"},
            )

        collected: list[SSEEvent] = []
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with client.stream("POST", "https://example.invalid/chat/completions") as response:
                async for event in aiter_sse_events(response.aiter_text()):
                    collected.append(event)
        return collected

    return asyncio.run(run())


def test_utf8_boundary_holds_partial_multibyte_char() -> None:
    payload = 'data: {"c":"北京😀"}\n\n'.encode()
    cut = len('data: {"c":"北'.encode()) + 1  # 切在"京"三字节序列中间
    assert cut < len(payload)

    events = _collect([payload[:cut], payload[cut:]])
    assert len(events) == 1
    assert json.loads(events[0].data)["c"] == "北京😀", "aiter_text 必须扣住半个字符"


def test_done_stops_consuming() -> None:
    events = _collect(
        [
            'data: {"i":0}\n\ndata: {"i":1}\n\ndata: [DONE]\n\n'.encode(),
            "data: 这之后的数据不应再被消费\n\n".encode(),
        ]
    )
    assert len(events) == 3
    assert events[2].data == "[DONE]"


def test_truncated_stream_raises_without_emitting() -> None:
    emitted: list[SSEEvent] = []

    async def run() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=_ByteStream(['data: {"a":1}\n'.encode()]))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            async with client.stream("POST", "https://example.invalid/chat/completions") as response:
                async for event in aiter_sse_events(response.aiter_text()):
                    emitted.append(event)

    with pytest.raises(SSEStreamTruncated):
        asyncio.run(run())

    assert emitted == [], "截断时一个事件都不该交出去"


def test_stream_chat_completion_skips_done_marker() -> None:
    """回归：最初 aiter_sse_events 会把 [DONE] 交给 json.loads，真实请求才暴露。"""
    payload = (
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",'
        '"choices":[{"index":0,"delta":{"content":"你"},"logprobs":null,"finish_reason":null}]}\n\n'
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",'
        '"choices":[{"index":0,"delta":{"content":"好"},"logprobs":null,"finish_reason":null}]}\n\n'
        "data: [DONE]\n\n"
    ).encode()

    async def run() -> list[dict]:
        transport = httpx.MockTransport(
            lambda request: httpx.Response(200, stream=_ByteStream([payload]))
        )
        async with httpx.AsyncClient(transport=transport) as client:
            return [
                chunk
                async for chunk in stream_chat_completion(
                    {"model": "m", "messages": [{"role": "user", "content": "hi"}]},
                    base_url="https://example.invalid/v1",
                    api_key="test-key",
                    client=client,
                )
            ]

    chunks = asyncio.run(run())
    assert len(chunks) == 2, "[DONE] 不能被当成一个 chunk 吐出来"
    assert "".join(c["choices"][0]["delta"]["content"] for c in chunks) == "你好"
