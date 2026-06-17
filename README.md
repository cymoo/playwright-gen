# playwright-gen

从 URL + 自然语言描述自动生成可运行的 Playwright 测试用例。基于 [lovia](https://github.com/cymoo/lovia) 驱动 LLM 生成测试代码，并通过 pytest 执行 → 失败自动修复的闭环迭代。

## 架构

```
用户输入 (url + description)
    │
    ▼
snapshot.py         → 用 Playwright 抓取页面结构（按钮/输入框/链接/aria 信息）
    │
    ▼
cli.py 循环（最多 MAX_RETRIES 轮）
    ├── agent.py    → lovia Agent，output_type=GeneratedTest，读取 prompts/generate.md
    ├── sanitizer.py → 去 markdown fence + AST 校验（导入/test_函数/page.goto）
    ├── runner.py   → pytest 执行，timeout=60s，保留 head+tail
    └── 失败 → 把 previous_code + traceback 回灌下一轮
```

## 文件结构

```
playwright-gen/
├── main.py                         # 入口（thin），委托 playwright_gen.cli:main
├── pyproject.toml                  # 项目配置 + 依赖 + 控制台入口
├── playwright_gen/
│   ├── __init__.py                 # 包初始化，导出核心函数
│   ├── cli.py                      # CLI 参数解析 + 生成→运行→修复主循环
│   ├── agent.py                    # lovia Agent 工厂 + GeneratedTest 模型
│   ├── runner.py                   # run_pytest() — 执行 pytest 并返回结果
│   ├── sanitizer.py                # sanitize_code() — 去掉 markdown fence + AST 校验
│   ├── snapshot.py                 # snapshot_page() — Playwright 抓取页面快照
│   └── prompts/
│       └── generate.md             # Agent system prompt（选择器策略、代码规范）
└── README.md
```

| 文件 | 职责 |
|------|------|
| `playwright_gen/cli.py` | CLI 入口（`--url`, `--description`, `--out-dir`, `--wait-ms`）+ 控制循环 |
| `playwright_gen/snapshot.py` | `snapshot_page(url, out_dir, wait_ms)` → dict（含截图/HTML 路径） |
| `playwright_gen/sanitizer.py` | `sanitize_code(raw)` → 去 fence + AST 校验 |
| `playwright_gen/runner.py` | `run_pytest(test_file, timeout=60)` → (passed: bool, output: str) |
| `playwright_gen/agent.py` | `make_agent()` + `GeneratedTest(code, notes)` Pydantic 模型 |
| `playwright_gen/prompts/generate.md` | Agent system prompt（独立管理） |

## 环境要求

- Python >= 3.11
- [uv](https://docs.astral.sh/uv/)（推荐）或 pip
- Playwright Chromium 浏览器

## 安装

```bash
# 克隆仓库
git clone <repo-url> && cd playwright-gen

# 安装依赖
uv sync

# 安装 Chromium 浏览器（首次使用需要）
uv run playwright install chromium
```

## 环境变量

在项目根目录创建 `.env` 文件（参考 `.env.example`）：

```env
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=sk-...
MODEL=openai:deepseek-v4-flash
MAX_RETRIES=5
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENAI_BASE_URL` | OpenAI 兼容 API 地址 | — |
| `OPENAI_API_KEY` | API 密钥 | — |
| `MODEL` | 模型标识（`openai:` 前缀表示 OpenAI 协议） | — |
| `MAX_RETRIES` | 最大重试轮数 | `5` |

`lovia` 的 `openai:` 前缀表示使用 OpenAI 兼容协议；`OPENAI_BASE_URL` 会被 lovia OpenAI provider 自动读取，可对接 DeepSeek、OpenRouter、OpenAI 等兼容接口。

## 用法

### 命令行

```bash
# 方式一：通过 main.py
uv run python main.py --url <URL> --description "<描述>"

# 方式二：通过控制台入口（pip install 后可用）
uv run playwright-gen --url <URL> --description "<描述>"

# 单独运行生成的测试
uv run pytest output/test_generated.py -v
```

### 参数

| 参数 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `--url` | 是 | 目标页面 URL | — |
| `--description` | 是 | 用自然语言描述要验证的行为 | — |
| `--out-dir` | 否 | 输出根目录，每次运行会在其下自动创建子目录 | `./output` |
| `--wait-ms` | 否 | `domcontentloaded` 后额外等待毫秒数 | `1500` |
| `--name` | 否 | 本次运行的子目录名（默认用时间戳，如 `20260617_163000`） | 时间戳 |

每次运行都会在 `--out-dir` 下自动创建独立的子目录（默认以时间戳命名），因此多次运行不会互相覆盖。可通过 `--name` 自定义子目录名。

## 示例

### 示例 1：验证页面跳转

```bash
uv run python main.py \
  --url "https://example.com" \
  --description "点击 Learn more，跳转的页面包含 Further Reading 文本"
```

生成的测试会对 `example.com` 拍快照，找到 "Learn more" 链接并点击，然后断言目标页面包含 "Further Reading"。

### 示例 2：搜索表单测试

```bash
uv run python main.py \
  --url "https://www.baidu.com" \
  --description "在搜索框输入关键词 playwright，提交搜索，验证结果页存在搜索结果条目"
```

### 示例 3：登录表单验证

```bash
uv run python main.py \
  --url "https://the-internet.herokuapp.com/login" \
  --description "不输入任何内容直接点击 Login 按钮，验证页面显示用户名或密码无效的错误提示"
```

### 示例 4：自定义输出目录和等待时间

```bash
uv run python main.py \
  --url "https://httpbin.org/forms/post" \
  --description "填写表单，选择 pizza 作为 topping，填写备注，提交后验证页面显示成功信息" \
  --out-dir "./results/httpbin" \
  --wait-ms 3000
```

### 示例 5：使用 --name 避免覆盖

```bash
# 第一次运行 — 自动生成时间戳子目录，如 output/20260617_163000/
uv run python main.py \
  --url "https://example.com" \
  --description "点击 Learn more，跳转的页面包含 Further Reading 文本"

# 第二次运行 — 指定名称，输出到 output/learn-more/
uv run python main.py \
  --url "https://example.com" \
  --description "点击 Learn more，跳转的页面包含 Further Reading 文本" \
  --name "learn-more"

# 每次运行的结果互不覆盖：
#   output/
#   ├── 20260617_163000/
#   │   ├── screenshot.png
#   │   ├── page.html
#   │   └── test_generated.py
#   └── learn-more/
#       ├── screenshot.png
#       ├── page.html
#       └── test_generated.py
```

## 工作原理

1. **快照阶段** — `snapshot.py` 使用 Playwright 打开目标 URL，提取页面元素（按钮、输入框、链接及 aria 信息），保存截图和 HTML 到输出目录。

2. **生成阶段** — `agent.py` 创建 lovia Agent，将页面快照和用户描述发送给 LLM，要求返回结构化的 `GeneratedTest(code, notes)`。

3. **校验阶段** — `sanitizer.py` 去除 markdown fence，用 AST 校验代码是否包含 playwright 导入、`test_` 函数和 `page.goto()` 调用。

4. **运行阶段** — `runner.py` 执行 `pytest`，若通过则保存测试文件；若失败则将错误日志和上次代码回灌给 LLM，进入下一轮修复。

5. **重试循环** — 最多 `MAX_RETRIES` 轮，每轮 LLM 都收到完整的上下文（快照 + 描述 + 上次代码 + 失败日志），逐步修复直到通过或耗尽重试次数。

## 设计决策

- **选择器优先级**: `get_by_role()` > `get_by_label()` > `get_by_text()` > `data-testid` > CSS — 优先使用语义化选择器，提高测试可维护性。
- **AST 校验而非字符串匹配**: 避免注释中的 `playwright` 字符串误判，精准检查语法结构。
- **独立 test function**: 每个测试用例独立（共享 `page` fixture），不依赖执行顺序。
- **安全边界**: `ast.parse()` 仅做语法校验，非沙箱。本地 CLI 原型使用安全；若作为 Web 服务需容器隔离。
