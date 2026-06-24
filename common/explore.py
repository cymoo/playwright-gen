"""探索引擎（v2/v3 共用）：lovia 工具 + Explorer Agent + generate_one 流水线。

Agent 在真实浏览器里操作，引擎**自动记录每一步真正成功的操作与断言**，
finalize 后由 codegen 据轨迹**确定性**生成同步 pytest 用例，再 clean-replay 校验；
失败则回灌 traceback 让 Agent 重新探索（verify→repair，已覆盖"回放失败"，无需单独自愈）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from lovia import Agent, RunContext, Runner, tool

from .browser import BrowserSession, ResolveError
from .codegen import Trajectory
from .models import deepseek_model
from .runner import run_pytest
from .sanitizer import sanitize_code
from .vision import describe_screenshot_async


@dataclass
class ExploreDeps:
    session: BrowserSession
    traj: Trajectory
    vision: bool
    run_dir: Path
    finalized: dict = field(default_factory=dict)


# ---------------- 工具（操作真实浏览器并记录轨迹）----------------

@tool(max_output_chars=4000)
async def get_page_state(ctx: RunContext[ExploreDeps]) -> str:
    """获取当前页面状态（ARIA 树 + 可交互元素 ref 列表）。每次操作后都应重新调用。"""
    return await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def navigate(ctx: RunContext[ExploreDeps], url: str) -> str:
    """导航到指定 URL。"""
    await ctx.deps.session.goto(url)
    ctx.deps.traj.add("goto", url)
    print(f"  · navigate {url}")
    return await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def click(ctx: RunContext[ExploreDeps], target: str) -> str:
    """点击元素。target 可为 ref（如 e3）或元素可见名称（如 打开设置）。"""
    try:
        expr = await ctx.deps.session.click(target)
    except ResolveError as e:
        return str(e)
    ctx.deps.traj.add("click", expr)
    print(f"  · click {target}")
    return f"已点击：{target}\n\n" + await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def fill(ctx: RunContext[ExploreDeps], target: str, text: str) -> str:
    """在输入框填入文本。target 可为 ref 或输入框可见名称/占位符。"""
    try:
        expr = await ctx.deps.session.fill(target, text)
    except ResolveError as e:
        return str(e)
    ctx.deps.traj.add("fill", expr, text)
    print(f"  · fill {target} = {text!r}")
    return f"已填入：{target} = {text}\n\n" + await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def check(ctx: RunContext[ExploreDeps], target: str) -> str:
    """勾选复选框/开关。"""
    try:
        expr = await ctx.deps.session.check(target)
    except ResolveError as e:
        return str(e)
    ctx.deps.traj.add("check", expr)
    print(f"  · check {target}")
    return f"已勾选：{target}\n\n" + await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def press_key(ctx: RunContext[ExploreDeps], key: str, target: str = "") -> str:
    """按键（如 Enter / Escape / Tab）。target 为空则对页面按键，否则对该元素按键。"""
    try:
        expr = await ctx.deps.session.press(key, target or None)
    except ResolveError as e:
        return str(e)
    ctx.deps.traj.add("press", expr, key)
    print(f"  · press {key} {('on ' + target) if target else ''}")
    return f"已按键：{key}\n\n" + await ctx.deps.session.snapshot()


@tool(max_output_chars=4000)
async def scroll(ctx: RunContext[ExploreDeps], direction: str) -> str:
    """滚动页面，direction 为 up/down/top/bottom。"""
    await ctx.deps.session.scroll(direction)
    return await ctx.deps.session.snapshot()


@tool
async def assert_visible(ctx: RunContext[ExploreDeps], target: str) -> str:
    """断言元素/文本当前可见（会记入最终用例）。target 可为 ref 或可见文本。"""
    try:
        expr = await ctx.deps.session.assert_visible(target)
    except ResolveError as e:
        return str(e)
    except Exception:
        return f"断言失败：{target} 当前不可见（请确认操作是否到位，或改用更精确的目标）。"
    ctx.deps.traj.add("assert_visible", expr)
    print(f"  · assert_visible {target}")
    return f"断言通过：{target} 可见。"


@tool
async def assert_url(ctx: RunContext[ExploreDeps], pattern: str) -> str:
    """断言当前 URL 匹配正则 pattern（会记入最终用例）。"""
    try:
        await ctx.deps.session.assert_url(pattern)
    except Exception:
        return f"断言失败：当前 URL 不匹配 {pattern}（当前为 {ctx.deps.session.page.url}）。"
    ctx.deps.traj.add("assert_url", pattern)
    print(f"  · assert_url {pattern}")
    return f"断言通过：URL 匹配 {pattern}。"


@tool
async def assert_title(ctx: RunContext[ExploreDeps], pattern: str) -> str:
    """断言页面标题匹配正则 pattern（会记入最终用例）。"""
    try:
        await ctx.deps.session.assert_title(pattern)
    except Exception:
        return f"断言失败：标题不匹配 {pattern}。"
    ctx.deps.traj.add("assert_title", pattern)
    print(f"  · assert_title {pattern}")
    return f"断言通过：标题匹配 {pattern}。"


@tool
async def look(ctx: RunContext[ExploreDeps], question: str) -> str:
    """【需 --vision】对当前页面截图，用视觉模型(qwen)返回文字描述；DOM 信息不足时使用。"""
    if not ctx.deps.vision:
        return "未启用视觉模式（look 不可用）。"
    path = ctx.deps.run_dir / "_look.png"
    await ctx.deps.session.screenshot(path)
    print("  · look (qwen)")
    return await describe_screenshot_async(path, question)


@tool
async def finalize(ctx: RunContext[ExploreDeps], test_name: str, notes: str = "") -> str:
    """完成任务：给出用例名与说明。系统据已记录的轨迹生成代码。调用后请停止，不要再调用工具。"""
    ctx.deps.finalized = {"test_name": test_name, "notes": notes}
    n = len(ctx.deps.traj.steps)
    return f"已记录轨迹（共 {n} 步）。任务完成，请停止。"


EXPLORE_INSTRUCTIONS = """你是浏览器测试探索 Agent，在真实浏览器里"像测试员一样操作"，完成用户描述的场景，并对关键结果做断言。
系统会**自动记录你每一步真正成功的操作与断言**，最终据此生成确定性的 pytest-playwright 用例——
所以你**不需要自己写代码**，只需正确地操作和断言。

