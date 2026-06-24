"""v2 CLI：Agent 驱动浏览器探索 + 轨迹→代码。适用：动态/交互页面（SPA/弹窗/多步）。

    uv run python -m v2 --url <URL> --description "<描述>" [--vision] [--headed] [--max-steps N] [--trace]
"""

from __future__ import annotations

import argparse
import asyncio

from common.explore import generate_one
from common.io import make_run_dir


def main() -> None:
    p = argparse.ArgumentParser(description="v2：Agent 驱动浏览器探索生成 Playwright 测试（动态/交互页）")
    p.add_argument("--url", required=True, help="目标页面 URL")
    p.add_argument("--description", required=True, help="用自然语言描述要验证的行为")
    p.add_argument("--out-dir", default="./output", help="输出目录（默认 ./output）")
    p.add_argument("--name", default=None, help="本次运行名称（默认时间戳）")
    p.add_argument("--vision", action="store_true", help="启用 qwen 视觉 look 工具")
    p.add_argument("--headed", action="store_true", help="显示浏览器窗口（调试用）")
    p.add_argument("--max-steps", type=int, default=30, help="探索最大步数（max_turns）")
    p.add_argument("--trace", action="store_true", help="录制 Playwright trace（.zip）")
    args = p.parse_args()

    out_dir = make_run_dir(args.out_dir, args.name)
    test_path = out_dir / "test_generated.py"

    print(f"[v2] 探索 {args.url}")
    result = asyncio.run(
        generate_one(
            args.url,
            args.description,
            test_path,
            test_name="generated",
            vision=args.vision,
            headless=not args.headed,
            max_steps=args.max_steps,
            trace=args.trace,
        )
    )

    if result.passed:
        print(f"\n全部通过（{result.steps} 步，{result.attempts} 次尝试）→ {test_path}")
        if result.notes:
            print(f"\n说明：{result.notes}")
    else:
        print(f"\n未通过（共 {result.attempts} 次尝试）。最后一版：{test_path}")
        print(result.output[-1200:])
