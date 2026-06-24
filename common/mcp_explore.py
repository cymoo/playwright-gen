"""可选的 MCP 后端（v3 `--backend mcp`）。

用官方 Playwright MCP（`npx @playwright/mcp`）的 browser_* 工具驱动浏览器探索。
与自研引擎的区别（诚实地说明）：
- 自研 inhouse：记录"真正命中的 locator 轨迹"，**确定性**生成代码（产出即可回放）。
- MCP：浏览器控制由官方实现（最稳健），但 MCP 工具不暴露其内部 locator，
  因此最终用例由 LLM 依据探索过程**自行编写**，再经 sanitize + pytest 校验 + 修复闭环兜底。

依赖：`uv sync --extra mcp` 安装 `lovia[mcp]`；运行需 Node/npx（首次会自动拉取 @playwright/mcp）。
vision / trace 参数在此后端忽略（签名保持一致，便于与 inhouse 互换）。
"""

from __future__ import annotations

from pathlib import Path

from lovia import Agent, Runner
from pydantic import BaseModel

from .explore import GenResult
from .models import deepseek_model
from .runner import run_pytest
from .sanitizer import sanitize_code


class GeneratedTest(BaseModel):
    code: str
    notes: str


MCP_INSTRUCTIONS = """你是浏览器测试 Agent，使用 Playwright MCP 提供的 browser_* 工具在真实浏览器中操作，完成用户描述的场景。
流程：
1. 用 browser_navigate 打开起始 URL。
2. 用 browser_snapshot 观察页面（返回带 ref 的无障碍快照），用 browser_click / browser_type 等操作。
3. 操作后重新 browser_snapshot 确认页面变化（弹窗/跳转/异步内容），再继续。
4. 完成后，输出一个**可独立运行**的 pytest-playwright **同步 API** 测试（字段 code）：
   - from playwright.sync_api import Page, expect
   - 函数 test_xxx(page: Page)，首行 page.goto("<起始URL>")
   - 优先语义定位：get_by_role(role, name=...) > get_by_label > get_by_text > get_by_test_id
   - 复现你**真正成功执行过**的步骤；用 expect(...).to_be_visible() 等断言验证关键结果
   - 禁止任何硬等待（不要 time.sleep）
   - code 为纯代码，**不要** markdown fence
"""


def _prompt(url: str, description: str, failure: str | None) -> str:
    parts = [
        f"任务：{description}",
        f"起始 URL：{url}",
        "请用 browser_* 工具探索并完成任务，然后输出可独立运行的 pytest-playwright 用例。",
    ]
    if failure:
        parts.append(f"上次用例在 clean-replay 时失败，请修正后重新输出。失败信息：\n{failure}")
    return "\n".join(parts)


async def generate_one_mcp(
    url: str,
    description: str,
    test_path: Path,
    test_name: str,
    *,
    vision: bool = False,
    headless: bool = True,
    max_steps: int = 30,
    max_repairs: int = 2,
    trace: bool = False,
) -> GenResult:
    try:
        from lovia.plugins.mcp import MCP, MCPServerStdio
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            "MCP 后端需要 lovia[mcp]：请先 `uv sync --extra mcp`。原始错误：" + str(e)
        )

    args = ["-y", "@playwright/mcp@latest", "--isolated"]
    if headless:
        args.append("--headless")
    server = MCPServerStdio(name="pw", command="npx", args=args)

    failure: str | None = None
    last_code: str | None = None
    notes = ""

    async with server.session() as conn:
        print(f"  [MCP] 已连接，工具：{[t.name for t in conn.tools()]}")
        agent = Agent(
            name="mcp-explorer",
            instructions=MCP_INSTRUCTIONS,
            model=deepseek_model(),
            plugins=[MCP(conn)],
            output_type=GeneratedTest,
        )
        for attempt in range(1, max_repairs + 2):
            print(f"  [MCP 探索] 第 {attempt} 次（{test_name}）")
            result = await Runner.run(agent, _prompt(url, description, failure), max_turns=max_steps)
            gen: GeneratedTest = result.output
            notes = gen.notes or notes
            try:
                code = sanitize_code(gen.code)
            except ValueError as e:
                failure = f"代码校验失败：{e}"
                continue
            last_code = code
            test_path.write_text(code, encoding="utf-8")
            passed, output = run_pytest(test_path)
            if passed:
                return GenResult(test_name, code, True, output, 0, attempt, notes)
            failure = output

    return GenResult(test_name, last_code, False, failure or "", 0, max_repairs + 1, notes)
