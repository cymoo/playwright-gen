# playwright-gen

从 URL 或 **Electron 应用** + 自然语言描述，自动生成**可运行**的 Playwright（TypeScript / `@playwright/test`）测试用例。主模型 DeepSeek，视觉用 Qwen；Agent 层直接用 Vercel AI SDK。

工具按**目标复杂度**分 v1 → v3 三档，**每档都能独立运行**。核心原则是"用最小够用的复杂度"：目标简单时单次生成又快又稳，没必要动用 Agent；只有当"不操作就无法知道结果"时才升级。

> 本项目由 Python 版重构而来——改用 Node 是为了支持 **Electron**（Playwright 的 Electron 驱动仅 Node 端提供，Python API 没有）。

## 选哪个版本？（按目标复杂度）

| 目标复杂度 | 特征 | 版本 | 怎么做 |
|---|---|---|---|
| 简单 / 静态 | 元素初始即在 DOM、单页、无需登录 | **v1** | 富 ARIA 快照 → 单次 LLM 生成 |
| 视觉相关但静态 | 图标按钮 / 弱语义版式 | **v1 --vision** | 加 Qwen 看截图补充文字描述 |
| 动态 / 交互 | SPA、点击后才出现内容、弹窗、多步流程；**Electron 应用** | **v2** | Agent 真在浏览器/应用里操作 → 轨迹→代码 |
| 复杂应用 | 需登录、多视图、一句话要拆成多条用例 | **v3** | Planner 拆场景 → 逐个探索 → 套件 |

> 能力跳变在 **v1→v2**（静态 vs 必须交互）和 **v2→v3**（单流程 vs 应用/套件/鉴权）。Electron 应用天然属于 v2/v3。

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
MAX_RETRIES=5
MAX_STEPS=30
```

运行（`npx tsx src/cli.ts <版本> ...`，或 `npm run pwgen -- <版本> ...`）：

```bash
# v1 · 静态页：单次快照即可断言
npx tsx src/cli.ts v1 --url "file://$PWD/examples/01_static_form.html" \
  --description "验证标题包含 Acme 周刊，邮箱输入框和订阅按钮都可见"

# v1 · 图标 UI 用视觉：Qwen 读出 💾/🗑️/🔗 的含义
npx tsx src/cli.ts v1 --vision --url "file://$PWD/examples/02_visual_icons.html" \
  --description "验证工具栏有保存、删除、分享三个图标按钮"

# v2 · 动态/交互（SPA 弹窗）
npx tsx src/cli.ts v2 --url "file://$PWD/examples/03_spa_modal.html" \
  --description "打开设置弹窗，开启深色模式，点击保存，验证出现'设置已保存'提示"

# v3 · 登录 + 多场景套件
npx tsx src/cli.ts v3 --url "file://$PWD/examples/04_login_app.html" \
  --username admin --password secret \
  --description "登录后验证概览有欢迎语，订单标签能看到订单列表，设置标签有退出按钮"
```

可选参数：`--vision`、`--headed`、`--max-steps N`、`--trace`（v2/v3），`--name`、`--out-dir`。

### Electron 应用（v2 / v3）

用 `--electron-bin` 指向**打包后的可执行文件**（macOS 传 `.app` 会自动解析出内部二进制），其余与 web 相同。引擎在应用窗口里用同一套 ARIA/ref 快照与忠实定位探索，生成的用例通过 `_electron.launch({ executablePath })` 启动应用回放。

```bash
npx tsx src/cli.ts v2 --electron-bin "/Applications/YourApp.app" \
  --description "打开设置，切换到深色主题，验证出现深色标记"
# 需要启动参数时：--electron-args "--flag1 --flag2"
```

生成的 Electron 用例形如：

```ts
import { test, expect, _electron as electron } from '@playwright/test';

test('...', async () => {
  const electronApp = await electron.launch({ executablePath: '/Applications/YourApp.app/Contents/MacOS/YourApp', args: [] });
  const page = await electronApp.firstWindow();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByText('深色')).toBeVisible();
  await electronApp.close();
});
```

> Electron 代码路径已实现并通过类型检查与单测；因仓库不含打包二进制，需你用真实应用本地验证。

## 真实站点示例（公开网站，均已实测通过）

```bash
npx tsx src/cli.ts v1 --url "https://example.com" \
  --description "验证页面标题包含 Example Domain"

npx tsx src/cli.ts v2 --url "https://the-internet.herokuapp.com/login" \
  --description "用户名填 tomsmith，密码填 SuperSecretPassword!，点击 Login，验证出现 You logged into a secure area"

npx tsx src/cli.ts v3 --url "https://www.saucedemo.com/" \
  --username standard_user --password secret_sauce \
  --description "登录后验证 Products 标题可见；把 Sauce Labs Backpack 加入购物车后该按钮变为 Remove"
```

上面 v2 登录示例**实际生成**的用例（来自真实操作轨迹，已 clean-replay 通过）：

```ts
import { test, expect } from '@playwright/test';

