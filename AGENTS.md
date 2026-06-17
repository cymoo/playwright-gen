# playwright-gen

用 lovia 构建的 CLI 工具：输入入口 URL + 自然语言描述，自动生成可运行的 pytest-playwright 测试用例。

## 架构

**应用层控制 Generate→Run→Fix 循环**，lovia Agent 每轮只负责生成/修复代码，返回结构化 `GeneratedTest(code, notes)`；pytest 执行和文件写入由 `cli.py` 掌控。

```
用户输入 (url + description)
    │
    ▼
snapshot.py         → 用 playwright 抓取页面结构（按钮/输入框/链接/aria 信息）
    │
    ▼
cli.py 循环（最多 MAX_RETRIES 轮）
    ├── agent.py    → lovia Agent，output_type=GeneratedTest，读取 prompts/generate.md
    ├── sanitizer.py → strip fence + AST 校验（导入/test_函数/page.goto）
    ├── runner.py   → sys.executable -m pytest，timeout=60s，保留 head+tail
    └── 失败 → 把 previous_code + traceback 回灌下一轮
```

## 文件说明

| 文件 | 职责 |
|------|------|
| `main.py` | 薄入口，委托 `playwright_gen.cli:main` |
| `playwright_gen/cli.py` | CLI 入口（`--url`, `--description`, `--out-dir`, `--wait-ms`）+ 控制循环 |
| `playwright_gen/snapshot.py` | `snapshot_page(url, out_dir, wait_ms)` → dict（含截图/HTML 路径） |
| `playwright_gen/sanitizer.py` | `sanitize_code(raw)` → 去 fence + AST 校验 |
| `playwright_gen/runner.py` | `run_pytest(test_file, timeout=60)` → (bool, str) |
| `playwright_gen/agent.py` | `make_agent()` + `GeneratedTest(code, notes)` Pydantic model |
| `playwright_gen/prompts/generate.md` | Agent system prompt（独立管理） |

## 环境变量（.env）

```
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=sk-...
MODEL=openai:deepseek-v4-flash
MAX_RETRIES=5
```

lovia 的 `openai:` 前缀表示使用 OpenAI 协议；`OPENAI_BASE_URL` 会被 lovia OpenAI provider 自动读取，可对接 DeepSeek、OpenRouter 等兼容接口。

## 运行方式

```bash
# 安装
uv sync
uv run playwright install chromium

# 运行（示例：Bing 搜索）
uv run python main.py \
  --url "https://www.bing.com" \
  --description "在搜索框输入关键词 playwright，提交搜索，验证结果页存在搜索结果条目"

# 通过控制台入口运行
uv run playwright-gen \
  --url "https://www.bing.com" \
  --description "在搜索框输入关键词 playwright，提交搜索"

# 单独运行生成的测试
uv run pytest output/test_generated.py -v
```

## 当前状态

- 所有源文件已写完
- `uv sync` 安装依赖（首次运行时依赖可能未完全装好，重跑 `uv sync` 即可）
- Playwright chromium 已安装
- 尚未完成端到端冒烟测试（Bing 搜索用例）

## 已知注意事项

- 每次运行自动在 `--out-dir` 下创建时间戳子目录（或通过 `--name` 指定），不会互相覆盖
- `snapshot_page` 用 `domcontentloaded` + 1500ms 等待，对有长连接的页面更稳定
- `sanitizer.py` 用 AST 而非字符串匹配校验，避免注释里的 playwright 误判
- `runner.py` 用 `test_file.name` + `cwd=test_file.parent`，避免路径双重拼接 bug
- `TimeoutExpired` 已捕获，不会使 CLI 崩溃
- 安全边界：`ast.parse()` 只做语法校验，不是沙箱；本地 CLI 原型可用，做 Web 服务时需容器隔离
