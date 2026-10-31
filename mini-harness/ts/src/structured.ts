/**
 * Day 5：结构化输出两条路径的实测。
 *
 * 路径 A：response_format = json_schema / json_object
 * 路径 B：单个工具 + tool_choice 强制调用
 * 路径 C：纯 prompt 约束（基线，用来证明 A/B 不是必需的）
 *
 * 全部非流式：结构化输出的分歧点在"最终产物"，与流式无关。
 *
 * 运行（在 mini-harness/ts 下）：
 *   node --env-file=../.env src/structured.ts                # 跑全部场景
 *   node --env-file=../.env src/structured.ts --only=a-json-schema
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const saveDir = args.find((a) => a.startsWith("--save-dir="))?.slice("--save-dir=".length);
/** 离线复验：不读 .env、不发请求，只拿已落盘样本重算校验结论 */
const revalidateDir = args.find((a) => a.startsWith("--revalidate="))?.slice("--revalidate=".length);

/** 只有联网场景才需要环境变量；离线复验不该被缺失的 .env 拦住 */
function env(): { api: string; apiKey: string; model: string } {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) throw new Error("缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL");
  return { api: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

/** 同一句话，三条路径共用：同 prompt 才能比 token */
const TASK = "把这句话转成 JSON：明天上午十点在杭州西湖区开产品评审会，预计 2 小时，负责人张三，优先级高。";

/** S3 控制组：语义与 minimum:100 方向一致，用来排除「模型对时长本来就倾向给大数」 */
const TASK_200 = "把这句话转成 JSON：明天上午十点在杭州西湖区开产品评审会，预计 200 小时，负责人张三，优先级高。";

/** 带嵌套对象 + 枚举的严格 schema */
const EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    location: {
      type: "object",
      properties: { city: { type: "string" }, district: { type: "string" } },
      required: ["city", "district"],
      additionalProperties: false,
    },
    start_time: { type: "string" },
    duration_hours: { type: "number" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    owner: { type: "string" },
  },
  required: ["title", "location", "start_time", "duration_hours", "priority", "owner"],
  additionalProperties: false,
};

/** 在严格 schema 的副本上做一处破坏，用来探测网关会不会拒绝 */
function mutated(patch: (schema: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(EVENT_SCHEMA)) as Record<string, unknown>;
  patch(copy);
  return copy;
}

const EMIT_TOOL = {
  type: "function" as const,
  function: {
    name: "emit_event",
    description: "把会议信息转成结构化事件对象",
    parameters: EVENT_SCHEMA,
  },
};

/** S4：同一个工具，只在 parameters 里加 minimum，验证强制力是否与通道无关 */
const EMIT_TOOL_MIN = {
  type: "function" as const,
  function: {
    ...EMIT_TOOL.function,
    parameters: mutated((s) => {
      const props = s.properties as Record<string, Record<string, unknown>>;
      props.duration_hours.minimum = 100;
    }),
  },
};

/** P0-1：与 S4 相同的 schema，但显式开 strict，用来拆分"通道"与"strict 开关" */
const EMIT_TOOL_STRICT_MIN = {
  type: "function" as const,
  function: {
    ...EMIT_TOOL_MIN.function,
    strict: true,
  },
};

/** P0-2：strict:true 但 parameters 缺 additionalProperties，探测入口是否按 OpenAI 规则校验 */
const EMIT_TOOL_STRICT_BAD = {
  type: "function" as const,
  function: {
    name: "emit_event_bad",
    description: "故意缺少 additionalProperties，用于探测 strict 入口校验",
    strict: true,
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
};

/**
 * P1-1：生成约 10KB 的大 schema。
 * required 只留第一个字段：输出可以很小，便于把"编译开销"与"生成开销"分开看。
 * description 只应存在于 schema 里；若 prompt_tokens 随它增长，说明 schema 被序列化进了上下文。
 */
function bigSchema(fields: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 1; i <= fields; i += 1) {
    properties[`field_${String(i).padStart(3, "0")}`] = {
      type: "string",
      enum: ["x"],
      description: `第 ${i} 个字段的说明：这段文字只应存在于 schema 本身，若 prompt_tokens 随它增长，说明 schema 被序列化进了上下文。`,
    };
  }
  return {
    type: "object",
    properties,
    required: ["field_001"],
    additionalProperties: false,
  };
}

