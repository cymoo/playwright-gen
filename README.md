# playwright-gen

从 URL + 自然语言描述自动生成**可运行**的 Playwright 测试用例。基于 [lovia](https://github.com/cymoo/lovia) 框架，DeepSeek 为主模型，Qwen 提供视觉。

工具按**目标页面的复杂度**分成 v0 → v3 四档，**每一档都能独立运行**。核心原则是"用最小够用的复杂度"：页面简单时单次生成又快又稳，没必要动用 Agent 驱动浏览器；只有当页面"不操作就无法知道结果"时才升级。

## 选哪个版本？（按页面复杂度）

| 页面/任务复杂度 | 特征 | 版本 | 怎么做 |
|---|---|---|---|
| 简单 / 静态 | 元素初始即在 DOM、单页、无需登录 | **v1** | 富 ARIA 快照 → 单次 LLM 生成 |
| 视觉相关但静态 | 图标按钮 / 弱语义版式 | **v1 --vision** | 加 Qwen 看截图补充文字描述 |
| 动态 / 交互 | SPA、点击后才出现内容、弹窗、多步流程 | **v2** | Agent 真在浏览器里操作 → 轨迹→代码 |
| 复杂应用 | 需登录、多视图、一句话要拆成多条用例 | **v3** | Planner 拆场景 → 逐个探索 → 套件 |

> v0 是重构前的**盲写基线**（保留作回归对照）。真正的能力跳变在 **v1→v2（静态 vs 必须交互）** 和 **v2→v3（单流程 vs 应用/套件/鉴权）**。

## 快速开始

```bash
uv sync                              # 安装依赖
uv run playwright install chromium   # 首次需要
# .env 见下方；然后任选一个版本：
uv run python -m v1 --url <URL> --description "<描述>"
uv run python -m v2 --url <URL> --description "<描述>"
uv run python -m v3 --url <URL> --description "<描述>"
```

`.env`（DeepSeek 为主；Qwen 仅 `--vision` 时用）：

```env
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=sk-...
MODEL=openai:deepseek-v4-flash
QWEN_BASE_URL=https://.../compatible-mode/v1
QWEN_API_KEY=sk-...
QWEN_MODEL=qwen3.7-plus
MAX_RETRIES=5
```

仓库自带分层基准页面 `examples/`（静态表单 / 图标 / SPA 弹窗 / 登录后台），下面的示例直接用它们。

## 各版本

### v0 — 盲写基线（重构前实现，原样保留）
`快照 JSON → LLM 盲写代码 → pytest 裁判 → 失败回灌重试`。一次性看一段文本就写代码，看不到交互后的页面。作为回归基准。
```bash
uv run python -m v0 --url "https://example.com" --description "点击 Learn more 链接"
```

### v1 — 单次生成做对（简单/静态页）
用 Playwright 的 **ARIA 无障碍树**（role+可见名称+层级）替代 v0 的粗糙提取；`--vision` 时先用 **Qwen 看截图**生成文字描述补充上下文。仍是单次生成 + 校验/重试，便宜、无多轮工具调用风险。
```bash
uv run python -m v1 --url "file://$PWD/examples/01_static_form.html" \
  --description "验证标题为 Acme 周刊，邮箱输入框和订阅按钮都可见"
# 图标 UI 用视觉：Qwen 能读出 💾/🗑️/🔗 的含义
uv run python -m v1 --vision --url "file://$PWD/examples/02_visual_icons.html" \
  --description "验证工具栏有保存、删除、分享三个图标按钮"
```
**边界**：v1 只看初始静态快照。对"点击后才出现的内容"它会**诚实地**只断言可见元素并在 notes 里说明无法验证的部分——这正是该升级到 v2 的信号。

### v2 — Agent 驱动探索（动态/交互页）
Agent（DeepSeek）在**真实浏览器**里像测试员一样操作：观察（ARIA + ref 快照）→ 点击/输入/断言 → 看新状态。引擎**自动记录每一步真正命中的 locator**，`finalize` 后由 codegen **确定性**渲染为同步 pytest 用例——产出即"已验证可回放"，再做全新浏览器 clean-replay 校验；失败则回灌 traceback 让 Agent 重新探索。
```bash
uv run python -m v2 --url "file://$PWD/examples/03_spa_modal.html" \
  --description "打开设置弹窗，开启深色模式，点击保存，验证出现'设置已保存'提示"
```
可选：`--vision`（Qwen `look` 工具）、`--max-steps N`、`--headed`、`--trace`。

### v3 — 规划 + 套件（复杂应用）
相对 v2 只多一个 **Planner**：把一句话拆成多个**自包含、各自聚焦**的场景（登录等前置并入每个场景，保证每条用例可独立运行），逐个走 v2 引擎，汇总成测试**套件**。
```bash
uv run python -m v3 --url "file://$PWD/examples/04_login_app.html" \
  --username admin --password secret \
  --description "登录后验证概览有欢迎语，订单标签能看到订单列表，设置标签有退出按钮"
# → 拆成 3 个场景，各自登录并断言，生成 3 个独立通过的用例
```
**可选 MCP 后端**：`--backend mcp` 改用官方 [Playwright MCP](https://github.com/microsoft/playwright-mcp) 驱动浏览器（最稳健的浏览器控制），用例由 LLM 依探索过程编写、经 pytest 校验+修复兜底。需 `uv sync --extra mcp` + Node/npx。
```bash
uv run python -m v3 --backend mcp --url "file://$PWD/examples/03_spa_modal.html" \
  --description "点击打开设置，验证弹出的设置对话框可见"
```
> inhouse（默认）：确定性轨迹→代码，通常一次过。 mcp：官方浏览器控制 + LLM 写码，靠校验/修复闭环保证可跑。

## 真实站点示例（公开网站，均已实测通过）

> 公开站点偶有改版/限流，命令仍然有效，必要时重试或更换站点。覆盖表单 / 点击 / 登录 / 动态内容等常见场景。

```bash
# v1 · 静态页：单次快照即可断言
uv run python -m v1 --url "https://example.com" \
  --description "验证页面标题包含 Example Domain"

# v2 · 表单 + 提交 + 登录（the-internet）
uv run python -m v2 --url "https://the-internet.herokuapp.com/login" \
  --description "用户名填 tomsmith，密码填 SuperSecretPassword!，点击 Login，验证出现 You logged into a secure area"

# v2 · 点击 + 动态内容（元素点击后才出现）
uv run python -m v2 --url "https://the-internet.herokuapp.com/add_remove_elements/" \
  --description "点击 Add Element 两次，验证出现 Delete 按钮"

# v3 · 登录 + 多场景套件（saucedemo 电商）
uv run python -m v3 --url "https://www.saucedemo.com/" \
  --username standard_user --password secret_sauce \
  --description "登录后验证 Products 标题可见；把 Sauce Labs Backpack 加入购物车后该按钮变为 Remove"

# 表单综合（httpbin 披萨订单：文本框/单选/复选/文本域）— httpbin 偶发 503，恢复后可用
uv run python -m v2 --url "https://httpbin.org/forms/post" \
  --description "Customer name 填 Alice，Pizza Size 选 Large，勾选 Bacon，点击 Submit order，验证结果页出现 Alice"
```

上面 v2 登录示例**实际生成**的用例（来自真实操作轨迹，已 clean-replay 通过）：

```python
import re
from playwright.sync_api import Page, expect


def test_测试登录到安全区域(page: Page):
    """填用户名/密码并登录，验证进入安全区域"""
    page.goto('https://the-internet.herokuapp.com/login')
    page.get_by_role("textbox", name="Username").fill('tomsmith')
    page.get_by_role("textbox", name="Password").fill('SuperSecretPassword!')
    page.get_by_role("button", name="Login").click()
    expect(page.get_by_text("You logged into a secure area")).to_be_visible()
    expect(page).to_have_url(re.compile('/secure'))
```

## 架构

```
common/                # 薄共享层（所有版本仅依赖它，版本间互不依赖）
├── models.py          # deepseek_model() / qwen_provider()
├── io.py · runner.py · sanitizer.py
├── vision.py          # 用 Qwen 看图返回文本（deepseek 无视觉）
├── browser.py         # 【v2/v3】async Playwright 会话 + ARIA ref 快照 + 元素解析器
├── codegen.py         # 【v2/v3】轨迹 → 同步 pytest-playwright 代码
├── explore.py         # 【v2/v3】lovia 工具 + Explorer Agent + generate_one 流水线
└── mcp_explore.py     # 【v3 可选】Playwright MCP 后端
v0/ v1/ v2/ v3/        # 各版本的 CLI 与特有逻辑（python -m vN）
examples/              # 分层基准页面
```

关键设计（与下文 gpt5.5 报告评估对应）：
- **视觉 = Qwen 工具返回文本**：DeepSeek 不具备视觉，且 lovia 工具返回值是纯文本，故视觉统一由 Qwen 看图、以文字回传给 DeepSeek。
- **async 全程**：lovia 工具在事件循环里执行，同步 Playwright 会出问题，故 v2/v3 引擎用 async Playwright。
- **轨迹→代码**：v2/v3 的代码来自探索中真正成功的操作轨迹，而非 LLM 凭记忆盲写。

## 对 `docs/plan-v2.md`（gpt5.5 方案）的评估

方向正确并被采纳：Agent 交互式探索、语义定位优先、失败给候选列表、浏览器长连接、视觉可选、max-steps 防死循环。
本实现的修正：
1. 把它推迟到"未来"的**轨迹→代码**提前到 v2（最大质量杠杆）。
2. 元素定位从"文本包含"升级为 **ARIA 无障碍树 + ref 寻址**。
3. 修正其 `BrowserSession` 用同步 Playwright（在 lovia async 循环里会出错）→ 改 async。
4. 修正其视觉机制（Agent 调 screenshot 看图）：lovia 工具返回纯文本且 DeepSeek 无视觉 → 改为 Qwen 工具返回文本。
5. 断言升级为一等公民（assert_* 工具实时校验且记入轨迹）。

## 安全边界

`sanitize_code()` 仅做 AST 语法校验，不是沙箱。本地 CLI 原型可用；作为 Web 服务需容器隔离。生成的用例会在真实浏览器执行。
