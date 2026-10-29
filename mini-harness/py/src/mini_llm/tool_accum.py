"""增量 tool_calls 拼接，与 ts/src/tool-accum.ts 逐条对应。

实测形状（notes/samples/day4-toolcalls-raw.sse）：
    首块 {index:0, id:"chatcmpl-tool-...", type:"function", function:{name:"get_weather"}}
    后续 {index:0, function:{arguments:"{\\"city\\": \\""}}    ← id / name / type 全部缺席

三条铁律：
1. 只用 index 分桶。id 只在首块出现，后续分片的 id 是 None，而 None 在 dict 里是稳定键：
   会把这些片段全并进同一个桶、互相拼接（不是"丢掉"，是"串味"）。
2. 拼接期间绝不 json.loads。判定"完整"的唯一标准是：流已结束 + 解析成功。
3. finish_reason 到达不代表参数收完：规范上其后不应再有该 choice 的 delta，但非官方网关
   是否遵守不可验证，因此封口一律推迟到"流真正结束"。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .types import ToolCallDelta


@dataclass
class ToolCallDraft:
    index: int
    id: str | None = None
    name: str | None = None
    arguments_text: str = ""
    fragments: int = 0


@dataclass(frozen=True)
class AssembledToolCall:
    index: int
    id: str
    name: str
    arguments_text: str
    arguments: Any


@dataclass(frozen=True)
class BrokenToolCall:
    index: int
    id: str | None
    name: str | None
    arguments_text: str
    reason: str


@dataclass(frozen=True)
class AssembleResult:
    #: 按 index 升序 = 模型源顺序（工程选择：可复现、便于回填；协议靠 tool_call_id 配对，不要求顺序）
    calls: list[AssembledToolCall] = field(default_factory=list)
    #: 不能执行的调用，调用方应据此回填 isError 结果，而不是抛异常中断整轮
    broken: list[BrokenToolCall] = field(default_factory=list)


class ToolCallAccumulator:
    def __init__(self) -> None:
        self._buckets: dict[int, ToolCallDraft] = {}
        self._sealed = False

    def push(self, deltas: list[ToolCallDelta] | None) -> None:
        """喂一个 delta.tool_calls 数组；缺 index 无法分桶，直接失败而不是猜。"""
        if self._sealed:
            raise RuntimeError("累积器已封口（finish() 之后又收到 tool_calls 片段）：调用方在流结束后仍喂数据，或 finish() 早于流结束")
        if not deltas:
            return

        for delta in deltas:
            index = delta.get("index")
            if not isinstance(index, int):
                raise ValueError(f"tool_call 分片缺少 index，无法分桶：{delta!r}")

            draft = self._buckets.get(index)
            if draft is None:
                draft = ToolCallDraft(index=index)
                self._buckets[index] = draft

            if "id" in delta:
                draft.id = delta["id"]
            function = delta.get("function") or {}
            if "name" in function:
                draft.name = function["name"]

            # 首块实测没有 arguments 字段，也有实现给空串。两者都当"本片无内容"，但都要计一片。
            fragment = function.get("arguments")
            if isinstance(fragment, str):
                draft.arguments_text += fragment
            draft.fragments += 1

    @property
    def size(self) -> int:
        return len(self._buckets)

    def snapshot(self) -> list[ToolCallDraft]:
        """当前各桶快照，按 index 升序。"""
        return [
            ToolCallDraft(
                index=d.index,
                id=d.id,
                name=d.name,
                arguments_text=d.arguments_text,
                fragments=d.fragments,
            )
            for d in sorted(self._buckets.values(), key=lambda x: x.index)
        ]

    def finish(self) -> AssembleResult:
        """封口并解析。**只能在流真正结束后调用**。封口后再 push 会抛错。"""
        self._sealed = True
        calls: list[AssembledToolCall] = []
        broken: list[BrokenToolCall] = []

        for draft in self.snapshot():
            missing = self._describe_missing(draft)
            if missing is not None:
                broken.append(
                    BrokenToolCall(
                        index=draft.index,
                        id=draft.id,
                        name=draft.name,
                        arguments_text=draft.arguments_text,
                        reason=missing,
                    )
                )
                continue

            try:
                # 没有参数的工具，模型可能一个字符都不发："" 视为 {}
                parsed = {} if draft.arguments_text == "" else json.loads(draft.arguments_text)
                calls.append(
                    AssembledToolCall(
                        index=draft.index,
                        id=draft.id,  # type: ignore[arg-type]
                        name=draft.name,  # type: ignore[arg-type]
                        arguments_text=draft.arguments_text,
                        arguments=parsed,
                    )
                )
            except json.JSONDecodeError as exc:
                broken.append(
                    BrokenToolCall(
                        index=draft.index,
                        id=draft.id,
                        name=draft.name,
                        arguments_text=draft.arguments_text,
                        reason=f"arguments 不是合法 JSON（可能被截断）：{exc}",
                    )
                )

        return AssembleResult(calls=calls, broken=broken)

    @staticmethod
    def _describe_missing(draft: ToolCallDraft) -> str | None:
        if draft.id is None:
            return "缺少 id：无法与 tool 结果配对（若分桶用了 id 而不是 index，这里必然为空）"
        if draft.name is None:
            return "缺少 function.name：不知道该执行哪个工具"
        return None
