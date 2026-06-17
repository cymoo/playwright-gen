"""playwright-gen — 从 URL + 自然语言描述自动生成 Playwright 测试用例。"""

from playwright_gen.agent import GeneratedTest, make_agent
from playwright_gen.runner import run_pytest
from playwright_gen.sanitizer import sanitize_code
from playwright_gen.snapshot import snapshot_page

__all__ = [
    "GeneratedTest",
    "make_agent",
    "run_pytest",
    "sanitize_code",
    "snapshot_page",
]