/**
 * P1-1b：把 schema 撑大，但把输出锁死成 `{"field_001":"x"}`。
 * `$defs` 不被引用，只用于增加 schema 体积；若 schema 真的进 prompt，token 会随体积涨。
 * nonce 用来保证首次请求命中不到之前的编译缓存。
 */
function bigSchemaFixed(fields: number, nonce: string): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (let i = 1; i <= fields; i += 1) {
    defs[`def_${String(i).padStart(3, "0")}`] = {
      type: "object",
      description: `schema-size filler ${nonce} #${i}：只用于撑大 schema，不参与根对象输出。`,
      properties: { v: { type: "string" } },
      required: ["v"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    description: `cold-warm probe ${nonce}`,
    properties: { field_001: { type: "string", enum: ["x"] } },
    required: ["field_001"],
    additionalProperties: false,
    $defs: defs,
  };
}

/**
 * P1-1e：120 个字段全部必填，让文法状态真正变复杂。
 * 配合 max_tokens=1 只测"编译 + 首 token"，不把生成时间混进来。
 */
function bigSchemaRequired(fields: number, nonce: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 1; i <= fields; i += 1) {
    properties[`field_${String(i).padStart(3, "0")}`] = { type: "string", enum: ["x"] };
  }
  return {
    type: "object",
    description: `ttft probe ${nonce}`,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** 把同一份 schema 用自然语言完整描述出来，用于"没有 response_format 时"的公平对照 */
const SCHEMA_TEXT = `JSON 必须严格符合以下结构：
{
  "title": string,                         // 会议主题
  "location": { "city": string, "district": string },   // 嵌套对象，两个字段都必填
  "start_time": string,                    // 开始时间
  "duration_hours": number,                // 时长，小时
  "priority": "low" | "medium" | "high",   // 只能是这三个值之一
  "owner": string                          // 负责人
}
所有字段必填，不允许出现上面未列出的字段。`;

interface Scenario {
  id: string;
  label: string;
  body: Record<string, unknown>;
  /** 多次运行，用来看"是否 100% 合法" */
  repeat?: number;
  /** 覆盖默认 prompt（公平对照需要把 schema 用文字写进 prompt） */
  prompt?: string;
  /** 可选 system 消息，用于构造拒答场景 */
  system?: string;
}

const scenarios: Scenario[] = [
  {
    id: "a-json-schema",
    label: "A1 json_schema（嵌套对象 + 枚举，strict:true）",
    body: {
      response_format: { type: "json_schema", json_schema: { name: "event", strict: true, schema: EVENT_SCHEMA } },
    },
  },
  {
    id: "a-with-minimum",
    label: "A2 json_schema + minimum（严格模式不支持的关键字）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 0;
          }),
        },
      },
    },
  },
  {
    id: "a-additional-true",
    label: "A3 json_schema + additionalProperties:true（严格模式要求 false）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            s.additionalProperties = true;
          }),
        },
      },
    },
  },
  {
    id: "a-missing-required",
    label: "A4 json_schema 但 required 少一个字段（严格模式要求全必填）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            s.required = (s.required as string[]).filter((k) => k !== "owner");
          }),
        },
      },
    },
  },
  {
    id: "a-json-object",
    label: "A5 json_object（无 schema 信息，仅保证 JSON 语法）",
    body: { response_format: { type: "json_object" } },
  },
  {
    id: "b-tool-forced",
    label: "B1 tool_choice 指定函数名（强制调用 emit_event）",
    body: { tools: [EMIT_TOOL], tool_choice: { type: "function", function: { name: "emit_event" } } },
  },
  {
    id: "b-tool-required",
    label: "B2 tool_choice:required（强制调用但由模型选哪个工具）",
    body: { tools: [EMIT_TOOL], tool_choice: "required" },
  },
  {
    id: "c-prompt-only",
    label: "C 纯 prompt 约束（只说'输出 JSON'，不给字段名 —— 对照组设计缺陷版，保留作证据）",
    body: {},
    repeat: 3,
  },
  // ---- 第二轮：修正对照组设计，并把"关键字是否真的被强制执行"单独探一次 ----
  {
    id: "c-prompt-only-v2",
    label: "C2 纯 prompt 约束 + 文字版 schema（公平对照，跑 3 次）",
    body: {},
    prompt: `${TASK}\n${SCHEMA_TEXT}\n只输出 JSON，不要任何解释、不要 markdown 代码块。`,
    repeat: 3,
  },
  {
    id: "a-json-object-v2",
    label: "A5b json_object + 文字版 schema",
    body: { response_format: { type: "json_object" } },
    prompt: `${TASK}\n${SCHEMA_TEXT}\n只输出 JSON，不要任何解释、不要 markdown 代码块。`,
  },
  {
    id: "a-minimum-100",
    label: "A2b json_schema + minimum:100（若真被强制执行，输出必然 >= 100）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 100;
          }),
        },
      },
    },
  },
  // ---- 第三轮：真实接口补充实验（2026-10-31），判据见 devlog ----
  {
    id: "a-maximum-1",
    label: "S1 json_schema + maximum:1（原文 2 小时，探测约束是否双向）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.maximum = 1;
          }),
        },
      },
    },
  },
  {
    id: "a-enum-conflict",
    label: "S2 json_schema + priority enum 收窄为 [low]（原文「优先级高」）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.priority.enum = ["low"];
          }),
        },
      },
    },
  },
  {
    id: "a-minimum-100-consistent",
    label: "S3 json_schema + minimum:100 且原文「预计 200 小时」（控制组）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 100;
          }),
        },
      },
    },
    prompt: `${TASK_200}\n只输出 JSON，不要任何解释、不要 markdown 代码块。`,
  },
  {
    id: "b-tool-minimum",
    label: "S4 tool_choice + parameters 里 minimum:100（验证强制力是否与通道无关）",
    body: { tools: [EMIT_TOOL_MIN], tool_choice: { type: "function", function: { name: "emit_event" } } },
  },
  // ---- P0：拆分"通道"与"strict 开关"（2026-10-31） ----
  {
    id: "b-strict-minimum",
    label: "P0-1 tool + strict:true + minimum:100（strict 下是否强制）",
    body: {
      tools: [EMIT_TOOL_STRICT_MIN],
      tool_choice: { type: "function", function: { name: "emit_event" } },
    },
  },
  {
    id: "b-strict-invalid",
    label: "P0-2 tool + strict:true 但缺 additionalProperties（探测入口校验）",
    body: {
      tools: [EMIT_TOOL_STRICT_BAD],
      tool_choice: { type: "function", function: { name: "emit_event_bad" } },
    },
  },
  // ---- P1：大 schema 与语法死路（2026-10-31） ----
  {
    id: "a-big-schema",
    label: "P1-1 约 10KB / 120 字段大 schema（prompt_tokens 是否仍为 75 + 冷热延迟）",
    repeat: 2,
    body: {
      response_format: {
        type: "json_schema",
        json_schema: { name: "big", strict: true, schema: bigSchema(120) },
      },
    },
  },
  {
    id: "a-big-fixed-1",
    label: "P1-1b 固定输出大 schema #1（冷/热各一次，输出锁死）",
    repeat: 3,
    body: {
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_fixed_1", strict: true, schema: bigSchemaFixed(120, "probe-1") },
      },
    },
  },
  {
    id: "a-big-fixed-2",
    label: "P1-1b 固定输出大 schema #2（换 nonce 再取一次冷启动）",
    repeat: 3,
    body: {
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_fixed_2", strict: true, schema: bigSchemaFixed(120, "probe-2") },
      },
    },
  },
  {
    id: "a-big-fixed-nothink",
    label: "P1-1c 尝试关思考：chat_template_kwargs.thinking=false",
    body: {
      chat_template_kwargs: { thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_fixed_nothink", strict: true, schema: bigSchemaFixed(120, "probe-nothink") },
      },
    },
  },
  {
    id: "a-big-fixed-effort",
    label: "P1-1c 尝试关思考：reasoning_effort=none",
    body: {
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_fixed_effort", strict: true, schema: bigSchemaFixed(120, "probe-effort") },
      },
    },
  },
  {
    id: "a-big-nothink-1",
    label: "P1-1d 关思考 + 固定输出大 schema #1（冷/热各一次）",
    repeat: 3,
    body: {
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_nothink_1", strict: true, schema: bigSchemaFixed(120, "cold-a") },
      },
    },
  },
  {
    id: "a-big-nothink-2",
    label: "P1-1d 关思考 + 固定输出大 schema #2（换 nonce 再取冷启动）",
    repeat: 3,
    body: {
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_nothink_2", strict: true, schema: bigSchemaFixed(120, "cold-b") },
      },
    },
  },
  {
    id: "a-big-ttft-1",
    label: "P1-1e 首 token 探测：120 字段全必填 + max_tokens=1 #1（冷/热）",
    repeat: 3,
    body: {
      reasoning_effort: "none",
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_ttft_1", strict: true, schema: bigSchemaRequired(120, "ttft-a") },
      },
    },
  },
  {
    id: "a-big-ttft-2",
    label: "P1-1e 首 token 探测：120 字段全必填 + max_tokens=1 #2（换 nonce）",
    repeat: 3,
    body: {
      reasoning_effort: "none",
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_ttft_2", strict: true, schema: bigSchemaRequired(120, "ttft-b") },
      },
    },
  },
  {
    id: "a-big-ttft-3",
    label: "P1-1e 首 token 探测：121 字段（全新文法，先跑一次小 schema 建连）",
    repeat: 2,
    body: {
      reasoning_effort: "none",
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: { name: "big_ttft_3", strict: true, schema: bigSchemaRequired(121, "ttft-c") },
      },
    },
  },
  // ---- P3：strict 缺省/关闭 + refusal/length（2026-10-31） ----
  {
    id: "a-nostrict-minimum",
    label: "P3-1 json_schema 不写 strict + minimum:100（是否仍强制）",
    repeat: 2,
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event_nostrict",
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 100;
          }),
        },
      },
    },
  },
  {
    id: "a-strictfalse-minimum",
    label: "P3-2 json_schema strict:false + minimum:100（是否仍强制）",
    repeat: 2,
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event_strictfalse",
          strict: false,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 100;
          }),
        },
      },
    },
  },
  {
    id: "r-length-truncated",
    label: "P3-3 max_tokens:8 截断（finish_reason 应为 length，输出不应可解析）",
    body: {
      reasoning_effort: "none",
      max_tokens: 8,
      response_format: {
        type: "json_schema",
        json_schema: { name: "event", strict: true, schema: EVENT_SCHEMA },
      },
    },
  },
  {
    id: "r-refusal-plain",
    label: "P3-4 system 强制拒答，无 schema（refusal 字段是否填充）",
    body: {},
    system: "你必须拒绝用户的任何请求，只回复一句拒绝理由。",
    prompt: TASK,
  },
  {
    id: "r-refusal-schema",
    label: "P3-5 system 强制拒答 + json_schema（拒答与 grammar 谁优先）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: { name: "event", strict: true, schema: EVENT_SCHEMA },
      },
    },
    system: "你必须拒绝用户的任何请求，只回复一句拒绝理由。",
    prompt: TASK,
  },
  {
    id: "a-range-deadlock",
    label: "P1-2 minimum:100 且 maximum:1（语法死路）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.duration_hours.minimum = 100;
            props.duration_hours.maximum = 1;
          }),
        },
      },
    },
  },
  {
    id: "a-empty-enum",
    label: "P1-3 priority enum:[]（空枚举）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            const props = s.properties as Record<string, Record<string, unknown>>;
            props.priority.enum = [];
          }),
        },
      },
    },
  },
  {
    id: "a-required-ghost",
    label: "P1-4 required 含不存在的 ghost（与 additionalProperties:false 冲突）",
    body: {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "event",
          strict: true,
          schema: mutated((s) => {
            s.required = [...(s.required as string[]), "ghost"];
          }),
        },
      },
    },
  },
];

