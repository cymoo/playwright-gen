# playwright-gen — 架构说明（for agents/devs）

自然语言 + URL / Electron 应用 → 可运行的 @playwright/test（TypeScript）用例。
**单一通用命令**（无版本分档）：多步骤描述由引擎确定性拆分、逐步驱动，全部生成进一个用例文件。

技术栈：Node ≥20 + TypeScript（ESM，`tsx` 直跑）、`@playwright/test`、Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）、`zod`、`commander`。DeepSeek 主模型（推理/工具调用），Qwen 视觉（仅 `--vision`）。

## 模块（src/ 扁平结构）

| 文件 | 职责 |
|---|---|
| `cli.ts` | 单命令入口：`--url` \| `--electron-bin`（互斥）+ `--description` |
| `engine.ts` | 核心：`splitSteps` 步骤拆分 → 逐步骤 Agent 对话（AI SDK 工具循环）→ codegen → clean-replay → 修复；含全部工具定义与系统提示词、显式引用完成校验 |
| `browser.ts` | `Session`：统一 web（chromium+goto）与 electron（`_electron.launch`+`firstWindow`）；ARIA+`data-pwref` 快照（含开关选中态）、忠实定位 `resolve`、click/fill/check/**uncheck**/select/hover/press/scroll/**waitFor**/assert_* |
| `trajectory.ts` | 结构化轨迹：`LocatorDescriptor` / `Step`（含 `stepStart` 分组标记、assertVisible 的 `timeoutMs`）/ `TargetSpec` |
| `locators.ts` | `candidateDescriptors`（推导有序候选）+ `renderLocator`（渲染）；纯函数、可单测 |
| `codegen.ts` | 轨迹 → 代码：web/electron 两形态、`test.step()` 分块、`computeTimeout` 按轨迹算 `test.setTimeout` |
| `shell.ts` | `execShell`：一次性 shell 命令执行器（`shell: true`，stdin 逐行输入）+ 生成用例里的孪生辅助函数源码（`SHELL_HELPER_TS`/`WRITE_HELPER_TS`，同文件放置防漂移） |
| `runner.ts` | `runPlaywright`：`playwright test` 裁判（每 run 目录自带极简 config，testDir `.`；通过 Node 直接启动 Playwright CLI，避免文件名 shell 插值） |
| `models.ts` | deepseek / qwen：`createOpenAICompatible` + env；`envMaxSteps` |
| `vision.ts` | `describeScreenshot`：Qwen 看图返回文本（file part） |

## 关键技术决策

