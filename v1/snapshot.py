"""v1 静态快照：用 Playwright 的 ARIA 无障碍树（role + 可见名称 + 层级）替代
v0 的自定义按钮/输入/链接提取，信息更完整、更贴近语义定位。"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright


def snapshot_page(url: str, out_dir: Path, wait_ms: int = 1500) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            console_errors: list[str] = []
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
            )

            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(wait_ms)

            screenshot_path = out_dir / "screenshot.png"
            html_path = out_dir / "page.html"
            page.screenshot(path=str(screenshot_path), full_page=True)
            html_path.write_text(page.content(), encoding="utf-8")

            aria = page.locator("body").aria_snapshot()

            return {
                "url": page.url,
                "title": page.title(),
                "aria": aria,
                "console_errors": console_errors[:10],
                "screenshot": str(screenshot_path),
                "html": str(html_path),
            }
        finally:
            browser.close()
