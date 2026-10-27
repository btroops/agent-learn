# 开发日志

> 逐日记录：做了什么 / 命令 / 实测结果 / 结论 / 遗留。
> 原始响应一律落 `notes/samples/`，正文只写从样本里读出来的结论，不复述整段 JSON。
> 落盘时 URL 的 path token 打码为 `/s/u/***/`，API Key 只存在于 `.env`（已 gitignore）。

---

## Day 1 — 2026-10-27 环境与第一次非流式裸调

**目标**：打通"一个请求 → 一个完整响应"，让 `types.ts` 的字段有真实响应作对照。

### 1. 环境实测

| 项 | 本机实测 | 判定 |
|---|---|---|
| Node | 22.19.0 | OK（≥22.18，可直接 `node x.ts`） |
| 系统 Python | 3.8.10 | 禁用（EOL，无 `TaskGroup`） |
| 项目 Python | 3.12.13（`.venv/`） | OK |
| uv | 0.11.32 | OK |
| httpx | 0.28.1 | OK |
| typescript / @types/node | 7.0.2 / 26.6.5 | devDependencies，仅编译期 |

### 2. 网关画像

- 自建 OpenAI 兼容网关，后端 **vLLM**：`system_fingerprint = vllm-0.0.0-tp4-pp2-ep-8d310e51`
- `/models` 实测可用：`bge-m3`、`bge-reranker`、`DeepSeek-V4.1-Flash`、`GLM-5.3-Flash`、`Qwen3-ASR-1.7B`、`Qwen3.8-27B`、`SimOCR`、`Z-Image-Turbo`
- 选用 `DeepSeek-V4.1-Flash`（**推理模型**，有独立 reasoning 字段）

复现命令（在 `mini-harness/ts` 下）：

```bash
node --env-file=../.env src/smoke.ts --models --save=../notes/samples/day1-models.json
node --env-file=../.env src/smoke.ts --save=../notes/samples/day1-chat-plain.json
node --env-file=../.env src/smoke.ts --with-tools --save=../notes/samples/day1-chat-toolcall.json
```

### 3. 实测结论

**① 工具定义全额计入 `prompt_tokens`**（A/B：同 prompt，只差一个 `tools` 字段）

| 场景 | prompt_tokens | 差值 |
|---|---|---|
| 无工具 | 35 | — |
| 带 1 个 `get_weather` 定义 | 324 | **289** |

→ 1 个工具 ≈ 289 tokens，20 个工具 ≈ 5800 tokens/轮。W3 的"description 长度预算"有硬成本依据，不是洁癖。

**② `tool_calls` 的非流式形状（Day 4 的对照物）**

```
finish_reason: "tool_calls"
message.content: null                    ← 不能用 content 判断有无结果
message.tool_calls[0].id: "chatcmpl-tool-a2ef45781e431c95"
message.tool_calls[0].function.arguments: "{\"city\": \"北京\", \"unit\": \"celsius\"}"   ← 一次完整的 JSON 串
message.reasoning: "The user asks about Beijing weather..."     ← vLLM 非标字段
```

→ 非流式下参数天然完整；流式下同一串会被按 `index` 切成碎片并可能交错，这是 W1 的唯一硬骨头（Day 4）。

**③ 推理模型的成本结构**

| 样本 | completion_tokens | reasoning_tokens | 占比 |
|---|---|---|---|
| plain | 121 | 91 | 75% |
| toolcall | 71 | 15 | 21% |

→ `reasoning_tokens` 单独计费且波动极大。W4 的 token 预算若只统计 `content`，会低估 2-4 倍。

**④ 网关自带 prefix cache，且缓存是 per-instance 的**（意外发现，W5 直接用）

- `toolcall` 样本：`prompt_tokens 324` 中 `cached_tokens 256`（命中 79%）；`plain` 样本为 0。
- 两次调用的响应头 `x-vllm-instance` 从 `b` 变成 `a` → 网关在**多实例间轮询**。
- 推论：命中率取决于"有没有被路由回同一实例"，不稳定。W5 做 "prefix cache 友好布局" 时，必须同时记录 `x-vllm-instance`，否则实验数据不可复现——这条是本仓库第一个"不看响应头就会得出错误结论"的坑。

**⑤ 没有任何限流头**

响应头只有网关自加的 `req-arrive-time` / `req-cost-time` / `resp-start-time` / `x-envoy-upstream-service-time`，**无 `x-ratelimit-*`**。

→ Day 6 的 429 大概率拿不到 `Retry-After`，重试策略不能依赖该头，得改用指数退避 + 本地计数。

### 4. 产出与取舍

| 文件 | 说明 |
|---|---|
| `ts/src/types.ts` | 只纳入真实出现过的字段；恒为 null 的 `prompt_logprobs` / `kv_transfer_params` / `metrics` 不纳入类型 |
| `ts/src/smoke.ts` | 非流式裸调，`--models` / `--with-tools` / `--headers` / `--save=` 四个开关 |
| `ts/tsconfig.json` | **计划外新增**，理由见下 |

计划外新增 `tsconfig.json` 的取舍：

- 不引入会带来问题的依赖，只装了 `typescript` + `@types/node`（纯编译期，不是 LLM SDK，不违反"不引入官方 SDK"铁律）。
- 收益 1：`erasableSyntaxOnly: true` 把 AGENTS 的"不能用 `enum` / `namespace` / 构造函数参数属性"从口头约定变成**编译期报错**。
- 收益 2：`npm run typecheck` 可当门禁，`npx tsc --noEmit` 当前 exit 0。
- 被放弃的方案：手写 `declare const process` 垫片。零依赖但后续用到 `fs` / `path` 时必然要重写。

### 5. 遗留

- [ ] Day 2：`sse.ts` + 8 条畸形 chunk 单测（纯离线）
- [ ] Day 6：429 的触发方式要重新设计（无 `Retry-After` 可读）
- [ ] Day 7：`streaming-notes.md` 的 5 个章节中，第 3/4/5 节待后面几天补齐