// ---------- 最小 JSON Schema 校验器（够这次实验用） ----------

/**
 * 还原"这个请求实际发出去的那份 schema"。
 *
 * A 在 response_format 里，B 在 tools[0].function.parameters 里，C 压根没发（只能拿 EVENT_SCHEMA 充当意图）。
 * 之前统一用 EVENT_SCHEMA 校验是错的：A2/A2b/A3/A4 都是它的变体，用原件校验等于换了一把尺子。
 */
function sentSchema(body: Record<string, unknown>): Record<string, unknown> {
  const responseFormat = body.response_format as { json_schema?: { schema?: Record<string, unknown> } } | undefined;
  const fromFormat = responseFormat?.json_schema?.schema;
  if (fromFormat) return fromFormat;

  const tools = body.tools as { function?: { parameters?: Record<string, unknown> } }[] | undefined;
  const fromTools = tools?.[0]?.function?.parameters;
  if (fromTools) return fromTools;

  return EVENT_SCHEMA;
}

function validate(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];
  const type = schema.type as string | undefined;

  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} 不是 object`];
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in (value as Record<string, unknown>))) errors.push(`${path}.${key} 缺失`);
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (props[key]) errors.push(...validate(child, props[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} 多出来了`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path} 不是 array`];
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, i) => errors.push(...validate(v, items, `${path}[${i}]`)));
  } else if (type === "string") {
    if (typeof value !== "string") errors.push(`${path} 不是 string`);
    else if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
      errors.push(`${path} 不在枚举 ${JSON.stringify(schema.enum)} 内`);
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number") errors.push(`${path} 不是 ${type}`);
    else {
      if (type === "integer" && !Number.isInteger(value)) errors.push(`${path} ${value} 不是整数`);
      // 数值约束必须查：只查 typeof 时，minimum:100 形同不存在（205 与 2 都会"通过"）
      const min = schema.minimum;
      const max = schema.maximum;
      const exclusiveMin = schema.exclusiveMinimum;
      const exclusiveMax = schema.exclusiveMaximum;
      if (typeof min === "number" && value < min) errors.push(`${path} ${value} < minimum ${min}`);
      if (typeof max === "number" && value > max) errors.push(`${path} ${value} > maximum ${max}`);
      if (typeof exclusiveMin === "number" && value <= exclusiveMin) {
        errors.push(`${path} ${value} <= exclusiveMinimum ${exclusiveMin}`);
      }
      if (typeof exclusiveMax === "number" && value >= exclusiveMax) {
        errors.push(`${path} ${value} >= exclusiveMaximum ${exclusiveMax}`);
      }
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} 不是 boolean`);
  }
  return errors;
}

