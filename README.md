# playwright-gen

从 URL 或 **Electron 应用** + 自然语言描述，自动生成**可运行**的 Playwright（TypeScript / `@playwright/test`）测试用例。主模型 DeepSeek，视觉用 Qwen；Agent 层直接用 Vercel AI SDK。

一个通用命令，不分版本：Agent 在真实浏览器/应用里**逐步骤**操作，引擎记录每一步真正成功的操作与断言，确定性渲染成**一个用例文件**，再用全新上下文回放验证（clean-replay），失败自动带日志重试。

## 快速开始

```bash
npm install
npx playwright install chromium   # 首次需要
cp .env.example .env              # 填入 DeepSeek / Qwen 凭据
```

`.env`（DeepSeek 为主；Qwen 仅 `--vision` 时用）：

```env
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat        # 需支持 function calling（deepseek-reasoner 不支持）
QWEN_BASE_URL=https://.../compatible-mode/v1
QWEN_API_KEY=sk-...
QWEN_MODEL=qwen-vl-plus             # 多模态，仅 --vision 用
MAX_STEPS=30                        # 每个步骤的探索轮数预算
```

运行（`npx tsx src/cli.ts ...`，或 `npm run pwgen -- ...`）：

```bash
# 简单页面：一句话描述
npx tsx src/cli.ts --url "file://$PWD/examples/01_static_form.html" \
  --description "验证标题包含 Acme 周刊，邮箱输入框和订阅按钮都可见"

# 动态/交互（SPA 弹窗）
npx tsx src/cli.ts --url "file://$PWD/examples/03_spa_modal.html" \
  --description "打开设置弹窗，开启深色模式，点击保存，验证出现'设置已保存'提示"

# 多步骤场景：用"步骤N："标注，逐步执行、全部生成进同一个用例（test.step 分块）
npx tsx src/cli.ts --url "file://$PWD/examples/04_login_app.html" \
  --description "步骤1：用 admin/secret 登录，预期看到概览欢迎语。步骤2：切到订单标签，预期看到订单列表。步骤3：切到设置标签，预期有退出按钮。"

# 图标 UI 可加视觉辅助
npx tsx src/cli.ts --vision --url "file://$PWD/examples/02_visual_icons.html" \
  --description "验证工具栏有保存、删除、分享三个图标按钮"
```

可选参数：`--vision`、`--headed`、`--max-steps N`（每步骤轮数预算）、`--max-repairs N`（失败重试轮数，默认 1）、`--trace`、`--name`、`--out-dir`。

## 多步骤描述（核心用法）

描述里用 `步骤1：… 步骤2：…`（或 `Step 1:`）标注，引擎会**确定性拆分**并逐步驱动：

- **每个步骤一个独立 Agent 对话、独立轮数预算**——步骤再多也不会因为对话过长被截断或被模型"忘掉"，杜绝"只生成前几步"；
- 步骤做不完会**显式失败并重试**（同会话重试一次 + 整轮重探），绝不静默跳过；
- 全部步骤按顺序生成进**同一个用例文件**，以 `test.step('步骤N：…')` 分块，报告里逐步可见；
- 步骤描述里含"预期/出现/显示…"时，引擎会**强制要求该步骤有断言**才算完成；
- 录制、加载、跳转等**耗时过程**由 `wait_for` 工具等待（最长 600s），等待连同超时一起记入用例，回放不会超时——用例总超时按轨迹自动计算（`test.setTimeout`）。

无步骤标注的描述则整段作为单一任务执行，行为不变。

### 命令行与本地文件（混合 UI + 环境操作）

步骤里可以要求执行 shell 命令或读写本地文件，与 UI 操作自由交错——典型场景：先用命令行操作设备，再回 UI 采集：

```bash
npx tsx src/cli.ts --url "http://localhost:8080" --description "\
步骤1：执行 hdc shell，依次输入 cd vendor/bin、counters gather xxx、exit，预期命令成功。\
步骤2：在页面上勾选对应配置，点击开始采集 trace，预期显示采集中。"
```

