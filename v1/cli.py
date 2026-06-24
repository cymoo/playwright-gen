"""v1 CLI：单次生成（富 ARIA 快照 + 可选 qwen 视觉）。适用：简单/静态页面。

    uv run python -m v1 --url <URL> --description "<描述>" [--vision]
"""

from __future__ import annotations

import argparse

from lovia import Runner

from common.io import make_run_dir
from common.models import max_retries
from common.runner import run_pytest
from common.sanitizer import sanitize_code
from common.vision import describe_screenshot

from .agent import GeneratedTest, make_agent
from .snapshot import snapshot_page


def build_prompt(
    snapshot: dict,
    description: str,
    vision_desc: str | None,
    previous_code: str | None,
    failure: str | None,
) -> str:
    parts = [
        f"URL：{snapshot['url']}",
        f"标题：{snapshot['title']}",
        f"\nARIA 无障碍树快照：\n{snapshot['aria']}",
    ]
    if snapshot.get("console_errors"):
        parts.append(f"\n控制台错误：{snapshot['console_errors']}")
    if vision_desc:
        parts.append(f"\n截图的视觉描述（来自视觉模型）：\n{vision_desc}")
    parts.append(f"\n需求描述：{description}")
    if previous_code:
        parts.append(f"\n上次生成的代码：\n```python\n{previous_code}\n```")
    if failure:
        parts.append(f"\npytest 失败日志：\n{failure}")
    return "\n".join(parts)


def main() -> None:
    p = argparse.ArgumentParser(description="v1：单次生成 Playwright 测试（简单/静态页；可选视觉）")
    p.add_argument("--url", required=True, help="目标页面 URL")
    p.add_argument("--description", required=True, help="用自然语言描述要验证的行为")
    p.add_argument("--out-dir", default="./output", help="输出目录（默认 ./output）")
    p.add_argument("--wait-ms", type=int, default=1500, help="domcontentloaded 后额外等待 ms")
    p.add_argument("--name", default=None, help="本次运行名称（默认时间戳）")
    p.add_argument("--vision", action="store_true", help="启用 qwen 视觉：对截图生成文本描述补充上下文")
    p.add_argument("--headed", action="store_true", help="显示浏览器窗口（调试用）")
    args = p.parse_args()

    out_dir = make_run_dir(args.out_dir, args.name)
    test_file = out_dir / "test_generated.py"

    print(f"[快照] {args.url}")
    snapshot = snapshot_page(args.url, out_dir, wait_ms=args.wait_ms, headed=args.headed)
    print(f"  title: {snapshot['title']}")

    vision_desc: str | None = None
    if args.vision:
        print("[视觉] qwen 分析截图…")
        vision_desc = describe_screenshot(
            snapshot["screenshot"],
            f"请描述与以下测试需求相关的可见元素：{args.description}",
        )
        preview = vision_desc[:200] + ("…" if len(vision_desc) > 200 else "")
        print(f"  {preview}")

    agent = make_agent()
    previous_code: str | None = None
    failure: str | None = None
    retries = max_retries()

    for attempt in range(1, retries + 1):
        print(f"\n[生成] 第 {attempt}/{retries} 轮")
        prompt = build_prompt(snapshot, args.description, vision_desc, previous_code, failure)
        result = Runner.run_sync(agent, prompt)
        test: GeneratedTest = result.output

        try:
            clean_code = sanitize_code(test.code)
        except ValueError as e:
            print(f"[校验失败] {e}，重试")
            previous_code = test.code
            failure = str(e)
            continue

        test_file.write_text(clean_code, encoding="utf-8")
        print(f"[运行] pytest {test_file}")
        passed, output = run_pytest(test_file)

        if passed:
            print(f"\n全部通过 → {test_file}")
            print(f"\n{test.notes}")
            return

        print(f"失败，准备第 {attempt + 1} 轮修复")
        previous_code = clean_code
        failure = output

    print(f"\n已达最大重试次数。最后一版: {test_file}")
