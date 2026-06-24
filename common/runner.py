"""用 pytest 运行生成的用例并裁判（所有版本共用，自 v0 抬升）。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def run_pytest(test_file: Path, timeout: int = 60) -> tuple[bool, str]:
    """在 test_file 所在目录运行 pytest，返回 (是否通过, 截断后的输出)。"""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", test_file.name, "-v", "--tb=short"],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=test_file.parent,
        )
        output = proc.stdout + proc.stderr
        return proc.returncode == 0, _trim_output(output)
    except subprocess.TimeoutExpired:
        return False, f"[pytest 超时，超过 {timeout}s]"


def _trim_output(text: str, head: int = 1500, tail: int = 1500) -> str:
    if len(text) <= head + tail:
        return text
    return text[:head] + f"\n\n[... 省略 {len(text) - head - tail} 字符 ...]\n\n" + text[-tail:]
