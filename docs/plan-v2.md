# Plan v2：Agent 驱动浏览器 + 可选视觉

## 1. 背景与动机

### 当前 v1 模式的根本限制

```
用户输入 → 快照 JSON → LLM 盲写代码 → pytest 裁判 → 失败则重试
```

LLM **全程只看过一次 JSON 文本**，没有机会"操作一下试试"。后果：

- 快照是高度简化的"菜单"，丢失 DOM 层级、CSS 可见性细节、iframe/Shadow DOM
- 无法处理弹窗、模态框、SPA 动态渲染、hover 触发的元素
- 每个失败都必须走完整的"改代码 → 跑 pytest"循环，反馈慢

### 改进方向（上一轮讨论）

| 级别 | 做法 | 状态 |
|------|------|------|
| L1 视觉 | 截图发给 vision 模型，与 DOM 快照互补 | 可选（视觉模型不一定可用） |
| L2 Agent 操作浏览器 | Agent 有 Playwright 工具，感知→行动→观察→下一步 | 本次核心 |
| L3 两阶段固化 | 探索成功后，把操作序列总结成可复用测试代码 | 后续迭代 |

本次计划覆盖 **L1（可选）+ L2**。

---

## 2. 目标架构

### 2.1 整体流程

```
用户输入: --url + --description [--vision]
    │
    ▼
┌─────────────────────────────────────────────────┐
│ BrowserSession (长连接浏览器)                     │
│   └─ page (Playwright Page, 整个探索期存活)        │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Explorer Agent (lovia Agent + tools)             │
│                                                   │
│  循环:                                            │
│   1. 观察 → get_page_state() / screenshot()       │
│   2. 行动 → click() / type_text() / navigate() …  │
│   3. 观察结果                                     │
│   4. 判断: 继续探索 or finalize()                  │
│                                                   │
│  终止: Agent 调用 finalize(code, notes)            │
└─────────────────────────────────────────────────┘
    │
    ▼
  sanitize_code() → pytest 验证 → 通过则保存
                        │
                        └─ 失败 → 回灌 traceback 再修
```

### 2.2 两种运行模式

| 模式 | 触发 | 行为 |
|------|------|------|
| **explore**（默认） | `--mode explore`（默认值） | Agent 用工具交互式操作浏览器，观察 DOM 快照 |
| **explore --vision** | `--mode explore --vision` | 同上，但截图发给 vision 模型辅助判断 |
| **blind**（v1 兼容） | `--mode blind` | 传统模式：快照 JSON → 盲写代码，无交互 |

---

## 3. 核心组件设计

### 3.1 `browser.py` — BrowserSession

职责：管理 Playwright 浏览器长连接，对外暴露 `page` 对象和便捷方法。

```python
class BrowserSession:
    """Context manager，保持浏览器在 Agent 探索期存活"""

    def __init__(self, headless: bool = True):
        self.headless = headless
        self.playwright = None
        self.browser = None
        self.page = None

    def __enter__(self) -> "BrowserSession":
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(headless=self.headless)
        self.page = self.browser.new_page()
        self._attach_console_listener()
        return self

    def __exit__(self, ...):
        self.browser.close()
        self.playwright.stop()
```

关键方法（供工具函数调用）：

| 方法 | 说明 |
|------|------|
| `goto(url)` | 导航，返回是否成功 |
| `get_state()` | 返回当前页面的 DOM 摘要（元素列表 + 可见性），复用现有 snapshot 逻辑 |
| `screenshot(path)` | 截图保存到输出目录，返回路径（给 vision 模型用） |
| `find_and_click(description)` | 根据描述定位元素并点击（LLM 说"点登录按钮"，这里执行） |

关于 `find_and_click`：这是关键设计点。Agent 描述"我要点击什么"，实际定位由 Playwright 执行。策略：

1. 先用 `get_by_role()` + 文本内容匹配
2. 再用 `get_by_text()` 模糊匹配
3. 再用 CSS 选择器兜底
4. 返回操作结果（成功/失败 + 新页面状态摘要）

### 3.2 `tools.py` — Agent 工具集

定义 lovia Agent 可调用的工具函数。每个工具接收当前 `BrowserSession` 和参数，返回观测文本。

```python
# 工具列表（lovia function-calling 注册给 Agent）

def navigate(url: str) -> str:
    """导航到指定 URL，返回页面标题和可交互元素摘要"""
    ...

def click(target: str) -> str:
    """
    点击页面元素。target 是自然语言描述，如"登录按钮"、"Learn more 链接"。
    返回点击后的页面变化摘要。
    """
    ...

def type_text(target: str, text: str) -> str:
    """
    在输入框中输入文本。target 描述输入框，如"搜索框"、"用户名字段"。
    返回输入后的状态。
    """
    ...

def get_page_state() -> str:
    """获取当前页面的完整 DOM 摘要（可见元素列表、URL、标题）"""
    ...

def screenshot() -> str:
    """截取当前页面截图，返回文件路径供 vision 模型读取"""
    ...

def wait(ms: int) -> str:
    """等待指定毫秒数，返回等待后的页面状态摘要"""
    ...

def scroll(direction: str) -> str:
    """滚动页面，direction: 'up' | 'down' | 'top' | 'bottom'"""
    ...

def press_key(key: str) -> str:
    """按下键盘按键，如 'Enter', 'Escape', 'Tab'"""
    ...

def finalize(code: str, notes: str) -> str:
    """
    任务完成，提交最终 Playwright 测试代码。
    code: 完整 Python 测试文件内容（不含 markdown fence）
    notes: selector 选择策略和已知限制
    """
    ...
```

