import pytest

from common.sanitizer import sanitize_code

GOOD = '''from playwright.sync_api import Page, expect

def test_x(page: Page):
    page.goto("https://x.com")
    expect(page.get_by_text("a")).to_be_visible()
'''


def test_accepts_good():
    assert "def test_x" in sanitize_code(GOOD)


def test_strips_markdown_fence():
    out = sanitize_code("```python\n" + GOOD + "```")
    assert not out.startswith("`")
    assert "def test_x" in out


def test_rejects_no_playwright_import():
    with pytest.raises(ValueError):
        sanitize_code("def test_x():\n    page.goto('x')\n")


def test_rejects_no_test_function():
    with pytest.raises(ValueError):
        sanitize_code("from playwright.sync_api import Page\nx = 1\n")


def test_rejects_no_goto():
    with pytest.raises(ValueError):
        sanitize_code("from playwright.sync_api import Page\ndef test_x(page):\n    pass\n")


def test_rejects_syntax_error():
    with pytest.raises(ValueError):
        sanitize_code("from playwright.sync_api import Page\ndef test_x(:\n")
