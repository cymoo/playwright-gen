"""v3 CLI：规划 + 套件 + 登录/多视图（+ 可选 MCP 后端）。适用：复杂应用。

    uv run python -m v3 --url <URL> --description "<描述>" \
        [--username U --password P] [--vision] [--max-steps N] [--trace] [--backend inhouse|mcp]

相对 v2：多了一个 Planner，把一句话拆成多个聚焦场景，逐个用探索引擎生成**独立可运行**的用例，
汇总成一个测试套件。登录等前置会被并入每个场景，保证每条用例自包含。
"""

from __future__ import annotations

import argparse
import asyncio
import re

from common.browser import BrowserSession
from common.io import make_run_dir

from .planner import make_plan


def _safe_file(name: str, idx: int) -> str:
    s = re.sub(r"\W+", "_", (name or "").strip().lower()).strip("_") or f"scenario{idx}"
    return f"test_{idx:02d}_{s[:40]}.py"


async def _quick_state(url: str, headless: bool) -> str:
    async with BrowserSession(headless=headless) as s:
        await s.goto(url)
        return await s.snapshot()


async def _run(args: argparse.Namespace, generate) -> None:
    headless = not args.headed
    out_dir = make_run_dir(args.out_dir, args.name)

    creds_hint = ""
    if args.username:
        creds_hint = f"登录凭据：用户名 {args.username}、密码 {args.password}。页面若需登录，每个场景都要先登录。"

    print(f"[v3] 规划场景（backend={args.backend}）…")
    initial_state = await _quick_state(args.url, headless)
    plan = await make_plan(args.description, args.url, initial_state, creds_hint)
    print(f"[规划] 拆出 {len(plan.scenarios)} 个场景：")
    for i, sc in enumerate(plan.scenarios, 1):
        print(f"  {i}. {sc.name} — {sc.description[:60]}")

    results = []
    for i, sc in enumerate(plan.scenarios, 1):
        desc = sc.description
        if args.username and "登录" not in desc:
            desc = f"先用用户名 {args.username}、密码 {args.password} 登录。然后：{desc}"
        test_path = out_dir / _safe_file(sc.name, i)
        print(f"\n=== 场景 {i}/{len(plan.scenarios)}: {sc.name} ===")
        result = await generate(
            args.url, desc, test_path, test_name=sc.name,
            vision=args.vision, headless=headless,
            max_steps=args.max_steps, trace=args.trace,
        )
        results.append((sc, test_path, result))

    passed = sum(1 for _, _, r in results if r.passed)
    print(f"\n===== 套件汇总：{passed}/{len(results)} 通过 =====")
    for sc, path, r in results:
        print(f"  {'✅' if r.passed else '❌'} {sc.name}  →  {path}")


def main() -> None:
    p = argparse.ArgumentParser(description="v3：规划+套件 生成 Playwright 测试（复杂应用）")
    p.add_argument("--url", required=True, help="目标页面 URL")
    p.add_argument("--description", required=True, help="用自然语言描述要验证的行为（可含多个关注点）")
    p.add_argument("--out-dir", default="./output", help="输出目录（默认 ./output）")
    p.add_argument("--name", default=None, help="本次运行名称（默认时间戳）")
    p.add_argument("--username", default=None, help="登录用户名（需要鉴权时）")
    p.add_argument("--password", default=None, help="登录密码")
    p.add_argument("--vision", action="store_true", help="启用 qwen 视觉 look 工具")
    p.add_argument("--headed", action="store_true", help="显示浏览器窗口（调试用）")
    p.add_argument("--max-steps", type=int, default=30, help="每个场景的探索最大步数")
    p.add_argument("--trace", action="store_true", help="录制 Playwright trace（.zip）")
    p.add_argument("--backend", choices=["inhouse", "mcp"], default="inhouse",
                   help="浏览器后端：inhouse=自研引擎（确定性轨迹→代码，默认）；mcp=官方 Playwright MCP")
    args = p.parse_args()

    if args.backend == "mcp":
        from common.mcp_explore import generate_one_mcp as generate
    else:
        from common.explore import generate_one as generate

    asyncio.run(_run(args, generate))