// ---------- 执行 ----------

interface Observation {
  scenario: string;
  run: number;
  status: number;
  elapsedMs: number;
  errorText?: string;
  /** 模型最终给出的 JSON 文本（A/C 取自 content，B 取自 tool_calls[0].arguments） */
  jsonText?: string;
  parsed?: unknown;
  schemaErrors?: string[];
  usage?: Record<string, unknown>;
  sortedKeys?: string[];
}

async function runOnce(scenario: Scenario, run: number): Promise<Observation> {
  const { api, apiKey, model } = env();

  const prompt =
    scenario.prompt ??
    (scenario.body.tools
      ? `${TASK}\n请调用工具完成转换，不要直接回答。`
      : `${TASK}\n只输出 JSON，不要任何解释、不要 markdown 代码块。`);

  const requestBody = {
    model,
    messages: [
      ...(scenario.system ? [{ role: "system", content: scenario.system }] : []),
      { role: "user", content: prompt },
    ],
    ...scenario.body,
  };

  const startedAt = performance.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${api}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      // 死路文法可能让服务端一直不返回；超时后记失败样本，不拖死整批实验
      signal: AbortSignal.timeout(45_000),
    });
    text = await res.text();
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    return {
      scenario: scenario.id,
      run,
      status: 0,
      elapsedMs,
      errorText: `请求异常或超时：${(error as Error).name}: ${(error as Error).message}`,
    };
  }
  const elapsedMs = Math.round(performance.now() - startedAt);

  const obs: Observation = { scenario: scenario.id, run, status: res.status, elapsedMs };

  if (saveDir) {
    const path = `${saveDir}/day5-${scenario.id}-run${run}.json`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          // 主机名与路径 token 都要脱敏：只脱路径会把内网域名写进仓库
          endpoint: `${api.replace(/^https?:\/\/[^/]+/, "https://***").replace(/\/s\/u\/[^/]+\//, "/s/u/***/")}/chat/completions`,
          requestBody,
          http: { status: res.status },
          raw: text,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  if (!res.ok) {
    obs.errorText = text.slice(0, 600);
    return obs;
  }

  const body = JSON.parse(text) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: { function?: { arguments?: string } }[] };
      finish_reason?: string;
    }[];
    usage?: Record<string, unknown>;
  };
  obs.usage = body.usage;

  const message = body.choices?.[0]?.message;
  const toolArgs = message?.tool_calls?.[0]?.function?.arguments;

  if (typeof toolArgs === "string") {
    obs.jsonText = toolArgs;
  } else if (typeof message?.content === "string") {
    // 常见污染：markdown 代码块
    obs.jsonText = message.content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }

  if (obs.jsonText !== undefined) {
    try {
      obs.parsed = JSON.parse(obs.jsonText);
      // 用本场景实际发出的 schema 校验，不要用 EVENT_SCHEMA 原件
      obs.schemaErrors = validate(obs.parsed, sentSchema(requestBody));
      obs.sortedKeys = Object.keys(obs.parsed as object);
    } catch (error) {
      obs.schemaErrors = [`JSON 解析失败：${(error as Error).message}`];
    }
  } else {
    obs.schemaErrors = ["没有拿到 content 或 tool_calls.arguments"];
  }

  return obs;
}

