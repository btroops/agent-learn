"""与 ts/src/sse.test.ts 逐条对应：全部用手工构造的畸形 chunk，不发网络请求。"""

from mini_llm.sse import create_sse_parser, is_done_event


def test_01_single_complete_event() -> None:
    parser = create_sse_parser()
    events = parser.push('data: {"a":1}\n\n')
    assert len(events) == 1
    assert events[0].data == '{"a":1}'
    assert events[0].event == "message"


def test_02_half_packet_holds_until_complete() -> None:
    parser = create_sse_parser()
    assert parser.push('data: {"city":"北') == [], "半截事件必须憋住"

    events = parser.push('京"}\n\n')
    assert len(events) == 1
    assert events[0].data == '{"city":"北京"}'


def test_03_three_events_in_one_chunk() -> None:
    parser = create_sse_parser()
    events = parser.push('data: {"i":0}\n\ndata: {"i":1}\n\ndata: {"i":2}\n\n')
    assert [e.data for e in events] == ['{"i":0}', '{"i":1}', '{"i":2}']


def test_04_data_without_space() -> None:
    parser = create_sse_parser()
    events = parser.push('data:{"a":1}\n\n')
    assert len(events) == 1
    assert events[0].data == '{"a":1}'


def test_05_empty_data_is_not_dispatched() -> None:
    parser = create_sse_parser()
    assert parser.push("data:\n\n") == []
    assert parser.push("data: \n\n") == []
    assert len(parser.push('data: {"a":1}\n\n')) == 1


def test_06_done_is_data_payload_not_json() -> None:
    parser = create_sse_parser()
    events = parser.push('data: {"a":1}\n\ndata: [DONE]\n\n')
    assert len(events) == 2
    assert events[1].data == "[DONE]"
    assert is_done_event(events[1]) is True
    assert is_done_event(events[0]) is False


def test_07_crlf_split_across_chunks() -> None:
    parser = create_sse_parser()
    assert parser.push("data: x\r") == [], "结尾孤立的 \\r 必须扣住"
    events = parser.push("\n\r\n")
    assert len(events) == 1
    assert events[0].data == "x"


def test_08_comment_dropped_and_multiline_data_joined() -> None:
    parser = create_sse_parser()
    events = parser.push(": keep-alive\n\ndata: line1\ndata: line2\n\n")
    assert len(events) == 1, "注释与空行都不产生事件"
    assert events[0].data == "line1\nline2"


def test_09_end_reports_truncation() -> None:
    parser = create_sse_parser()
    assert parser.push('data: {"partial":') == []

    report = parser.end()
    assert report.leftover_line == 'data: {"partial":'
    assert report.pending_data == ""


def test_10_end_reports_pending_data_without_blank_line() -> None:
    parser = create_sse_parser()
    assert parser.push('data: {"a":1}\n') == [], "没有空行收尾就不算完整事件"

    report = parser.end()
    assert report.pending_data == '{"a":1}'


def test_11_event_and_id_passthrough() -> None:
    parser = create_sse_parser()
    events = parser.push("event: ping\nid: 42\ndata: hi\n\n")
    assert len(events) == 1
    assert events[0].event == "ping"
    assert events[0].id == "42"
