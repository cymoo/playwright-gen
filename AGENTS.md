# playwright-gen — 架构说明（for agents/devs）

自然语言 + URL / Electron 应用 → 可运行的 @playwright/test（TypeScript）用例。
按**目标复杂度**分 v1→v3，每档可独立运行。设计原则：用最小够用的复杂度（见根 `README.md` 的表）。

技术栈：Node ≥20 + TypeScript（ESM，`tsx` 直跑）、`@playwright/test`、Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）、`zod`、`commander`。DeepSeek 主模型（推理/工具/codegen），Qwen 视觉。

## 分层

- `src/common/`：稳定、版本无关的共享层；各版本**仅依赖它**，版本之间互不依赖。
- `src/v1/`：单次生成（静态 web 页）+ 可选视觉。
- `src/v2/`：Agent 驱动探索 + 轨迹→代码（动态页 / Electron）。
- `src/v3/`：Planner 拆套件 + 登录/多视图（复杂应用 / Electron）。
- `src/cli.ts`：统一 `pwgen v1|v2|v3` 分发（commander）。

## common 模块

| 文件 | 职责 |
|---|---|
| `models.ts` | deepseek（主）/ qwen（视觉）：`createOpenAICompatible` + env |
| `vision.ts` | `describeScreenshot`：Qwen 看图返回文本（用 file part） |
| `trajectory.ts` | 结构化轨迹：`LocatorDescriptor` / `Step` / `TargetSpec` / `Trajectory` |
| `locators.ts` | `candidateDescriptors`（推导有序候选）+ `renderLocator`（渲染）；纯函数、可单测 |
| `browser.ts` | 【v2/v3】`Session`：统一 web（`chromium.launch`+goto）与 electron（`_electron.launch`+`firstWindow`）；ARIA+`data-pwref` 快照、忠实定位 `resolve`、click/fill/check/select/hover/press/scroll/assert_* |
| `codegen.ts` | 轨迹 → @playwright/test 代码（web / electron 两形态） |
| `explore.ts` | 【v2/v3】AI SDK 工具（闭包注入 session/traj）+ Explorer 循环 + `generateOne` |
| `runner.ts` | `runPlaywright`：`playwright test` 裁判（每 run 目录自带极简 config，testDir `.`） |
| `sanitizer.ts` · `io.ts` | 去 fence + 轻校验 / 时间戳输出目录 |

## 关键技术决策

- **忠实定位（execute == record）**：`resolve()` 逐个尝试候选描述符（role+name > `getByLabel` > placeholder > testid > role+nth），用 Playwright 自己的枚举校验其唯一命中带 `data-pwref` 的目标元素（必要时按**真实序号**修 nth），**只记录真正执行的那个**。消除了"记录 ≠ 执行"与手写可访问名近似的偏差。`data-pwref` 仅作 Agent 寻址句柄。
- **轨迹 → 代码**：结构化描述符 → `codegen` 按 `TargetSpec` 渲染 web / electron；确定性、即可回放。
- **verify → repair**：clean-replay 失败把日志回灌、重新探索。
- **Agent 层 = Vercel AI SDK**：`generateText` + tools + `stopWhen: [stepCountIs(N), hasToolCall('finalize')]`（注意 AI SDK v7 默认 `stopWhen` 是 1 步，做工具循环必须显式设置）；结构化用 `generateObject`（DeepSeek 的 json 模式要求 prompt 含 "json"，故 v1/planner 提示词已包含）。
- **视觉 = Qwen**：DeepSeek 无视觉；`look` 工具与 v1 预处理都走 Qwen 看图返回文本。
- **无 navigate 工具 / 无固定 sleep**：入口 URL 由引擎自动打开，站内导航靠点击；交互后靠 Playwright 自动等待，不 sleep。

## 运行与验证

```bash
npm install ; npx playwright install chromium ; cp .env.example .env   # 填凭据
npx tsx src/cli.ts v1 --url "file://$PWD/examples/01_static_form.html" --description "..."
npx tsx src/cli.ts v2 --url "file://$PWD/examples/03_spa_modal.html" --description "..."
npx tsx src/cli.ts v3 --url "file://$PWD/examples/04_login_app.html" --username admin --password secret --description "..."
npx tsx src/cli.ts v2 --electron-bin "/path/to/App.app" --description "..."   # Electron
npm run typecheck                          # tsc --noEmit
npx playwright test tests/unit.spec.ts     # 纯逻辑单测
```

`examples/` 是分层基准页面（① 静态 ② 图标 ③ SPA 弹窗 ④ 登录后台），用于验证每档在其复杂度上的表现。
Electron 目标的代码路径已实现并通过类型检查/单测，但仓库不含打包二进制，需用真实应用本地验证。
