from playwright.sync_api import sync_playwright
from pathlib import Path


def snapshot_page(url: str, out_dir: Path, wait_ms: int = 1500) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            console_errors = []
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

            def get_label(el) -> str | None:
                try:
                    return el.evaluate("""el => {
                        if (el.ariaLabel) return el.ariaLabel;
                        const lid = el.getAttribute('aria-labelledby');
                        if (lid) {
                            const ref = document.getElementById(lid.split(' ')[0]);
                            if (ref) return ref.textContent.trim();
                        }
                        if (el.id) {
                            const lbl = document.querySelector('label[for="' + el.id + '"]');
                            if (lbl) return lbl.textContent.trim();
                        }
                        const wrap = el.closest('label');
                        if (wrap) return wrap.textContent.trim();
                        return null;
                    }""")
                except Exception:
                    return None

            buttons = []
            for el in page.query_selector_all("button, [role=button]"):
                if el.is_visible():
                    buttons.append({
                        "text": (el.text_content() or "").strip(),
                        "aria_label": el.get_attribute("aria-label"),
                        "testid": el.get_attribute("data-testid"),
                        "role": "button",
                    })

            inputs = []
            for el in page.query_selector_all("input, textarea, select"):
                if el.is_visible():
                    inputs.append({
                        "name": el.get_attribute("name"),
                        "type": el.get_attribute("type") or "text",
                        "placeholder": el.get_attribute("placeholder"),
                        "label": get_label(el),
                        "testid": el.get_attribute("data-testid"),
                    })

            links = []
            for el in page.query_selector_all("a[href]"):
                if el.is_visible():
                    links.append({
                        "text": (el.text_content() or "").strip(),
                        "href": el.get_attribute("href"),
                        "testid": el.get_attribute("data-testid"),
                    })

            return {
                "url": page.url,
                "title": page.title(),
                "buttons": buttons[:20],
                "inputs": inputs[:30],
                "links": links[:20],
                "console_errors": console_errors[:10],
                "screenshot": str(screenshot_path),
                "html": str(html_path),
            }
        finally:
            browser.close()
