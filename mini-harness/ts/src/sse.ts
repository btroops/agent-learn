/**
 * 不依赖任何库的 SSE（Server-Sent Events）解析器。
 *
 * 输入是**已解码的文本**，字节到文本的解码由调用方负责（见 stream.ts）。
 * 所有"完整事件"必须在遇到空行时才会吐出，因此天然不会产生半截事件。
 *
 * 规范要点（不是约定，是 WHATWG SSE 规定）：
 * - 行分隔符三种都要支持：\r\n、\n、\r
 * - `data` 可多行，拼接时用 \n
 * - data 缓冲为空时不派发事件（单独的 `data:` 行什么也不产生）
 * - `:` 开头是注释（keep-alive），整行丢弃
 * - 流结束时未以空行收尾的事件按规范丢弃，但要把残留交回调用方用于判断截断
 */

export interface SSEEvent {
  /** event 字段，缺省为 "message" */
  event: string;
  /** data 字段；多行 data 已用 \n 连接 */
  data: string;
  /** id 字段，出现过才会带 */
  id?: string;
}

/** end() 的结果：两者任一非空，说明流是被截断的，不是正常结束 */
export interface SSEEndReport {
  /** 还没凑成完整一行的残留文本 */
  leftoverLine: string;
  /** 已成行、但缺少结束空行因而未派发的 data */
  pendingData: string;
}

export class SSEParser {
  private buffer = "";
  private data = "";
  private eventName = "message";
  private lastId: string | undefined;

  /** 喂入一个 chunk，返回本次能凑出的完整事件（可能是 0 个或多个） */
  push(chunk: string): SSEEvent[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;

    // 结尾若是孤立的 \r，必须先扣住：它可能是被切开的 \r\n 的前半
    const hold = this.buffer.endsWith("\r") ? 1 : 0;
    const scannable = this.buffer.slice(0, this.buffer.length - hold);
    const lines = scannable.split(/\r\n|\n|\r/);
    // split 的最后一段是不完整的行，留到下次
    this.buffer = (lines.pop() ?? "") + this.buffer.slice(scannable.length);

    const events: SSEEvent[] = [];
    for (const line of lines) {
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** 流结束调用一次：返回被丢弃的残留，用于识别"断连 vs 正常结束" */
  end(): SSEEndReport {
    const report: SSEEndReport = { leftoverLine: this.buffer, pendingData: this.data };
    this.buffer = "";
    this.data = "";
    this.eventName = "message";
    this.lastId = undefined;
    return report;
  }

  private consumeLine(line: string): SSEEvent | null {
    if (line === "") return this.dispatch();

    // 注释行：服务端常拿它做 keep-alive，不参与任何状态
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // 只剥掉一个前导空格，"data:  x" 的值是 " x"
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        // 规范：缓冲为空则直接赋值，否则用 \n 追加
        this.data = this.data === "" ? value : `${this.data}\n${value}`;
        break;
      case "event":
        this.eventName = value === "" ? "message" : value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      default:
        // retry 等字段本仓库用不到，忽略而不是报错
        break;
    }
    return null;
  }

  private dispatch(): SSEEvent | null {
    // 规范：data 缓冲为空则不派发。这条让孤立的 `data:` 行变成"什么也没发生"
    if (this.data === "") {
      this.eventName = "message";
      return null;
    }
    const event: SSEEvent = { event: this.eventName, data: this.data };
    if (this.lastId !== undefined) event.id = this.lastId;
    this.data = "";
    this.eventName = "message";
    return event;
  }
}

export function createSSEParser(): SSEParser {
  return new SSEParser();
}

/** `[DONE]` 是 OpenAI 约定的终止哨兵，属于 data 负载而非控制行 */
export function isDoneEvent(event: SSEEvent): boolean {
  return event.data === "[DONE]";
}
