/**
 * 增量 tool_calls 拼接：W1 唯一会被后续所有周复用的组件。
 *
 * 实测形状（samples/day4-toolcalls-raw.sse）：
 *   首块 { index:0, id:"chatcmpl-tool-...", type:"function", function:{ name:"get_weather" } }
 *   后续 { index:0, function:{ arguments:"{\"city\": \"" } }   ← id / name / type 全部缺席
 *
 * 三条铁律：
 * 1. 只用 `index` 分桶。id 只在首块出现，后续分片的 id 是 undefined，而 undefined 在 Map 里
 *    是稳定键：会把这些片段全并进同一个桶、互相拼接（不是"丢掉"，是"串味"）。
 * 2. 拼接期间绝不 JSON.parse。判定"完整"的唯一标准是：流已结束 + JSON.parse 成功。
 * 3. `finish_reason` 到达不代表参数收完：规范上其后不应再有该 choice 的 delta，但非官方
 *    网关是否遵守不可验证，因此封口一律推迟到"流真正结束"，不在 finish_reason 处触发。
 */

import type { ToolCallDelta } from "./types.ts";

/** 累积过程中的桶，暴露出来是为了让上层能诊断"流结束时哪个桶还是残的" */
export interface ToolCallDraft {
  index: number;
  id: string | null;
  name: string | null;
  /** 已拼接的 arguments 原文，可能是半截 JSON */
  argumentsText: string;
  /** 收到过多少片，用于区分"只有首块"与"正常多片" */
  fragments: number;
}

export interface AssembledToolCall {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
  /** parse 后的参数；没有参数的工具会得到 {} */
  arguments: unknown;
}

export interface BrokenToolCall {
  index: number;
  id: string | null;
  name: string | null;
  argumentsText: string;
  /** 为什么这个调用不能用：缺 id / 缺 name / 半截 JSON */
  reason: string;
}

export interface AssembleResult {
  /** 按 index 升序 = 模型源顺序（工程选择：可复现、便于回填；协议靠 tool_call_id 配对，不要求顺序） */
  calls: AssembledToolCall[];
  /** 不能执行的调用，调用方应据此回填 isError 工具结果，而不是抛异常中断整轮 */
  broken: BrokenToolCall[];
}

export class ToolCallAccumulator {
  private readonly buckets = new Map<number, ToolCallDraft>();
  private sealed = false;

  /** 喂一个 delta.tool_calls 数组；缺 index 无法分桶，直接失败而不是猜 */
  push(deltas: ToolCallDelta[] | undefined): void {
    if (this.sealed) {
      throw new Error("累积器已封口（finish() 之后又收到 tool_calls 片段）：调用方在流结束后仍喂数据，或 finish() 早于流结束");
    }
    if (!deltas || deltas.length === 0) return;

    for (const delta of deltas) {
      if (typeof delta.index !== "number") {
        throw new Error(`tool_call 分片缺少 index，无法分桶：${JSON.stringify(delta)}`);
      }

      let draft = this.buckets.get(delta.index);
      if (draft === undefined) {
        draft = { index: delta.index, id: null, name: null, argumentsText: "", fragments: 0 };
        this.buckets.set(delta.index, draft);
      }

      if (delta.id !== undefined) draft.id = delta.id;
      if (delta.function?.name !== undefined) draft.name = delta.function.name;

      // 首块实测没有 arguments 字段，也有实现给空串。两者都当"本片无内容"，但都要计一片。
      const fragment = delta.function?.arguments;
      if (typeof fragment === "string") draft.argumentsText += fragment;
      draft.fragments += 1;
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  /** 当前各桶快照，按 index 升序 */
  snapshot(): ToolCallDraft[] {
    return [...this.buckets.values()].sort((a, b) => a.index - b.index).map((d) => ({ ...d }));
  }

  /**
   * 封口并解析。**只能在流真正结束后调用**（收到 [DONE] 或连接正常关闭）。
   * 封口后再 push 会抛错，用来把"过早 finish"从静默 bug 变成显式崩溃。
   */
  finish(): AssembleResult {
    this.sealed = true;
    const calls: AssembledToolCall[] = [];
    const broken: BrokenToolCall[] = [];

    for (const draft of this.snapshot()) {
      const missing = this.describeMissing(draft);
      if (missing !== null) {
        broken.push({ ...draft, reason: missing });
        continue;
      }
      try {
        // 没有参数的工具，模型可能一个字符都不发："" 视为 {}
        const parsed: unknown = draft.argumentsText === "" ? {} : JSON.parse(draft.argumentsText);
        calls.push({
          index: draft.index,
          id: draft.id as string,
          name: draft.name as string,
          argumentsText: draft.argumentsText,
          arguments: parsed,
        });
      } catch (error) {
        broken.push({
          ...draft,
          reason: `arguments 不是合法 JSON（可能被截断）：${(error as Error).message}`,
        });
      }
    }

    return { calls, broken };
  }

  private describeMissing(draft: ToolCallDraft): string | null {
    if (draft.id === null) {
      return "缺少 id：无法与 tool 结果配对（若分桶用了 id 而不是 index，这里必然为空）";
    }
    if (draft.name === null) {
      return "缺少 function.name：不知道该执行哪个工具";
    }
    return null;
  }
}