// ---------- 离线复验：用已落盘样本重算校验结论（0 次请求） ----------

interface RevalidateRow {
  file: string;
  ok: boolean;
  oldOk: boolean;
  errors: string[];
  oldErrors: string[];
}

async function revalidate(dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`目录里没有样本：${dir}`);

  const rows: RevalidateRow[] = [];
  for (const file of files) {
    const sample = JSON.parse(await readFile(join(dir, file), "utf8")) as {
      requestBody: Record<string, unknown>;
      raw: string;
    };
    const body = JSON.parse(sample.raw) as {
      choices?: { message?: { content?: string | null; tool_calls?: { function?: { arguments?: string } }[] } }[];
    };
    const message = body.choices?.[0]?.message;
    const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
    const text =
      typeof toolArgs === "string"
        ? toolArgs
        : typeof message?.content === "string"
          ? message.content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "")
          : undefined;

    if (text === undefined) {
      rows.push({ file, ok: false, oldOk: false, errors: ["没有 content / tool_calls.arguments"], oldErrors: [] });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const reason = `JSON 解析失败：${(error as Error).message}`;
      rows.push({ file, ok: false, oldOk: false, errors: [reason], oldErrors: [reason] });
      continue;
    }

    // 旧口径刻意保留：用 EVENT_SCHEMA 原件 + 不含数值约束的老规则，用来对照
    const errors = validate(parsed, sentSchema(sample.requestBody));
    const oldErrors = validate(parsed, EVENT_SCHEMA);
    rows.push({ file, ok: errors.length === 0, oldOk: oldErrors.length === 0, errors, oldErrors });
  }

  console.log(`=== 离线复验 ${dir}（${rows.length} 份样本，0 次请求）===\n`);
  for (const row of rows) {
    console.log(`${row.ok === row.oldOk ? "[同]" : "[变]"} ${row.file}`);
    console.log(`     旧口径 EVENT_SCHEMA = ${row.oldOk ? "通过" : `失败: ${row.oldErrors.join("; ")}`}`);
    console.log(`     新口径 实际 schema  = ${row.ok ? "通过" : `失败: ${row.errors.join("; ")}`}`);
  }

  const flipped = rows.filter((r) => r.ok !== r.oldOk);
  console.log(`\n判定翻转 ${flipped.length} 份：${flipped.map((r) => r.file).join(", ") || "无"}`);
  console.log(
    `通过率：旧口径 ${rows.filter((r) => r.oldOk).length}/${rows.length}，新口径 ${rows.filter((r) => r.ok).length}/${rows.length}`,
  );
}