### 3.3 Agent 如何定位元素（find_and_click / find_and_type）

这是整个方案最难的部分。Agent 说"点击搜索按钮"，我们要找到它。

**策略：Agent 给出的是语义描述，我们用 Playwright 定位**

```
Agent: click("搜索按钮")
       │
       ▼
tools.click(target="搜索按钮")
       │
       ▼
  1. text_content 包含 "搜索" 的 <button> → hit
  2. aria-label 包含 "搜索" 的元素 → hit
  3. get_by_text("搜索") → hit
  4. 都没找到 → 列出当前所有 button 文本，让 Agent 再选
```

**关键：失败时给 Agent 足够信息重试**

当定位失败，返回的不是简单的 "not found"，而是：
```
未找到包含"搜索"的按钮。当前页面按钮有：
  - "百度一下" (button)
  - "手气不错" (link)
请从以上选项中选择，或使用更精确的描述。
```

这样 Agent 可以自适应地调整。

### 3.4 `explorer.py` — 探索循环

职责：创建带工具的 lovia Agent，运行感知-行动循环。

```python
def run_explore(
    url: str,
    description: str,
    out_dir: Path,
    vision: bool = False,
    max_steps: int = 30,
) -> GeneratedTest:
    """
    启动交互式探索循环。
    
    1. 打开浏览器
    2. 创建 Explorer Agent（带工具）
    3. Agent 自主操作，直到调用 finalize()
    4. 返回 GeneratedTest
    """
    with BrowserSession() as session:
        session.goto(url)
        
        agent = make_explorer_agent(vision=vision)
        prompt = build_explore_prompt(url, description)
        
        # lovia Runner 执行 agent + prompt
        # Agent 会在工具调用循环中自主操作浏览器
        result = Runner.run_sync(agent, prompt)
        
        # result.output 是 finalize() 提交的 GeneratedTest
        return result.output
```

### 3.5 Agent System Prompt 设计

`prompts/explore.md`：

核心指令差异：

```
你现在是一个可以**实际操作浏览器**的测试工程师。

你有以下工具可用：
- navigate(url)   — 打开页面
- click(target)    — 点击元素
- type_text(target, text) — 输入文本
- get_page_state() — 查看当前页面状态
- screenshot()     — 截图（当 --vision 启用时可用）
- wait(ms)         — 等待
- scroll(direction) — 滚动
- press_key(key)   — 按键
- finalize(code, notes) — 提交最终测试代码

工作流程：
1. 页面已经打开到目标 URL
2. 先用 get_page_state() 了解当前页面有什么
3. 根据需求描述，逐步操作
4. 每次操作后观察结果，再决定下一步
5. 全部操作成功验证后，调用 finalize() 提交测试代码

定位元素时：
- 用 target 描述你要操作的元素（如"登录按钮"）
- 系统会自动匹配，如果匹配失败会列出候选项
- 若匹配失败，根据候选项调整 target

finalize 提交的 code 必须是完整的 pytest-playwright 测试文件：
- 包含 page.goto(url)
- 使用 get_by_role/get_by_text 等语义选择器
- 每个操作有对应的 expect 断言
- 不要包含 markdown fence
```

### 3.6 Vision 模式

当 `--vision` 启用时：

```python
def make_explorer_agent(vision: bool) -> Agent:
    tools = [navigate, click, type_text, get_page_state, wait, scroll, press_key, finalize]
    
    if vision:
        tools.append(screenshot)
        model = os.environ.get("VISION_MODEL", os.environ["MODEL"])
        instructions = VISION_PROMPT  # 告诉 Agent 可以用 screenshot() 辅助判断
    else:
        instructions = DOM_ONLY_PROMPT
    
    return Agent(
        name="test-explorer",
        instructions=instructions,
        model=model,
        tools=tools,
        output_type=GeneratedTest,
    )
```

Vision 模式下，Agent 在以下场景应主动截图：
- 元素定位失败，想看看页面的真实状态
- 断言前确认元素确实可见
- 页面变化后确认 DOM 快照和视觉一致

### 3.7 CLI 改动

```python
p.add_argument("--mode", choices=["explore", "blind"], default="explore",
               help="运行模式：explore=Agent 交互式操作浏览器, blind=v1 盲写代码")
p.add_argument("--vision", action="store_true",
               help="启用视觉模式（需视觉模型支持，仅 explore 模式有效）")
p.add_argument("--max-steps", type=int, default=30,
               help="探索模式最大步数")
p.add_argument("--headed", action="store_true",
               help="显示浏览器窗口（调试用）")
```