test('测试登录到安全区域', async ({ page }) => {
  await page.goto('https://the-internet.herokuapp.com/login');
  await page.getByRole('textbox', { name: 'Username' }).fill('tomsmith');
  await page.getByRole('textbox', { name: 'Password' }).fill('SuperSecretPassword!');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('You logged into a secure area')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('/secure'));
});
```

## 运行 / 调试生成的用例

生成过程本身已用全新浏览器上下文跑通了每条用例（clean-replay），所以"生成通过"即"可回放通过"。产物在 `output/<run>/` 下，每个 run 目录会自带一份极简 `playwright.config.ts`（`testDir: '.'`）——**进入该目录直接用 Playwright 跑即可**：

```bash
cd output/<run>                               # 例如 output/20260701_181134
npx playwright test                           # 跑该目录下全部用例（v3 是整个套件）
npx playwright test test_generated.spec.ts    # 只跑某个文件
npx playwright test --headed                  # 有头模式观察
npx playwright test --debug                   # 单步调试（Playwright Inspector）
npx playwright test --ui                      # UI 模式
```

HTML 报告 / 查看 trace：

```bash
npx playwright test --reporter=html && npx playwright show-report
# 若生成时加了 --trace，run 目录下会有 trace_*.zip：
npx playwright show-trace trace_*.zip
```

说明：

- 生成的用例里 URL / Electron `executablePath` 都是**绝对路径**，可独立回放；但请在**本项目目录内**运行——用例 `import { test } from '@playwright/test'`，依赖仓库的 `node_modules`。
- 从仓库根目录直接 `npx playwright test output/<run>/xxx.spec.ts` **不会命中**（根 `playwright.config.ts` 的 `testDir` 是 `./tests`）：请 `cd` 进 run 目录，或显式指定 `-c output/<run>/playwright.config.ts`。

## 架构

```
src/
├── common/            # 薄共享层（各版本仅依赖它，版本间互不依赖）
│   ├── models.ts      # deepseek（主）/ qwen（视觉）：createOpenAICompatible
│   ├── vision.ts      # 用 Qwen 看图返回文本（DeepSeek 无视觉）
│   ├── trajectory.ts  # 结构化轨迹：LocatorDescriptor / Step / TargetSpec
│   ├── locators.ts    # 定位描述符推导 + 渲染（纯函数，可单测）
│   ├── browser.ts     # 【v2/v3】统一 web/electron 的 Session：ARIA+ref 快照 + 忠实定位 + 操作/断言
│   ├── codegen.ts     # 【v2/v3】轨迹 → @playwright/test 代码（web / electron 两形态）
│   ├── explore.ts     # 【v2/v3】AI SDK 工具 + Explorer 循环 + generateOne（探索→codegen→运行→修复）
│   ├── runner.ts      # 用 playwright test 裁判（clean-replay）
│   └── io.ts · sanitizer.ts
├── v1/                # 单次生成（generateObject）+ prompts/generate.md
├── v2/                # Agent 探索 CLI 入口
├── v3/                # planner（generateObject）+ 套件 CLI 入口
└── cli.ts             # 统一 pwgen v1|v2|v3（commander）
examples/              # 分层基准页面（① 静态 ② 图标 ③ SPA 弹窗 ④ 登录后台）
tests/                 # 纯逻辑单测（locators / codegen / sanitizer）
```

## 关键设计

- **忠实定位（execute == record）**：探索时先据元素元数据推导语义定位描述符，再用 Playwright **自己的枚举**校验它唯一命中到该元素（必要时按真实序号修复 nth），只有校验通过才执行并记录。因此"生成代码里的定位 === 探索时真正点中的定位"，且消除了手写可访问名近似导致的偏差；表单控件（含无 textbox role 的 password）额外用 `getByLabel` 兜底。`data-pwref` 仅作 Agent 寻址句柄。
- **轨迹 → 代码**：v2/v3 的代码来自探索中**真正成功执行**的操作轨迹（结构化描述符），按 `TargetSpec` 确定性渲染为 web 或 electron 两形态——产出即"已验证可回放"。
- **verify → repair**：生成后用全新上下文 clean-replay；失败把日志回灌、重新探索。
- **视觉 = Qwen 工具返回文本**：DeepSeek 无视觉，`--vision` 时由 Qwen 看图、以文字回传给 DeepSeek。
- **Agent 层 = Vercel AI SDK**：`generateText` + 工具 + `stopWhen`（步数上限 / `finalize` 触发）；结构化输出用 `generateObject`。未引入更重的 Agent 框架。

## 相对 Python 版的改动

- Python → **Node + TypeScript**（ESM，用 `tsx` 直跑）；pytest-playwright → **@playwright/test**（async/await）。
- 新增 **Electron** 目标（`--electron-bin`）；lovia → **Vercel AI SDK**；去掉了 v0 盲写基线与可选的 MCP 后端。
- 定位从"记录一个另行推导的表达式"升级为**忠实定位**（执行即记录、逐个校验唯一命中）。
- v1/v2/v3 共用同一套快照逻辑；探索不再用固定 sleep，改靠 Playwright 自动等待。

## 安全边界

`sanitizeCode()` 只做去 fence + 基本标记校验，不是沙箱。生成的用例会在真实浏览器/应用中执行；作为服务使用需容器隔离。
