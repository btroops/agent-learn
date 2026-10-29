"""与 ts/src/tool-accum.test.ts 逐条对应。"""

from __future__ import annotations

import pytest

from mini_llm.tool_accum import ToolCallAccumulator
from mini_llm.types import ToolCallDelta


def frag(index: int, args: str | None = None, head: tuple[str, str] | None = None) -> ToolCallDelta:
    """构造分片：args 传 None 表示"本片没有 arguments 字段"（真实首块就是这样）。"""
    delta: ToolCallDelta = {"index": index}
    function: dict[str, str] = {}
    if head is not None:
        delta["id"] = head[0]
        delta["type"] = "function"
        function["name"] = head[1]
    if args is not None:
        function["arguments"] = args
    if function:
        delta["function"] = function  # type: ignore[typeddict-item]
    return delta


def test_01_single_tool_five_fragments() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("call_a", "get_weather"))])
    for part in ['{"city"', ': "北', '京", "unit', '": "ce', 'lsius"}']:
        acc.push([frag(0, part)])

    result = acc.finish()
    assert result.broken == []
    assert len(result.calls) == 1
    call = result.calls[0]
    assert call.id == "call_a"
    assert call.name == "get_weather"
    assert call.arguments_text == '{"city": "北京", "unit": "celsius"}'
    assert call.arguments == {"city": "北京", "unit": "celsius"}


def test_02_two_tools_parallel_real_shape() -> None:
    acc = ToolCallAccumulator()
    # 完全照抄 samples/day4-toolcalls-raw.sse
    acc.push([frag(0, head=("chatcmpl-tool-b8a9", "get_weather"))])
    acc.push([frag(0, '{"city": "')])
    acc.push([frag(0, "北京")])
    acc.push([frag(0, '"}')])
    acc.push([frag(1, head=("chatcmpl-tool-b574", "get_time"))])
    acc.push([frag(1, '{"city": "')])
    acc.push([frag(1, "上海")])
    acc.push([frag(1, '"}')])

    result = acc.finish()
    assert result.broken == []
    assert [c.arguments for c in result.calls] == [{"city": "北京"}, {"city": "上海"}]
    assert [c.name for c in result.calls] == ["get_weather", "get_time"]


def test_03_interleaved_fragments() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "t0"))])
    acc.push([frag(1, head=("b", "t1"))])
    acc.push([frag(0, '{"x":')])
    acc.push([frag(1, '{"y":')])
    acc.push([frag(0, "1}")])
    acc.push([frag(1, "2}")])

    result = acc.finish()
    assert [c.arguments for c in result.calls] == [{"x": 1}, {"y": 2}]


def test_04_empty_string_and_missing_arguments() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "t"))])
    acc.push([frag(0, "")])  # 空串
    acc.push([frag(0, '{"k":')])
    acc.push([frag(0)])  # 字段缺失
    acc.push([frag(0, "true}")])

    assert acc.snapshot()[0].fragments == 5, "空片与缺字段也要计一片"
    assert acc.finish().calls[0].arguments == {"k": True}


def test_05_second_tool_first_block_without_id() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "t0"))])
    acc.push([frag(0, "{}")])
    acc.push([{"index": 1, "function": {"name": "t1", "arguments": "{}"}}])

    result = acc.finish()
    assert len(result.calls) == 1, "第一个调用仍应可用"
    assert len(result.broken) == 1
    assert result.broken[0].index == 1
    assert result.broken[0].name == "t1"
    assert "缺少 id" in result.broken[0].reason


def test_06_truncated_json_goes_to_broken() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "t"))])
    acc.push([frag(0, '{"city": "北')])

    result = acc.finish()
    assert result.calls == [], "半截参数绝不能被执行"
    assert len(result.broken) == 1
    assert result.broken[0].arguments_text == '{"city": "北'
    assert "不是合法 JSON" in result.broken[0].reason


def test_07_push_after_finish_raises() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "t"))])
    acc.push([frag(0, '{"k":1}')])
    acc.finish()

    with pytest.raises(RuntimeError, match="已封口"):
        acc.push([frag(0, "late")])


def test_08_tool_without_arguments_yields_empty_dict() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(0, head=("a", "ping"))])

    result = acc.finish()
    assert result.broken == []
    assert result.calls[0].arguments == {}


def test_09_output_in_source_order_not_completion_order() -> None:
    acc = ToolCallAccumulator()
    acc.push([frag(1, head=("b", "t1"))])
    acc.push([frag(1, '{"v":2}')])
    acc.push([frag(0, head=("a", "t0"))])
    acc.push([frag(0, '{"v":1}')])

    assert [c.index for c in acc.finish().calls] == [0, 1]


def test_10_missing_index_fails_fast() -> None:
    acc = ToolCallAccumulator()
    with pytest.raises(ValueError, match="缺少 index"):
        acc.push([{"function": {"arguments": "{}"}}])  # type: ignore[typeddict-item]
