"""轨迹 → 同步 pytest-playwright 代码（v2/v3 共用）。

核心质量杠杆：测试代码**不是 LLM 凭记忆盲写**，而是由探索过程中**真正成功执行**的
操作轨迹确定性渲染而来 —— 每一步用的是当时真正命中的 locator 表达式。
因此产出即"已验证可回放"。

稳健性规则内建于渲染：使用 web-first 断言 + Playwright 自动等待，绝不输出硬 sleep；
每个用例自带 `page` fixture、相互独立。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


def _pylit(s: str | None) -> str:
    """渲染为合法 Python 字符串字面量（repr 可正确处理引号/反斜杠/unicode）。"""
    return repr(s if s is not None else "")


def _safe_ident(name: str) -> str:
    s = re.sub(r"\W+", "_", (name or "").strip().lower()).strip("_")
    if s.startswith("test_"):  # 渲染时会再加 test_ 前缀，避免出现 test_test_xxx
        s = s[len("test_"):]
    if not s:
        s = "generated"
    if s[0].isdigit():
        s = "t_" + s
    return s[:60]


@dataclass
class Step:
    """一条轨迹步骤。target 通常是 locator 表达式（如 `page.get_by_role("button", name="保存")`），
    对 goto 是 url，对 assert_url/assert_title 是正则 pattern。"""

    kind: str
    target: str | None = None
    value: str | None = None

    def render(self) -> str:
        k, t, v = self.kind, self.target, self.value
        if k == "goto":
            return f"page.goto({_pylit(t)})"
        if k == "click":
            return f"{t}.click()"
        if k == "fill":
            return f"{t}.fill({_pylit(v)})"
        if k == "check":
            return f"{t}.check()"
        if k == "uncheck":
            return f"{t}.uncheck()"
        if k == "press":
            return f"{t}.press({_pylit(v)})" if t else f"page.keyboard.press({_pylit(v)})"
        if k == "select":
            return f"{t}.select_option({_pylit(v)})"
        if k == "hover":
            return f"{t}.hover()"
        if k == "assert_visible":
            return f"expect({t}).to_be_visible()"
        if k == "assert_text":
            return f"expect({t}).to_contain_text({_pylit(v)})"
        if k == "assert_url":
            return f"expect(page).to_have_url(re.compile({_pylit(t)}))"
        if k == "assert_title":
            return f"expect(page).to_have_title(re.compile({_pylit(t)}))"
        return f"# 未知步骤: {k}"


@dataclass
class Trajectory:
    steps: list[Step] = field(default_factory=list)

    def add(self, kind: str, target: str | None = None, value: str | None = None) -> None:
        self.steps.append(Step(kind, target, value))

    def is_empty(self) -> bool:
        return not self.steps

    def has_assertion(self) -> bool:
        return any(s.kind.startswith("assert") for s in self.steps)

    def render(self, test_name: str, description: str) -> str:
        body = "\n".join("    " + s.render() for s in self.steps) or "    pass"
        doc = (description or "").replace('"""', "'''")
        return (
            "import re\n"
            "from playwright.sync_api import Page, expect\n\n\n"
            f"def test_{_safe_ident(test_name)}(page: Page):\n"
            f'    """{doc}"""\n'
            f"{body}\n"
        )
