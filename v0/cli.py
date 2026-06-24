import argparse
import json
import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from lovia import Runner

from .agent import GeneratedTest, make_agent
from .runner import run_pytest
from .sanitizer import sanitize_code
from .snapshot import snapshot_page


def build_prompt(
    snapshot: dict,
    description: str,
    previous_code: str | None,
    failure: str | None,
) -> str:
    parts = [
        f"页面快照：\n{json.dumps(snapshot, ensure_ascii=False, indent=2)}",
        f"\n需求描述：{description}",
    ]
    if previous_code:
        parts.append(f"\n上次生成的代码：\n```python\n{previous_code}\n```")
    if failure:
        parts.append(f"\npytest 失败日志：\n{failure}")
    return "\n".join(parts)


def main() -> None:
    p = argparse.ArgumentParser(description="从 URL + 自然语言描述生成 Playwright 测试")
    p.add_argument("--url", required=True, help="目标页面 URL")
    p.add_argument("--description", required=True, help="用自然语言描述要验证的行为")
    p.add_argument("--out-dir", default="./output", help="输出目录（默认 ./output）")
    p.add_argument("--wait-ms", type=int, default=1500, help="domcontentloaded 后额外等待 ms")
    p.add_argument("--name", default=None, help="本次运行的名称（默认用时间戳自动生成）")
    args = p.parse_args()

    base_dir = Path(args.out_dir)
    run_name = args.name or datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = base_dir / run_name
    out_dir.mkdir(parents=True, exist_ok=True)
    test_file = out_dir / "test_generated.py"
    max_retries = int(os.getenv("MAX_RETRIES", "5"))

    print(f"[快照] {args.url}")
    snapshot = snapshot_page(args.url, out_dir, wait_ms=args.wait_ms)
    print(f"  title: {snapshot['title']}")
    print(f"  buttons: {len(snapshot['buttons'])}  inputs: {len(snapshot['inputs'])}  links: {len(snapshot['links'])}")

    agent = make_agent()
    previous_code: str | None = None
    failure: str | None = None

    for attempt in range(1, max_retries + 1):
        print(f"\n[生成] 第 {attempt}/{max_retries} 轮")
        prompt = build_prompt(snapshot, args.description, previous_code, failure)
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
