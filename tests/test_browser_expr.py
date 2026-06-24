"""元素定位是"最难的部分"，其语义 locator 推导（纯函数）必须有单测。"""

from common.browser import _lit, expr_for


def test_role_name_unique():
    item = {"role": "button", "name": "保存", "sameKeyCount": 1, "sameKeyIndex": 0}
    assert expr_for(item) == 'page.get_by_role("button", name="保存")'


def test_role_name_duplicate_uses_nth():
    item = {"role": "button", "name": "保存", "sameKeyCount": 2, "sameKeyIndex": 1}
    assert expr_for(item) == 'page.get_by_role("button", name="保存").nth(1)'


def test_placeholder_fallback():
    item = {"role": "textbox", "name": "", "placeholder": "邮箱", "sameKeyCount": 1}
    assert expr_for(item) == 'page.get_by_placeholder("邮箱")'


def test_testid_fallback():
    item = {"role": "button", "name": "", "testid": "submit", "sameKeyCount": 1}
    assert expr_for(item) == 'page.get_by_test_id("submit")'


def test_role_only_fallback():
    item = {"role": "link", "name": "", "roleIndex": 2, "sameKeyCount": 1}
    assert expr_for(item) == 'page.get_by_role("link").nth(2)'


def test_lit_escapes_quotes():
    assert _lit('say "hi"') == '"say \\"hi\\""'
