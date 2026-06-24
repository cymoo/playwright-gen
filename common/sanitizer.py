"""清洗并校验生成的测试代码（所有版本共用，自 v0 抬升）。

去除 markdown fence，AST 解析，确保含 playwright 导入 / test_ 函数 / page.goto()。
"""

from __future__ import annotations

import ast
import re


def sanitize_code(raw: str) -> str:
    raw = re.sub(r"^```(?:python)?\n?", "", raw.strip(), flags=re.IGNORECASE)
    raw = re.sub(r"\n?```$", "", raw.strip())
    raw = raw.strip()

    try:
        tree = ast.parse(raw)
    except SyntaxError as e:
        raise ValueError(f"生成的代码语法错误: {e}") from e

    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.add(node.module)

    if not any("playwright" in m for m in imports):
        raise ValueError("生成的代码缺少 playwright 导入")

    test_fns = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")
    ]
    if not test_fns:
        raise ValueError("生成的代码没有 test_ 函数")

    goto_calls = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(getattr(n, "func", None), ast.Attribute)
        and n.func.attr == "goto"
    ]
    if not goto_calls:
        raise ValueError("生成的代码没有 page.goto() 调用")

    return raw