工作循环：
1. 用 get_page_state 观察页面（列出 ARIA 树与可交互元素的 ref，如 e1/e2）。操作类工具的返回里也已附带最新状态。
2. 操作：click / fill / check / press_key / scroll。优先用 ref（click("e3")），也可用可见名称（click("打开设置")）。
3. 操作后页面常会变化（弹窗/跳转/异步内容），依据返回的新状态继续。
4. 在合适时机用 assert_visible / assert_url / assert_title 验证目标结果——**这是测试的价值，不要只操作不断言**。
5. 完成后调用 finalize(test_name, notes) 并停止。

规则：
- 一次只做一个动作，依据真实观察推进，不要臆测看不到的元素。
- **优先用 click 直接点击可见的目标元素**（标签、按钮、链接）。除非页面确实没有对应的可点击元素，
  否则不要用 press_key 的 Tab/Enter 做导航或激活——那样生成的用例很脆弱。
- 若提示"未找到/匹配多个"，先重新 get_page_state 看最新 ref，再改用具体 ref 或更精确的名称。
- 至少产生一个有意义的断言再 finalize。
- 不要使用任何形式的硬等待；交互后看新状态即可。
"""


def make_explorer_agent(vision: bool) -> Agent:
    tools = [
        get_page_state, navigate, click, fill, check, press_key, scroll,
        assert_visible, assert_url, assert_title, finalize,
    ]
    if vision:
        tools.append(look)
    return Agent(
        name="explorer",
        instructions=EXPLORE_INSTRUCTIONS,
        model=deepseek_model(),
        tools=tools,
    )


def _build_prompt(url: str, description: str, state: str, failure: str | None) -> str:
    parts = [
        f"任务：{description}",
        f"\n起始页面已打开：{url}",
        f"\n当前页面状态：\n{state}",
    ]
    if failure:
        parts.append(f"\n注意：上一版用例在 clean-replay 时失败，请调整操作/断言后重试。失败信息：\n{failure}")
    parts.append("\n请开始探索并完成任务，最后调用 finalize。")
    return "\n".join(parts)


def _validate(traj: Trajectory) -> str | None:
    if not any(s.kind != "goto" for s in traj.steps):
        return "没有产生任何有效操作或断言，请实际操作页面并断言关键结果。"
    if not traj.has_assertion():
        return "缺少断言。请在操作完成后用 assert_visible/assert_url/assert_title 验证关键结果，再 finalize。"
    return None


@dataclass
class GenResult:
    test_name: str
    code: str | None
    passed: bool
    output: str
    steps: int
    attempts: int
    notes: str = ""


async def generate_one(
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
    """对单个场景：探索→轨迹→codegen→clean-replay→（失败则）重新探索修复。每次尝试用全新浏览器。"""
    run_dir = test_path.parent
    failure: str | None = None
    last_code: str | None = None
    traj = Trajectory()
    notes = ""
    chosen_name = test_name

    for attempt in range(1, max_repairs + 2):
        traj = Trajectory()
        trace_path = (run_dir / f"trace_{test_path.stem}_{attempt}.zip") if trace else None
        print(f"  [探索] 第 {attempt} 次（{test_name}）")
        try:
            async with BrowserSession(headless=headless, trace_path=trace_path) as session:
                deps = ExploreDeps(session=session, traj=traj, vision=vision, run_dir=run_dir)
                await session.goto(url)
                traj.add("goto", url)
                state = await session.snapshot()
                agent = make_explorer_agent(vision)
                await Runner.run(
                    agent, _build_prompt(url, description, state, failure),
                    context=deps, max_turns=max_steps,
                )
                notes = deps.finalized.get("notes", "") or notes
                chosen_name = deps.finalized.get("test_name") or test_name
        except Exception as e:  # noqa: BLE001
            failure = f"探索异常：{e}"
            continue

        problem = _validate(traj)
        if problem and attempt <= max_repairs:
            failure = problem
            continue

        code = sanitize_code(traj.render(chosen_name, description))
        last_code = code
        test_path.write_text(code, encoding="utf-8")
        passed, output = run_pytest(test_path)
        if passed:
            return GenResult(chosen_name, code, True, output, len(traj.steps), attempt, notes)
        failure = output

    return GenResult(chosen_name, last_code, False, failure or "", len(traj.steps), max_repairs + 1, notes)