- `run_command`：一次性执行 shell 命令（POSIX 用 sh，Windows 用 cmd；需要 powershell 时写 `powershell -Command "…"`），支持给交互式 CLI（如 `hdc shell`）逐行输入 stdin；超时可设 1–600s。**退出码为 0 才记入用例**，回放时重跑同一命令并断言退出码为 0。
- `write_file`：把文本保存到本地文件（自动建父目录），记入用例并在回放时重写。
- `read_file`：读取文件内容供模型观察判断，不记入用例。
- 相对路径统一相对本次 run 目录解析（生成的用例按 spec 所在目录解析，两边一致）；生成用例所需的 `node:` import 与辅助函数**按需注入**，纯 UI 用例产物不变。

### 保存 / 导出文件（下载与原生保存对话框）

步骤里要求"点击保存，把 xxx.csv 保存到当前路径"时，Agent 用 `click_and_save`（而非普通 click）完成：

- **web**：接住 Playwright 的 download 事件并 `saveAs` 到指定文件——不接的话下载只会进临时目录，随浏览器上下文关闭被删除，文件永远不会出现在期望路径；
- **Electron**：自动在主进程 stub `dialog.showSaveDialog(Sync)` 直接返回目标路径——原生保存对话框不在 DOM 里，Playwright 看不见也点不到，stub 是唯一可自动化的方式；应用自行写盘的场景轮询等文件出现；
- 文件**真实落盘才记入用例**（同名旧文件先删除，防止上次残留被误判为保存成功）；回放时重演点击并断言文件生成；
- 保存路径相对本次 run 目录解析（生成用例按 spec 所在目录），与 `run_command` / `write_file` 一致；
- 步骤文案含"保存/导出/下载"时，引擎强制该步骤有可回放的验证——成功的 `click_and_save` 本身就是验证。

### Electron 应用

用 `--electron-bin` 指向**打包后的可执行文件**，其余与 web 相同——**Playwright 的 Electron 驱动跨平台**：macOS 传 `.app`（自动解析内部二进制），Windows 传 `.exe`，Linux 传可执行文件。引擎在应用窗口里用同一套 ARIA/ref 快照与忠实定位探索，生成的用例通过 `_electron.launch({ executablePath })` 启动应用回放。

```bash
# Windows（多步骤 GPU Profiler 场景示例）
npx tsx src/cli.ts --electron-bin "C:\Program Files\Graphics Profiler\Graphics Profiler.exe" \
  --description "步骤1：点击Record trace，在Target device处选择一个设备进行连接，设备连接成功后会出现Application to profile，选择一个vulkan应用。步骤2：在Probes下面点击Disable all，然后在Application下选择GPU API Events，点击Start Session，再点击Start Recording，录制结束后预期自动跳转到Timeline页面。步骤3：……"
# macOS：  --electron-bin "/Applications/YourApp.app"
# Linux：  --electron-bin "/opt/YourApp/yourapp"
# 启动参数：--electron-args "--flag1 --flag2"（CI 无沙箱环境可加 --no-sandbox）
```

生成的 Electron 用例形如：

```ts
import { test, expect, _electron as electron } from '@playwright/test';

test('…', async () => {
  test.setTimeout(287000);
  const electronApp = await electron.launch({ executablePath: 'C:\\Program Files\\…\\Graphics Profiler.exe', args: [] });
  try {
    const page = await electronApp.firstWindow();
    await test.step('步骤1：点击Record trace，在Target device处选择一个设备进行连接…', async () => {
      await page.getByRole('button', { name: 'Record trace' }).click();
      // …
    });
    await test.step('步骤2：…', async () => {
      // …
      await expect(page.getByText('Timeline').nth(0)).toBeVisible({ timeout: 180000 }); // wait_for 记录的长等待
    });
  } finally {
    await electronApp.close();
  }
});
```

## 真实站点示例（公开网站）

```bash
npx tsx src/cli.ts --url "https://the-internet.herokuapp.com/login" \
  --description "用户名填 tomsmith，密码填 SuperSecretPassword!，点击 Login，验证出现 You logged into a secure area"

npx tsx src/cli.ts --url "https://www.saucedemo.com/" \
  --description "步骤1：用 standard_user/secret_sauce 登录，预期看到 Products 标题。步骤2：把 Sauce Labs Backpack 加入购物车，预期该按钮变为 Remove。"
```

