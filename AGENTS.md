# AGENTS.md

本仓库的 AI 编码助手操作约定。**所有读写操作必须发生在仓库根目录（本文件所在目录）之内**，不得触碰该目录之外的路径。

> 本仓库在多台机器上开发，clone 到不同机器后路径必然不同。因此：**文档与脚本里一律不写绝对路径、不写死单机版本号**，路径以"仓库根目录"相对描述，版本以"最低要求 + 校验命令"描述。

## 1. 仓库性质

个人 Agent Harness 学习仓库，不是产品项目。唯一核心作品是将逐步构建在本仓库内的 `mini-harness/`。

| 文件 | 角色 |
|---|---|
| `PLAN.md` | **唯一事实来源**：15 周路线、技能优先级、每周任务与验收标准、目标目录结构、进度表 |
| `weeks/W<N>.md` | 当周每日清单：任务 / 验收 / 坑点 / 时间不够时的砍单顺序 |
| `AGENTS.md` | 本文件，只讲"怎么干活"，不重复 PLAN 的路线内容 |

与 `PLAN.md` 冲突时以 PLAN 为准，并在回复中直接指出冲突点，不要擅自"折中"。

## 2. 硬性约束

1. **不引入 openai / anthropic 官方 SDK**。协议层一律用原生 `fetch`（TS）或 `httpx`（Python）手写，目标是看懂协议而非调用封装。
2. **不以 LangChain / AutoGPT 之类框架拼装作为主要作品**（PLAN 第 8 节）。
3. **Rust 在 W15 之前不启动**，触发条件见 PLAN 第 9 节。
4. 密钥只放 `.env`，`.venv/`、`node_modules/`、`.env` 必须被忽略。`.gitignore` 属于仓库内容、必须存在且随仓库提交——否则换一台机器 clone 后新建的虚拟环境会污染 `git status`。提交前检查 `git diff --cached`：出现密钥、虚拟环境、依赖目录一律撤回。
5. **不擅自修改 `PLAN.md` 的进度追踪表（第 10 节）与验收标准**；确需更新时，先说明要改哪几行，等确认后再动。
6. 不新增 `*.md` 文档，除非当周清单已明确要求（如 `notes/streaming-notes.md`）或用户明确要求。
7. 不提前实现后续周的内容。前置未完成时的"顺手做完"是负资产。

## 3. 环境（写要求与校验，不写单机实测值）

每台机器的版本号都不会相同，**本表只记录"能不能用"的判据**。开始干活前先在仓库根目录跑一遍自检，任一项不满足就先修环境，不要带病写代码。

| 项 | 要求 | 校验 | 不满足的后果 |
|---|---|---|---|
| Node | **≥ 22.18**（该版本起默认开启类型擦除，可直接 `node x.ts`） | `node -v` | 低于 22.18 需手动加 `--experimental-strip-types`，否则类型注解直接语法报错 |
| Python（系统） | 3.8.x 已 EOL，**禁止直接使用** | `python3 -V` | 无 `TaskGroup`、无运行时 `X \| Y` 联合类型 |
| Python（项目） | **3.12**，由 uv 创建在仓库根目录的 `.venv/` | `python -V`（须在 venv 内，应为 3.12.x） | 语法与标准库行为与预期不符 |
| uv | 能执行 `uv venv --python 3.12` | `uv --version` | 无法创建项目解释器 |
| Git | 分支 `main`，remote `origin` → `git@github.com:btroops/agent-learn.git` | `git remote -v` | 推送需额外参数 |

自检（在仓库根目录执行；第一行须输出 `OK`，第二行须输出分支 `main` 与 `origin` 的 URL）：

```bash
node -e 'const [m,n]=process.versions.node.split(".").map(Number);console.log("node",process.versions.node,(m>22||(m===22&&n>=18))?"OK":"需 >=22.18")'
uv --version && git rev-parse --abbrev-ref HEAD && git remote get-url origin
```

Node 类型擦除的限制（适用于所有 ≥22.18 的版本，与具体版本号无关）：**不能用** `enum`、`namespace`、构造函数参数属性（`constructor(private x: T)`）。

以下命令均以 `mini-harness/` 为工作目录：

```bash
# Python 环境（在仓库根目录执行一次）
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install httpx

# TypeScript：直接运行，不生成中间产物
node ts/src/sse.ts
node --test ts/src/*.test.ts

# Python：测试
python -m pytest py/tests -q
```

## 4. 目录与命名约定

目标结构见 PLAN 第 7 节与 `weeks/W<N>.md` 末尾的目录图。当前约定：

- `weeks/W1.md`、`weeks/W2.md` … 一周一个文件，只追加当周内容，不回头改已归档周。
- `mini-harness/ts/src/*.ts`：TS 源码；单测与被测文件同目录，命名 `*.test.ts`，**不依赖真实网络**（用手工构造的畸形 chunk）。
- `mini-harness/py/src/mini_llm/*.py`：Python 源码；单测放 `mini-harness/py/tests/`，用 pytest。
- `mini-harness/notes/`：踩坑记录与故障样本，文件内容必须来自亲手验证，不写"网上看到"的结论。
- 双语言实现保持**同构**：TS 与 Python 的模块划分、函数名（camelCase ↔ snake_case）、行为一一对应，便于对照阅读。

## 5. 提交规范（Conventional Commits）

```
<type>(<scope>): <简述，中文，不超过 50 字>

<为什么这么改，必要时说明取舍>
```

- `type`：`feat` / `fix` / `refactor` / `test` / `docs` / `chore`（学习仓库里 `docs`、`test` 占比会很高）。
- `scope`：模块名，如 `ts`、`py`、`sse`、`tool-accum`、`loop`、`session`、`trace`、`eval`、`web`。
- 一次提交只做一件事；纯格式化与逻辑改动分开。
- 每周收工打周标签：`git tag w1-done`（见 `weeks/W1.md` Day 7）。

## 6. 干活流程

1. 开工前读 `PLAN.md` 对应周 + `weeks/W<N>.md` 当日条目，确认"目标 / 任务 / 验收"三段都看过。
2. 按清单顺序推进，遵守当日的"坑点提醒"与"不要在这一天做什么"。
3. 交付前逐条对照**当周验收项**；checkbox 只有在命令真实跑过且通过后才能勾选。
4. 未通过、未验证、被跳过的检查必须如实说明，不写"应该没问题"。
5. 环境与 PLAN 假设不一致时（版本、命令、接口行为），先报告差异再继续。

## 7. 回答风格

- 中文，结论先行，不铺垫背景。
- 涉及取舍时给出被放弃的方案及原因，这是本仓库的学习目标之一。
- 不主动生成大段样板代码；先说明设计再实现。
