"""引擎集成测试（需 chromium，无 LLM / 无网络）：在本地静态 fixture 上验证
snapshot 能发现元素、resolve 推导出正确 locator、codegen 能渲染。"""

import asyncio
from pathlib import Path

from common.browser import BrowserSession
from common.codegen import Trajectory

URL = (Path(__file__).parent.parent / "examples" / "01_static_form.html").as_uri()


def test_snapshot_resolve_codegen():
    async def run() -> str:
        async with BrowserSession() as s:
            await s.goto(URL)
            state = await s.snapshot()
            assert "订阅" in state  # 按钮出现在可交互元素/ARIA 中
            assert "可交互元素" in state
            expr = await s.assert_visible("订阅")  # 实时断言 + 返回语义 locator
            assert 'get_by_role("button", name="订阅")' in expr
            return expr

    expr = asyncio.run(run())
    t = Trajectory()
    t.add("goto", URL)
    t.add("assert_visible", expr)
    code = t.render("static", "验证订阅按钮可见")
    assert "def test_static(page: Page):" in code
    assert "to_be_visible()" in code