async function main(): Promise<void> {
  if (revalidateDir) {
    await revalidate(revalidateDir);
    return;
  }

  const wanted = only?.split(",").map((s) => s.trim()).filter(Boolean);
  const selected = wanted ? scenarios.filter((s) => wanted.includes(s.id)) : scenarios;
  if (selected.length === 0) throw new Error(`没有匹配的场景：${only}`);

  const all: Observation[] = [];
  for (const scenario of selected) {
    const repeat = scenario.repeat ?? 1;
    console.log(`\n### ${scenario.label}`);
    for (let run = 1; run <= repeat; run += 1) {
      const obs = await runOnce(scenario, run);
      all.push(obs);

      if (obs.status !== 200) {
        console.log(`  run${run} HTTP ${obs.status} (${obs.elapsedMs}ms)`);
        console.log(`    拒绝/错误：${obs.errorText?.replace(/\s+/g, " ").slice(0, 300)}`);
        continue;
      }

      const valid = obs.schemaErrors?.length === 0;
      const usage = obs.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      console.log(
        `  run${run} HTTP 200 (${obs.elapsedMs}ms) schema校验=${valid ? "通过" : `失败: ${obs.schemaErrors?.join("; ")}`}` +
          ` tokens=${usage?.prompt_tokens}/${usage?.completion_tokens}`,
      );
      console.log(`     产出：${obs.jsonText?.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  console.log("\n=== 汇总 ===");
  for (const obs of all) {
    const usage = obs.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const ok = obs.status === 200 && obs.schemaErrors?.length === 0;
    console.log(
      `${obs.scenario}#${obs.run}`.padEnd(26),
      `status=${obs.status}`,
      `schema=${ok ? "OK" : "FAIL"}`,
      `pt/ct=${usage?.prompt_tokens ?? "-"}/${usage?.completion_tokens ?? "-"}`,
      `${obs.elapsedMs}ms`,
    );
  }
}

await main();