- **引擎持有步骤清单（本次重构的核心）**：描述里的 `步骤N：`/`Step N:` 被 `splitSteps` 确定性拆分（句首标注才算，少于 2 个则整段单步）。每个步骤跑一个**独立** `generateText` 对话：独立轮数预算（`MAX_STEPS`/步）、独立 `step_done` 完成标志（经引擎校验：必须有操作；步骤文本含"预期/出现/显示…"时必须有断言，缺失断言始终驳回）。做不完显式失败：结束当前会话 → 从新会话整轮重探（`--max-repairs`）→ 报错退出（exit 1）。**杜绝旧版"长对话截断/注意力飘移导致只生成前几步"**。
- **忠实定位（execute == record）**：`resolve()` 逐个尝试候选描述符（role+name > `getByLabel` > placeholder > testid > role+nth），用 Playwright 自己的枚举校验其唯一命中带 `data-pwref` 的目标元素（必要时按**真实序号**修 nth），**只记录真正执行的那个**。`data-pwref` 仅作 Agent 寻址句柄。
- **长等待一等公民**：`wait_for(target, timeout_seconds≤600)` 等录制/加载/跳转（目标文本不必当前在页面上，`getByText(t).first()` 等出现）；记录为带 `timeoutMs` 的 `assertVisible`。`computeTimeout` = 30s + 1s/动作 + Σ断言超时，写进 `test.setTimeout`，runner 再 +60s——探索通过的长流程回放不会超时误判。
- **开关/复选框**：快照标注 `[已选中]/[未选中]`；`check`/`uncheck` 成对（旧版没有 uncheck，"关闭开关/取消勾选"做不了）。
- **轨迹 → 代码**：结构化描述符 → `codegen` 按 `TargetSpec` 渲染 web / electron（electron 用 try/finally 确保 close）；`stepStart` 标记 → `test.step()` 分块。确定性、即可回放；LLM 不直接写代码。
- **工具异常全部转文字**：定位失败/超时等都以"操作失败：…"回给模型自纠，不中断对话。
- **Agent 层 = Vercel AI SDK**：`generateText` + tools + `stopWhen: [stepCountIs(N), () => flag.done]`（注意 AI SDK v7 默认 `stopWhen` 是 1 步，做工具循环必须显式设置；完成标志用闭包而非 `hasToolCall`，因为 `step_done` 可能被引擎驳回）。
- **无 navigate 工具 / 无固定 sleep**：入口 URL/应用由引擎打开，站内导航靠点击;等待用 `wait_for`，不 sleep。
- **本地环境工具（命令行 + 文件）**：`run_command` 一次性执行 shell 命令（POSIX sh / Windows cmd，`stdin_lines` 给交互式 CLI 逐行输入，如 `hdc shell` → cd → counters gather → exit；超时 clamp 1–600s）；退出码 0 才记入轨迹，回放时重跑并 `expect(...).toBe(0)`——命令类步骤的可回放验证，`step_done` 断言门也认它。`write_file` 记入轨迹并回放；`read_file` 仅观察不记录。相对路径统一相对 run 目录（生成用例里用 `dirname(test.info().file)` 解析，与探索一致）；`node:` import 与辅助函数按需注入，纯 UI 用例产物不变。无持久后台会话（按需求明确降范围）。
- **文件保存（下载 + Electron 原生对话框）**：`click_and_save(target, save_as)` 点击"保存/导出/下载"类按钮：web 接 download 事件 `saveAs`（不接则 Playwright 把下载收进临时目录、context 关闭即删）；Electron 先 `electronApp.evaluate` stub `dialog.showSaveDialog(Sync)` 返回目标路径（原生对话框不在 DOM，看不见也点不到），应用直写盘则轮询文件出现。先删同名旧文件防误判（探索重试与重复回放都靠这个保证"文件存在 = 本次点击的产物"），故 `save_as` 强制限制在 run 目录内（拒绝绝对路径/越界 `..`）；文件落盘才记 `clickSave` 轨迹，回放辅助函数 `SAVE_HELPER_TS` 与执行器同在 `browser.ts`（孪生不漂移）。`EXPECTATION_RE` 含"保存/导出/下载"→ 此类步骤强制有验证，`step_done` 断言门也认 `clickSave`。

## 运行与验证

```bash
npm install ; npx playwright install chromium ; cp .env.example .env   # 填凭据
npx tsx src/cli.ts --url "file://$PWD/examples/03_spa_modal.html" --description "..."
npx tsx src/cli.ts --url "..." --description "步骤1：…。步骤2：…"      # 多步骤 → 一个用例，test.step 分块
npx tsx src/cli.ts --electron-bin "/path/to/App.app" --description "..."   # Electron
npm run typecheck                          # tsc --noEmit
npx playwright test tests/unit.spec.ts     # 纯逻辑单测（splitSteps / locators / codegen）
```

`examples/` 是基准页面（静态 / 图标 / SPA 弹窗 / 登录后台）。
Electron 代码路径已实现并通过类型检查/单测，但仓库不含打包二进制，需用真实应用本地验证。

## 可复用用例（0.2.0）

- `config.ts` 校验 params/rules；`runtime.ts` 提供参数解析和 scope + exact/numberSuffix + unique/first/index 规则，复制为生成目录的 `pwgen-runtime.ts`，执行与回放共用实现。
- 描述中 `${name}` 和 `@rule` 必须保持显式引用，不得把样例值固化；规则写入轨迹，回放只覆盖参数。
- `replay.ts` / `cli.ts replay` 每次扫描 PB/RDC 文件清单，逐文件独立运行同一 spec、注入 inputFile/inputName，报告失败汇总。不是通用循环/分支引擎。
- 前 N 个资源要求用户写 N 个独立步骤，使用规则序号且列表排序稳定；条件场景拆分用例。详见 `docs/reusable-tests.md`。
- `tests/reuse.spec.ts` 包含真实浏览器和生成用例回放测试；需要已安装 Chromium。
