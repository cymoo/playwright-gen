"""playwright-gen 入口 — 从 URL + 自然语言描述自动生成 Playwright 测试用例。

用法:
    uv run python main.py --url <URL> --description "<描述>"
    uv run playwright-gen --url <URL> --description "<描述>"
"""

from playwright_gen.cli import main

if __name__ == "__main__":
    main()
