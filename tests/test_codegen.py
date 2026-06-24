"""codegen 是确定性核心，必须有快速单测兜底（无 LLM / 无浏览器）。"""

from common.codegen import Trajectory, _safe_ident


def test_render_basic():
    t = Trajectory()
    t.add("goto", "https://x.com")
    t.add("click", 'page.get_by_role("button", name="保存")')
    t.add("fill", 'page.get_by_label("邮箱")', "a@b.com")
    t.add("assert_visible", 'page.get_by_text("成功")')
    code = t.render("my test", "描述")

    assert "from playwright.sync_api import Page, expect" in code
    assert "import re" in code
    assert "def test_my_test(page: Page):" in code
    assert "page.goto('https://x.com')" in code
    assert 'page.get_by_role("button", name="保存").click()' in code
    assert "page.get_by_label(\"邮箱\").fill('a@b.com')" in code
    assert 'expect(page.get_by_text("成功")).to_be_visible()' in code


def test_render_assert_url_uses_regex():
    t = Trajectory()
    t.add("goto", "https://x.com")
    t.add("assert_url", "dashboard")
    code = t.render("u", "")
    assert "re.compile('dashboard')" in code


def test_no_hard_sleep_in_output():
    t = Trajectory()
    t.add("goto", "https://x.com")
    t.add("click", 'page.get_by_role("button", name="x")')
    code = t.render("u", "")
    assert "sleep" not in code


def test_has_assertion():
    t = Trajectory()
    t.add("goto", "https://x.com")
    t.add("click", 'page.get_by_role("button", name="x")')
    assert not t.has_assertion()
    t.add("assert_visible", 'page.get_by_text("ok")')
    assert t.has_assertion()


def test_safe_ident():
    assert _safe_ident("Hello World!") == "hello_world"
    assert _safe_ident("") == "generated"
    assert _safe_ident("123abc").startswith("t_")
    assert _safe_ident("打开设置") == "打开设置"  # 允许 unicode 标识符
    assert _safe_ident("test_foo") == "foo"  # 不产生 test_test_foo