主流程路由：

```python
if args.mode == "explore":
    test = run_explore(args.url, args.description, out_dir, 
                        vision=args.vision, max_steps=args.max_steps)
else:
    # v1 blind mode
    test = run_blind(args.url, args.description, out_dir, args.wait_ms)
```

---

## 4. 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新增** | `playwright_gen/browser.py` | BrowserSession — 长连接浏览器管理 |
| **新增** | `playwright_gen/tools.py` | Agent 工具函数集 |
| **新增** | `playwright_gen/explorer.py` | 探索循环 run_explore() |
| **新增** | `playwright_gen/prompts/explore.md` | Explorer Agent system prompt |
| **新增** | `playwright_gen/prompts/explore_vision.md` | Vision 模式 prompt |
| **新增** | `playwright_gen/element_finder.py` | 元素定位引擎（语义描述 → Playwright locator） |
| **修改** | `playwright_gen/agent.py` | 新增 make_explorer_agent() |
| **修改** | `playwright_gen/cli.py` | 新增 --mode/--vision/--max-steps/--headed，路由逻辑 |
| **修改** | `playwright_gen/__init__.py` | 导出新模块 |
| **修改** | `pyproject.toml` | 无新依赖（playwright 已有） |
| **修改** | `README.md` | 更新用法文档 |
| **修改** | `AGENTS.md` | 更新架构描述 |

---

## 5. 实施步骤

### Step 1: BrowserSession (`browser.py`)

- Context manager 包装长连接 Playwright
- 对外暴露 `page`、`goto()`、`get_state()`（复用 snapshot 逻辑）、`screenshot()`
- 提取现有 `snapshot.py` 中的元素枚举逻辑为可复用函数
- 测试：打开一个页面，多次调用 `get_state()`，验证浏览器不被重启

### Step 2: Element Finder (`element_finder.py`)

- `find_element(page, description)` → Playwright Locator | None
- 匹配策略链：
  1. `page.get_by_role("button", name=description)`
  2. `page.get_by_role("link", name=description)`
  3. `page.get_by_label(description)`
  4. `page.get_by_text(description)`
  5. `page.get_by_placeholder(description)`（针对 input）
  6. CSS 选择器兜底（`[data-testid="{description}"]`）
- 失败时返回候选列表（当前页面所有可见可交互元素摘要）
- 测试：针对不同页面元素验证匹配精度

### Step 3: Tool 函数 (`tools.py`)

- 依赖 `BrowserSession` 实例（通过闭包或全局注入）
- 每个工具返回文本格式的观测结果
- 设计要点：失败信息要给 Agent 足够的重试线索
- `finalize()` 特殊处理——lovia 需要能感知到这个调用并终止循环

### Step 4: Explorer Agent (`explorer.py` + `agent.py`)

- 创建 Explorer Agent，注册工具
- 组装 prompt（URL + 描述 + 工具列表）
- 运行 lovia Runner，Agent 自主调用工具直到 finalize
- 处理异常（超时、浏览器崩溃、Agent 无响应）

### Step 5: CLI 集成 (`cli.py`)

- 新增参数，模式路由
- explore 路径：`run_explore()` → sanitize → pytest
- blind 路径：保持现有逻辑不变
- 两种路径共享 sanitize + pytest 验证环节

### Step 6: Prompt 调优

- 写 `explore.md` 和 `explore_vision.md`
- 核心指令：何时截图、如何选 selector、何时 finalize
- 与现有 `generate.md` 风格一致

### Step 7: 文档更新

- README 新增 explore 模式示例
- AGENTS.md 更新架构图

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| lovia tool-calling 机制不明确 | Agent 无法调用工具 | 先写一个小脚本验证 lovia 的 function-calling 是否可用，如果不支持则改用 agent loop 自己调度 |
| 元素定位失败率高 | Agent 反复重试，耗 token | element_finder 返回候选列表，Agent 自适应；加入定位缓存（同一次探索中复用成功的选择器） |
| Vision 模型不可用 | --vision 报错 | 检测模型名称/API，无 vision 能力时自动降级为 DOM-only + 警告 |
| Agent 无限循环不 finalize | 资源耗尽 | `--max-steps` 硬上限（默认 30），超限后强制要求 Agent 输出 |
| 长时间探索 token 消耗大 | 成本高 | 默认 max_steps=30，`get_page_state()` 返回摘要而非完整 HTML |
| 浏览器 crash | 探索中断 | BrowserSession 自动重启，Agent 收到错误后可恢复 |

---

## 7. 不在此次范围（留给 L3）

- 操作序列录制与回放
- 从探索轨迹自动推导最优选择器
- 多页面/多 tab 场景
- 网络拦截与 mock
- 测试套件管理（一次生成多个相关测试）
- 并行执行多个探索任务
