"""输出目录与产物落盘（所有版本共用）。"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path


def make_run_dir(out_dir: str | Path, name: str | None = None) -> Path:
    """在 out_dir 下创建本次运行的子目录（默认用时间戳命名）。"""
    base = Path(out_dir)
    run_name = name or datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = base / run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir
