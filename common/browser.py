"""异步浏览器引擎（v2/v3 共用）。

为什么用 **async** Playwright：lovia 的工具运行在 async 事件循环中（同步工具走工作线程），
而 Playwright 的同步 API 无法在事件循环 / 异方线程里安全使用。故引擎全程 async。

元素定位（gpt5.5 报告里"最难的部分"）的做法：
- 用一段 JS 一次性扫描可交互元素，计算每个元素的 role / 可见名称 / 同名重复次数，
  并就地打上 `data-pwref="eN"`：**实时操作**用 data-pwref（绝对唯一、稳健），
  **生成代码**用据此推导出的**语义 locator 表达式**（role+name>label>placeholder>testid>role.nth）。
- 解析失败时返回**候选列表**，让 Agent 自纠，而不是死胡同。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import Locator, async_playwright, expect

INTERACTIVE_SELECTOR = (
    "button,[role=button],a[href],[role=link],input:not([type=hidden]),"
    "textarea,select,[role=checkbox],[role=radio],[role=switch],[role=tab],"
    "[role=menuitem],[role=option]"
)

_SNAPSHOT_JS = r"""
(sel) => {
  const els = Array.from(document.querySelectorAll(sel));
  const isVis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
        && s.display !== 'none' && s.opacity !== '0';
  };
  const visible = els.filter(isVis);
  const roleOf = (el) => {
    const ex = el.getAttribute('role'); if (ex) return ex;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    return tag;
  };
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lid = el.getAttribute('aria-labelledby');
    if (lid) { const r = document.getElementById(lid.split(' ')[0]); if (r) return (r.textContent || '').trim(); }
    if (el.id) { try { const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lbl) return (lbl.textContent || '').trim(); } catch (e) {} }
    const wrap = el.closest('label'); if (wrap) return (wrap.textContent || '').trim();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return (el.getAttribute('placeholder') || '').trim();
    return (el.textContent || '').trim();
  };
  const items = visible.map((el) => ({
    role: roleOf(el),
    name: nameOf(el).slice(0, 100),
    placeholder: el.getAttribute('placeholder') || '',
    testid: el.getAttribute('data-testid') || '',
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
  }));
  const kc = {}, rc = {};
  items.forEach((it) => { const k = it.role + '\x00' + it.name; kc[k] = (kc[k] || 0) + 1; rc[it.role] = (rc[it.role] || 0) + 1; });
  const ks = {}, rs = {};
  items.forEach((it) => {
    const k = it.role + '\x00' + it.name;
    it.sameKeyIndex = ks[k] || 0; ks[k] = it.sameKeyIndex + 1; it.sameKeyCount = kc[k];
    it.roleIndex = rs[it.role] || 0; rs[it.role] = it.roleIndex + 1; it.roleCount = rc[it.role];
  });
  document.querySelectorAll('[data-pwref]').forEach((el) => el.removeAttribute('data-pwref'));
  visible.forEach((el, i) => el.setAttribute('data-pwref', 'e' + (i + 1)));
  return items;
}
"""


def _lit(s: str) -> str:
    """把字符串渲染为 locator 表达式里的双引号参数（转义反斜杠/引号/换行）。"""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def expr_for(item: dict) -> str:
    """据元素元数据推导**唯一的语义 locator 表达式**（供生成代码使用）。"""
    role = item.get("role") or ""
    name = item.get("name") or ""
    if name and item.get("sameKeyCount", 1) == 1:
        return f"page.get_by_role({_lit(role)}, name={_lit(name)})"
    if name and item.get("sameKeyCount", 1) > 1:
        return f"page.get_by_role({_lit(role)}, name={_lit(name)}).nth({item.get('sameKeyIndex', 0)})"
    if item.get("placeholder"):
        return f"page.get_by_placeholder({_lit(item['placeholder'])})"
    if item.get("testid"):
        return f"page.get_by_test_id({_lit(item['testid'])})"
    return f"page.get_by_role({_lit(role)}).nth({item.get('roleIndex', 0)})"


class ResolveError(Exception):
    """定位失败，message 内含候选列表，供工具回传给 Agent 自纠。"""


@dataclass
class Ref:
    ref: str
    role: str
    name: str
    expr: str


class BrowserSession:
    """长连接浏览器会话（整个探索期存活）。"""

    def __init__(self, headless: bool = True, trace_path: Path | None = None, slow_mo: int = 0):
        self.headless = headless
        self.trace_path = trace_path
        self.slow_mo = slow_mo  # 调试用：有头模式下放慢每步操作，便于肉眼观察
        self._pw = None
        self._browser = None
        self._context = None
        self.page = None
        self.console_errors: list[str] = []
        self.refs: dict[str, Ref] = {}

    async def __aenter__(self) -> "BrowserSession":
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(headless=self.headless, slow_mo=self.slow_mo)
        self._context = await self._browser.new_context()
        if self.trace_path:
            await self._context.tracing.start(screenshots=True, snapshots=True)
        self.page = await self._context.new_page()
        self.page.on(
            "console",
            lambda m: self.console_errors.append(m.text) if m.type == "error" else None,
        )
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            if self.trace_path and self._context:
                await self._context.tracing.stop(path=str(self.trace_path))
        finally:
            if self._browser:
                await self._browser.close()
            if self._pw:
                await self._pw.stop()

    # ---- 观察 ----

    async def goto(self, url: str) -> None:
        await self.page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await self.page.wait_for_timeout(500)

    async def snapshot(self) -> str:
        """刷新 ref 表并返回当前页面的文本摘要（ARIA 树 + 可交互元素 ref 列表）。"""
        items = await self.page.evaluate(_SNAPSHOT_JS, INTERACTIVE_SELECTOR)
        self.refs = {}
        lines = []
        for i, it in enumerate(items, start=1):
            ref = f"e{i}"
            self.refs[ref] = Ref(ref=ref, role=it.get("role", ""), name=it.get("name", ""), expr=expr_for(it))
            shown = it.get("name", "") or it.get("placeholder", "") or "(无名)"
            lines.append(f'{ref}  {it.get("role", "")}  "{shown}"')
        aria = await self.page.locator("body").aria_snapshot()
        if len(aria) > 3000:
            aria = aria[:3000] + "\n…（ARIA 已截断）"
        actionable = "\n".join(lines) if lines else "(无可交互元素)"
        title = await self.page.title()
        errs = f"\n控制台错误: {self.console_errors[-5:]}" if self.console_errors else ""
        # 可交互元素放前面（最重要，避免被工具层截断丢失）；ARIA 树作为补充上下文放后面
        return (
            f"URL: {self.page.url}\n标题: {title}{errs}\n\n"
            f"可交互元素（用 ref 操作，如 click(\"e1\")）:\n{actionable}\n\n"
            f"ARIA 快照:\n{aria}"
        )

    def _refs_brief(self) -> str:
        if not self.refs:
            return "(当前无已知可交互元素，请先调用 get_page_state)"
        return "\n".join(f'{r.ref} {r.role} "{r.name}"' for r in self.refs.values())

    # ---- 定位 ----

    async def resolve(self, target: str) -> tuple[Locator, str]:
        """target 可为 ref（e3）或自然语言。返回 (实时 Locator, 语义 locator 表达式)。
        失败抛 ResolveError（含候选）。"""
        t = (target or "").strip()
        if t in self.refs:
            loc = self.page.locator(f'[data-pwref="{t}"]')
            if await loc.count() == 1:
                return loc, self.refs[t].expr
            # data-pwref 失效/歧义（页面已变）：退回用该 ref 记录的名称重新解析
            t = self.refs[t].name or t
        low = t.lower()
        matches = [r for r in self.refs.values() if low and low in (r.name or "").lower()]
        if len(matches) == 1:
            m = matches[0]
            return self.page.locator(f'[data-pwref="{m.ref}"]'), m.expr
        if len(matches) > 1:
            cands = ", ".join(f'{m.ref}("{m.name}")' for m in matches)
            raise ResolveError(f'"{target}" 匹配到多个可交互元素：{cands}。请用具体 ref。')
        # 回退：按可见文本（适合断言目标，如提示/标题文本）
        loc = self.page.get_by_text(t)
        cnt = await loc.count()
        if cnt == 1:
            return loc, f"page.get_by_text({_lit(t)})"
        if cnt > 1:
            return loc.first, f"page.get_by_text({_lit(t)}).first"
        raise ResolveError(f'未找到匹配 "{target}" 的元素。当前可交互元素：\n{self._refs_brief()}')

    # ---- 行动（返回语义 locator 表达式，供轨迹记录）----

    async def click(self, target: str) -> str:
        loc, expr = await self.resolve(target)
        await loc.click(timeout=5000)
        await self.page.wait_for_timeout(300)
        return expr

    async def fill(self, target: str, text: str) -> str:
        loc, expr = await self.resolve(target)
        await loc.fill(text, timeout=5000)
        return expr

    async def check(self, target: str) -> str:
        loc, expr = await self.resolve(target)
        await loc.check(timeout=5000)
        await self.page.wait_for_timeout(200)
        return expr

    async def press(self, key: str, target: str | None = None) -> str | None:
        if target:
            loc, expr = await self.resolve(target)
            await loc.press(key, timeout=5000)
            await self.page.wait_for_timeout(200)
            return expr
        await self.page.keyboard.press(key)
        await self.page.wait_for_timeout(200)
        return None

    async def scroll(self, direction: str) -> None:
        amt = {"down": 600, "up": -600}.get(direction, 0)
        if amt:
            await self.page.mouse.wheel(0, amt)
        elif direction == "bottom":
            await self.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        elif direction == "top":
            await self.page.evaluate("window.scrollTo(0, 0)")
        await self.page.wait_for_timeout(200)

    # ---- 断言（实时校验 + 返回表达式供记录）----

    async def assert_visible(self, target: str) -> str:
        loc, expr = await self.resolve(target)
        await expect(loc).to_be_visible(timeout=5000)
        return expr

    async def assert_url(self, pattern: str) -> None:
        await expect(self.page).to_have_url(re.compile(pattern), timeout=5000)

    async def assert_title(self, pattern: str) -> None:
        await expect(self.page).to_have_title(re.compile(pattern), timeout=5000)

    async def screenshot(self, path: str | Path) -> str:
        await self.page.screenshot(path=str(path), full_page=True)
        return str(path)
