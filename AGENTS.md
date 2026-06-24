# playwright-gen — 架构说明（for agents/devs）

自然语言 → 可运行 Playwright 用例。按**目标页面复杂度**分 v0→v3，每档可独立运行（`python -m vN`）。
设计原则：用最小够用的复杂度（见根 `README.md` 的"复杂度→版本"表）。

## 分层（Hybrid）

- `common/`：稳定、版本无关的共享层；各版本**仅依赖它**，版本之间互不依赖。
- `v0/`：重构前盲写基线（原样保留，回归对照）。
- `v1/`：单次生成（静态页）+ 可选视觉。
- `v2/`：Agent 驱动探索 + 轨迹→代码（动态页）。
- `v3/`：Planner 拆套件 + 登录/多视图 + 可选 MCP 后端（复杂应用）。

## common/ 模块

| 文件 | 职责 |
|---|---|
| `models.py` | `deepseek_model()`（主）/ `qwen_provider()`（视觉）；均 OpenAI 兼容 |
| `io.py` | 时间戳输出目录 |
| `runner.py` | `run_pytest()` 裁判（沿用 v0） |
| `sanitizer.py` | 去 fence + AST 校验（playwright 导入 / `test_` / `goto`） |
| `vision.py` | `describe_screenshot[_async]`：Qwen 看图返回文本 |
| `browser.py` | 【v2/v3】`BrowserSession`(async) + `snapshot()`(ARIA+ref) + `resolve`/`click`/`fill`/`assert_*` |
| `codegen.py` | 【v2/v3】`Trajectory`/`Step` → 同步 pytest-playwright 代码 |
| `explore.py` | 【v2/v3】lovia 工具 + Explorer Agent + `generate_one`（探索→codegen→校验→修复） |
| `mcp_explore.py` | 【v3 可选】`generate_one_mcp`：Playwright MCP 后端 |

## 关键技术决策

- **async 全程**：lovia 工具在事件循环/工作线程里执行，同步 Playwright 不安全 → v2/v3 用 async Playwright + async 工具 + `await Runner.run`。
- **视觉 = Qwen 工具返回文本**：DeepSeek 无视觉、且 lovia 工具返回值是纯文本 → `look()` 与 v1 视觉都走 Qwen 看图、以文字回传给 DeepSeek。
- **元素定位**：一段 JS 扫描可交互元素，算 role/可见名称/重名次数并打 `data-pwref`；实时操作用 `data-pwref`（每次快照前清旧的，避免碰撞），生成代码用据此推导的语义 locator（role+name > label > placeholder > testid > role.nth）；失败返回候选列表供 Agent 自纠。
- **轨迹→代码**：v2/v3 的代码来自探索中**真正成功**的操作轨迹，非 LLM 盲写 → 产出即可回放。
- **verify→repair**：clean-replay 失败把 traceback 回灌、重新探索；已覆盖"回放失败"，无需单独的自愈子系统。

## 运行与验证

```bash
uv sync ; uv run playwright install chromium
uv run python -m v1 --url "file://$PWD/examples/01_static_form.html" --description "..."
uv run python -m v1 --vision --url "file://$PWD/examples/02_visual_icons.html" --description "..."
uv run python -m v2 --url "file://$PWD/examples/03_spa_modal.html" --description "..."
uv run python -m v3 --username admin --password secret \
  --url "file://$PWD/examples/04_login_app.html" --description "..."
uv run python -m v3 --backend mcp ...     # 需 uv sync --extra mcp + Node/npx
```

`examples/` 是分层基准页面（① 静态 ② 图标 ③ SPA 弹窗 ④ 登录后台），用于验证每档在其复杂度上的表现，并演示低档在高档页面上的边界。

## gpt5.5 方案

`docs/plan-v2.md` 的方向被采纳并落地：其推迟的"轨迹→代码"提前到 v2，元素定位升级为 ARIA+ref，并修正了"同步 Playwright"与"Agent 看截图"两处与本技术栈不兼容的机制。详见根 `README.md`。
