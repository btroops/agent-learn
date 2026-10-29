"""流式消费层：httpx.AsyncClient.stream() → aiter_text() → SSEParser → JSON chunk。

与 ts/src/stream.ts 对应，但有一处**关键差异**：
    TS 侧必须自己 `new TextDecoder("utf-8")` 并用 `decode(value, {stream: true})`；
    Python 侧 `response.aiter_text()` 内部就是 `codecs.getincrementaldecoder("utf-8")`，
    跨 chunk 的半个多字节字符由 httpx 扣住，我们拿到的已经是完整字符串。

运行（在 mini-harness/py 下）：
    set -a; . ../.env; set +a
    python -m mini_llm.stream --usage --raw-save=../notes/samples/day3-py-raw
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import httpx

from .sse import SSEParser, SSEEvent, is_done_event


class SSEStreamTruncated(RuntimeError):
    """流在事件中途结束：没收到 [DONE]，且解析器里还有残留。"""


@dataclass(frozen=True)
class TextChunk:
    """aiter_text() 吐出的一个文本分片。

    注意：这里没有"网络字节数"。字节在 aiter_text() 内部就被解码掉了，
    bytes_ 是重新编码的结果，只有在分片没有切断多字节字符时才等于网络字节数。
    TS 侧因为自己持有 Uint8Array，记录的是真实字节数 —— 对比时要用 chars 而不是 bytes。
    """

    index: int
    chars: int
    bytes_: int
    offset_ms: int
    text: str


async def aiter_sse_events(chunks: AsyncIterator[str]) -> AsyncIterator[SSEEvent]:
    """把文本分片流读成 SSE 事件。会 yield 包含 [DONE] 在内的事件。"""
    parser = SSEParser()
    async for text in chunks:
        for event in parser.push(text):
            yield event
            if is_done_event(event):
                return

    # 没收到 [DONE]：要么正常关闭，要么中途断连
    report = parser.end()
    if report.leftover_line or report.pending_data:
        raise SSEStreamTruncated(
            f"SSE 流被截断（未收到 [DONE]）：leftover_line={report.leftover_line!r} "
            f"pending_data={report.pending_data!r}"
        )


async def stream_chat_completion(
    request_body: dict[str, Any],
    *,
    base_url: str,
    api_key: str,
    include_usage: bool = False,
    timeout: float = 120.0,
    on_text_chunk: Callable[[TextChunk], None] | None = None,
    client: httpx.AsyncClient | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """发一次流式请求，逐块 yield 解析后的 JSON。

    client 可注入：单测用 httpx.MockTransport 构造，不必打网络。
    """
    url = f"{base_url.rstrip('/')}/chat/completions"
    body: dict[str, Any] = {**request_body, "stream": True}
    if include_usage:
        body["stream_options"] = {"include_usage": True}

    headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "authorization": f"Bearer {api_key}",
    }

    if client is not None:
        async for chunk in _stream_with(client, url, body, headers, on_text_chunk):
            yield chunk
        return

    async with httpx.AsyncClient(timeout=timeout) as owned:
        async for chunk in _stream_with(owned, url, body, headers, on_text_chunk):
            yield chunk


async def _stream_with(
    client: httpx.AsyncClient,
    url: str,
    body: dict[str, Any],
    headers: dict[str, str],
    on_text_chunk: Callable[[TextChunk], None] | None,
) -> AsyncIterator[dict[str, Any]]:
    started = time.monotonic()
    async with client.stream("POST", url, json=body, headers=headers) as response:
        if response.status_code >= 400:
            raw = (await response.aread()).decode("utf-8", "replace")
            raise httpx.HTTPStatusError(
                f"HTTP {response.status_code}: {raw[:800]}",
                request=response.request,
                response=response,
            )

        index = 0

        async def recording() -> AsyncIterator[str]:
            nonlocal index
            async for text in response.aiter_text():
                if on_text_chunk is not None:
                    on_text_chunk(
                        TextChunk(
                            index=index,
                            chars=len(text),
                            bytes_=len(text.encode("utf-8")),
                            offset_ms=int((time.monotonic() - started) * 1000),
                            text=text,
                        )
                    )
                index += 1
                yield text

        async for event in aiter_sse_events(recording()):
            # 与 TS 侧 streamChatCompletion 对齐：[DONE] 是终止哨兵，不进 JSON 解析
            if is_done_event(event):
                return
            # 绝不静默跳过：吞掉一块等于让模型少说半句话而无人知情
            try:
                yield json.loads(event.data)
            except json.JSONDecodeError as exc:
                raise ValueError(f"SSE data 不是 JSON：{event.data[:300]}") from exc


# ---------- CLI：接真实接口，流式打印 ----------


async def _main() -> None:
    base_url = os.environ.get("LLM_BASE_URL")
    api_key = os.environ.get("LLM_API_KEY")
    model = os.environ.get("LLM_MODEL")
    if not base_url or not api_key or not model:
        raise SystemExit("缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（先 set -a; . ../.env; set +a）")

    import sys

    args = sys.argv[1:]
    include_usage = "--usage" in args
    prompt = _arg(args, "--prompt=") or "用两句话说明什么是 SSE，并带一个 emoji。"
    save_target = _arg(args, "--save=")
    raw_save_target = _arg(args, "--raw-save=")

    print(f"模型 {model} / usage chunk: {include_usage}")
    print(f"prompt: {prompt}")

    started = time.monotonic()
    chunks: list[dict[str, Any]] = []
    text_chunks: list[TextChunk] = []
    delta_keys: set[str] = set()
    finish_reasons: list[str] = []
    usage: dict[str, Any] | None = None
    first = True

    request_started_epoch_ms = int(time.time() * 1000)

    async for chunk in stream_chat_completion(
        {"model": model, "messages": [{"role": "user", "content": prompt}]},
        base_url=base_url,
        api_key=api_key,
        include_usage=include_usage,
        on_text_chunk=text_chunks.append if raw_save_target else None,
    ):
        chunks.append(chunk)

        if first:
            print("\n=== 首块原样（据此确定 delta 形状）===")
            print(json.dumps(chunk, ensure_ascii=False, indent=2))
            first = False

        if "error" in chunk:
            print(f"\n[流中出现 error 事件，但连接是 200] {json.dumps(chunk['error'], ensure_ascii=False)}")

        # usage-only chunk 的 choices 是空数组，必须判空
        if chunk.get("choices"):
            choice = chunk["choices"][0]
            delta = choice.get("delta") or {}
            delta_keys.update(delta.keys())
            content = delta.get("content")
            if content:
                print(content, end="", flush=True)
            if choice.get("finish_reason"):
                finish_reasons.append(choice["finish_reason"])
                print(f"\n[finish_reason chunk 原样] {json.dumps(chunk, ensure_ascii=False)}")
        if chunk.get("usage"):
            usage = chunk["usage"]
            print(f"\n[usage chunk 原样] {json.dumps(chunk, ensure_ascii=False)}")

    elapsed_ms = int((time.monotonic() - started) * 1000)
    print("\n\n=== 汇总 ===")
    print("chunk 数:", len(chunks))
    print("delta 出现过的键:", sorted(delta_keys))
    print("finish_reason:", finish_reasons)
    print("usage:", json.dumps(usage, ensure_ascii=False) if usage else "流中未返回 usage（试 --usage）")
    print("耗时:", f"{elapsed_ms}ms")

    if save_target:
        path = Path(save_target)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "capturedAt": _now_iso(),
                    "endpoint": _redact(f"{base_url.rstrip('/')}/chat/completions"),
                    "model": model,
                    "includeUsage": include_usage,
                    "chunks": chunks,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"已落盘: {save_target}")

    if raw_save_target:
        path = Path(raw_save_target)
        path.parent.mkdir(parents=True, exist_ok=True)

        raw_text = "".join(c.text for c in text_chunks)
        raw_path = Path(f"{raw_save_target}.sse")
        raw_path.write_bytes(raw_text.encode("utf-8"))

        total_bytes = sum(c.bytes_ for c in text_chunks)
        chunks_path = Path(f"{raw_save_target}.chunks.json")
        chunks_path.write_text(
            json.dumps(
                {
                    "capturedAt": _now_iso(),
                    "endpoint": _redact(f"{base_url.rstrip('/')}/chat/completions"),
                    "model": model,
                    "includeUsage": include_usage,
                    "requestBody": {"model": model, "messages": [{"role": "user", "content": prompt}]},
                    "summary": {
                        "textChunkCount": len(text_chunks),
                        "totalReencodedBytes": total_bytes,
                        "endsWithDone": "data: [DONE]" in raw_text,
                        "firstChunkOffsetMs": text_chunks[0].offset_ms if text_chunks else None,
                        "lastChunkOffsetMs": text_chunks[-1].offset_ms if text_chunks else None,
                        "note": "bytes 为 aiter_text 之后重新编码的结果，不是网络字节数",
                        "requestStartedEpochMs": request_started_epoch_ms,
                    },
                    "textChunks": [
                        {
                            "index": c.index,
                            "chars": c.chars,
                            "bytes": c.bytes_,
                            "offsetMs": c.offset_ms,
                            "text": c.text,
                        }
                        for c in text_chunks
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"已落盘原始流: {raw_path}（{total_bytes} 字节，{len(text_chunks)} 个文本分片）")
        print(f"已落盘分片边界: {chunks_path}")


def _arg(args: list[str], prefix: str) -> str | None:
    for a in args:
        if a.startswith(prefix):
            return a[len(prefix) :]
    return None


def _redact(url: str) -> str:
    import re

    return re.sub(r"/s/u/[^/]+/", "/s/u/***/", url)


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    asyncio.run(_main())