## 运行 / 调试生成的用例

生成过程本身已用全新浏览器上下文跑通了用例（clean-replay），所以"生成通过"即"可回放通过"。产物在 `output/<run>/` 下，每个 run 目录自带一份极简 `playwright.config.ts`（`testDir: '.'`）——**进入该目录直接用 Playwright 跑即可**：

```bash
cd output/<run>                               # 例如 output/20260715_103000
npx playwright test                           # 跑生成的用例
npx playwright test --headed                  # 有头模式观察
npx playwright test --debug                   # 单步调试（Playwright Inspector）
npx playwright test --ui                      # UI 模式
```

说明：

- 生成的用例里 URL / Electron `executablePath` 都是**绝对路径**，可独立回放；但请在**本项目目录内**运行——用例 `import { test } from '@playwright/test'`，依赖仓库的 `node_modules`。
- 从仓库根目录直接 `npx playwright test output/<run>/xxx.spec.ts` **不会命中**（根 `playwright.config.ts` 的 `testDir` 是 `./tests`）：请 `cd` 进 run 目录，或显式指定 `-c output/<run>/playwright.config.ts`。

## 架构

```
src/
├── cli.ts         # 单命令入口（commander）：--url | --electron-bin + --description
├── engine.ts      # 通用引擎：步骤拆分 → 逐步骤 Agent 探索（AI SDK 工具循环）→ 回放 → 修复
├── browser.ts     # Session：统一 web/electron 的 ARIA+ref 快照、忠实定位、操作/等待/断言
├── trajectory.ts  # 结构化轨迹：LocatorDescriptor / Step / TargetSpec（含 stepStart 分组标记）
├── locators.ts    # 定位描述符推导 + 渲染（纯函数，可单测）
├── codegen.ts     # 轨迹 → @playwright/test 代码（web/electron 两形态、test.step 分块、超时计算）
├── runner.ts      # 用 playwright test 裁判（clean-replay）
├── models.ts      # deepseek（主）/ qwen（视觉）：createOpenAICompatible
└── vision.ts      # --vision 时用 Qwen 看截图返回文本
examples/          # 基准页面（静态 / 图标 / SPA 弹窗 / 登录后台）
tests/             # 纯逻辑单测（步骤拆分 / locators / codegen）
```

## 关键设计

- **引擎持有步骤清单（不是模型）**：多步骤描述被确定性拆分，引擎逐个驱动，每步独立对话与预算。把整个场景塞进一个长对话时，模型会在步数上限或注意力上飘走、静默丢掉后面的步骤——这是旧版的核心缺陷，靠架构而非提示词解决。
- **忠实定位（execute == record）**：探索时先据元素元数据推导语义定位描述符（role+name > getByLabel > placeholder > testid > role+nth），再用 Playwright **自己的枚举**校验它唯一命中到该元素（必要时按真实序号修复 nth），只有校验通过才执行并记录。因此"生成代码里的定位 === 探索时真正点中的定位"。`data-pwref` 仅作 Agent 寻址句柄。
- **轨迹 → 代码**：代码来自探索中**真正成功执行**的操作轨迹（结构化描述符），按 `TargetSpec` 确定性渲染为 web 或 electron 形态——产出即"已验证可回放"，LLM 不直接写代码。
- **长等待是一等公民**：`wait_for` 等待录制/加载/跳转等耗时过程（最长 600s），作为带 timeout 的断言记入用例；`test.setTimeout` 按轨迹（动作数 + 各断言超时）自动计算，探索通过的用例回放不会因超时误判。
- **verify → repair**：生成后用全新上下文 clean-replay；失败把日志回灌、重新探索（默认 1 轮修复，`--max-repairs` 可调）。
- **Agent 层 = Vercel AI SDK**：`generateText` + 工具 + `stopWhen`（每步骤轮数上限 / step_done 完成标志）。未引入更重的 Agent 框架。

## 安全边界

生成的用例会在真实浏览器/应用中执行；作为服务使用需容器隔离。
