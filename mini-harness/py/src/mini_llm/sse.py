"""不依赖任何库的 SSE 解析器，与 ts/src/sse.ts 逐行对应。

输入是**已解码的文本**；字节到文本的解码由 httpx 的 aiter_text() 负责（见 stream.py）。
所有完整事件都在遇到空行时才吐出，因此天然不会产生半截事件。

规范要点（WHATWG SSE）：
- 行分隔符三种都要支持：\\r\\n、\\n、\\r
- data 可多行，拼接用 \\n
- data 缓冲为空时不派发事件
- ':' 开头是注释（keep-alive），整行丢弃
- 流结束时未以空行收尾的事件按规范丢弃，但要把残留交回调用方
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_LINE_SPLIT = re.compile(r"\r\n|\n|\r")


@dataclass(frozen=True)
class SSEEvent:
    """一个完整事件。event 缺省为 'message'。"""

    event: str
    data: str
    id: str | None = None


@dataclass(frozen=True)
class SSEEndReport:
    """end() 的结果：两者任一非空，说明流是被截断的。"""

    leftover_line: str
    pending_data: str


class SSEParser:
    def __init__(self) -> None:
        self._buffer = ""
        self._data = ""
        self._event_name = "message"
        self._last_id: str | None = None

    def push(self, chunk: str) -> list[SSEEvent]:
        """喂入一个 chunk，返回本次能凑出的完整事件（可能是 0 个或多个）。"""
        if not chunk:
            return []
        self._buffer += chunk

        # 结尾若是孤立的 \r，必须先扣住：它可能是被切开的 \r\n 的前半
        hold = 1 if self._buffer.endswith("\r") else 0
        scannable = self._buffer[: len(self._buffer) - hold] if hold else self._buffer
        lines = _LINE_SPLIT.split(scannable)
        # split 的最后一段是不完整的行，留到下次
        self._buffer = lines.pop() + self._buffer[len(scannable) :]

        events: list[SSEEvent] = []
        for line in lines:
            event = self._consume_line(line)
            if event is not None:
                events.append(event)
        return events

    def end(self) -> SSEEndReport:
        """流结束调用一次：返回被丢弃的残留，用于识别"断连 vs 正常结束"。"""
        report = SSEEndReport(leftover_line=self._buffer, pending_data=self._data)
        self._buffer = ""
        self._data = ""
        self._event_name = "message"
        self._last_id = None
        return report

    def _consume_line(self, line: str) -> SSEEvent | None:
        if line == "":
            return self._dispatch()

        # 注释行：服务端常拿它做 keep-alive
        if line.startswith(":"):
            return None

        colon = line.find(":")
        field = line if colon == -1 else line[:colon]
        value = "" if colon == -1 else line[colon + 1 :]
        # 只剥掉一个前导空格：'data:  x' 的值是 ' x'
        if value.startswith(" "):
            value = value[1:]

        if field == "data":
            # 规范：缓冲为空则直接赋值，否则用 \n 追加
            self._data = value if self._data == "" else f"{self._data}\n{value}"
        elif field == "event":
            self._event_name = value if value else "message"
        elif field == "id":
            if "\0" not in value:
                self._last_id = value
        # retry 等字段本仓库用不到，忽略而不是报错
        return None

    def _dispatch(self) -> SSEEvent | None:
        # 规范：data 缓冲为空则不派发，孤立的 'data:' 行什么也不产生
        if self._data == "":
            self._event_name = "message"
            return None
        event = SSEEvent(event=self._event_name, data=self._data, id=self._last_id)
        self._data = ""
        self._event_name = "message"
        return event


def create_sse_parser() -> SSEParser:
    return SSEParser()


def is_done_event(event: SSEEvent) -> bool:
    """'[DONE]' 是 OpenAI 约定的终止哨兵，属于 data 负载而非控制行。"""
    return event.data == "[DONE]"
