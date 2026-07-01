/**
 * 浏览器/应用会话引擎（v2/v3 共用）。
 *
 * 统一 web 与 electron：两者最终都归一到一个 Playwright `Page`（electron 用
 * firstWindow()），因此 ARIA + data-pwref 快照、定位、操作、断言全部共享。
 *
 * 元素定位（最难的部分）+ 本次重构第 1 项优化（忠实定位）：
 * - 一段 JS 一次性扫描可交互元素，算 role / 可见名称 / 同名重复数，并打上 data-pwref。
 *   data-pwref 只作 Agent 的"寻址句柄"（agent 说 click("e3")）。
 * - 真正执行与记录用**同一个语义定位描述符**：resolve() 先据元素元数据推导描述符，
 *   再用 Playwright 自己的枚举**校验它唯一命中到该 data-pwref 元素**（必要时据
 *   Playwright 的真实序号修复 nth）。只有校验通过才执行+记录——从而
 *   "生成代码里的定位 === 探索时真正点中的定位"。校验不过则回退文本描述符或
 *   返回候选让 Agent 自纠，绝不记录一个没真正执行过的定位。
 */

import {
  chromium,
  _electron as electron,
  expect,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { LocatorDescriptor, TargetSpec } from './trajectory';
import { candidateDescriptors, type SnapshotItem } from './locators';

const INTERACTIVE_SELECTOR =
  'button,[role=button],a[href],[role=link],input:not([type=hidden]),' +
  'textarea,select,[role=checkbox],[role=radio],[role=switch],[role=tab],' +
  '[role=menuitem],[role=option]';

/** 生成在浏览器里执行的扫描脚本（IIFE，返回可交互元素元数据数组并打 data-pwref）。 */
function snapshotScript(sel: string): string {
  return `(() => {
  const sel = ${JSON.stringify(sel)};
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
    sameKeyIndex: 0, sameKeyCount: 0, roleIndex: 0, roleCount: 0,
  }));
  const kc = {}, rc = {};
  items.forEach((it) => { const k = it.role + '\\x00' + it.name; kc[k] = (kc[k] || 0) + 1; rc[it.role] = (rc[it.role] || 0) + 1; });
  const ks = {}, rs = {};
  items.forEach((it) => {
    const k = it.role + '\\x00' + it.name;
    it.sameKeyIndex = ks[k] || 0; ks[k] = it.sameKeyIndex + 1; it.sameKeyCount = kc[k];
    it.roleIndex = rs[it.role] || 0; rs[it.role] = it.roleIndex + 1; it.roleCount = rc[it.role];
  });
  document.querySelectorAll('[data-pwref]').forEach((el) => el.removeAttribute('data-pwref'));
  visible.forEach((el, i) => el.setAttribute('data-pwref', 'e' + (i + 1)));
  return items;
})()`;
}

export class ResolveError extends Error {}

interface Ref {
  ref: string;
  role: string;
  name: string;
  candidates: LocatorDescriptor[];
}

/** 据描述符构造实时 Playwright Locator（与 codegen.renderLocator 一一对应）。 */
export function buildLocator(page: Page, d: LocatorDescriptor): Locator {
  let loc: Locator;
  switch (d.kind) {
    case 'role':
      loc = page.getByRole(d.role as Parameters<Page['getByRole']>[0], {
        name: d.name,
        exact: d.exact,
      });
      break;
    case 'label':
      loc = page.getByLabel(d.text, { exact: d.exact });
      break;
    case 'placeholder':
      loc = page.getByPlaceholder(d.text);
      break;
    case 'testId':
      loc = page.getByTestId(d.testId);
      break;
    case 'text':
      loc = page.getByText(d.text, { exact: d.exact });
      break;
    default: {
      const _never: never = d;
      throw new Error(`unknown locator kind: ${JSON.stringify(_never)}`);
    }
  }
  if (d.nth !== undefined) loc = loc.nth(d.nth);
  return loc;
}

/** locator 是否恰好唯一命中带 data-pwref=ref 的那个元素。 */
async function elementIsRef(loc: Locator, ref: string): Promise<boolean> {
  try {
    if ((await loc.count()) !== 1) return false;
    return await loc.evaluate((el, r) => el.getAttribute('data-pwref') === r, ref);
  } catch {
    return false;
  }
}

function resolveElectronBinary(p: string): string {
  // macOS: MyApp.app → MyApp.app/Contents/MacOS/<可执行文件>
  if (p.endsWith('.app')) {
    const macos = join(p, 'Contents', 'MacOS');
    if (existsSync(macos)) {
      const entries = readdirSync(macos);
      const want = basename(p, '.app');
      const hit = entries.find((e) => e === want) ?? entries[0];
      if (hit) return join(macos, hit);
    }
  }
  return p;
}

export interface SessionOpts {
  headless: boolean;
  slowMo?: number;
  tracePath?: string;
}

export class Session {
  page!: Page;
  consoleErrors: string[] = [];
  refs: Map<string, Ref> = new Map();

  private browser?: Browser;
  private context?: BrowserContext;
  private electronApp?: ElectronApplication;

  constructor(
    private spec: TargetSpec,
    private opts: SessionOpts,
  ) {}

  // ---- 生命周期 ----

  async start(): Promise<void> {
    if (this.spec.mode === 'web') {
      this.browser = await chromium.launch({ headless: this.opts.headless, slowMo: this.opts.slowMo ?? 0 });
      this.context = await this.browser.newContext();
      if (this.opts.tracePath) await this.context.tracing.start({ screenshots: true, snapshots: true });
      this.page = await this.context.newPage();
    } else {
      const bin = resolveElectronBinary(this.spec.bin);
      this.electronApp = await electron.launch({ executablePath: bin, args: this.spec.args });
      this.page = await this.electronApp.firstWindow();
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text());
    });
  }

  async close(): Promise<void> {
    try {
      if (this.opts.tracePath && this.context) {
        await this.context.tracing.stop({ path: this.opts.tracePath });
      }
    } finally {
      if (this.electronApp) await this.electronApp.close();
      if (this.browser) await this.browser.close();
    }
  }

  // ---- 观察 ----

  /** 仅 web：导航。electron 无 goto（启动即打开）。不使用硬等待，靠自动等待。 */
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async snapshot(): Promise<string> {
    const items = (await this.page.evaluate(snapshotScript(INTERACTIVE_SELECTOR))) as SnapshotItem[];
    this.refs = new Map();
    const lines: string[] = [];
    items.forEach((it, i) => {
      const ref = `e${i + 1}`;
      this.refs.set(ref, { ref, role: it.role || '', name: it.name || '', candidates: candidateDescriptors(it) });
      const shown = it.name || it.placeholder || '(无名)';
      lines.push(`${ref}  ${it.role || ''}  "${shown}"`);
    });
    let aria = await this.page.locator('body').ariaSnapshot();
    if (aria.length > 3000) aria = aria.slice(0, 3000) + '\n…（ARIA 已截断）';
    const actionable = lines.length ? lines.join('\n') : '(无可交互元素)';
    const title = await this.page.title();
    const errs = this.consoleErrors.length
      ? `\n控制台错误: ${JSON.stringify(this.consoleErrors.slice(-5))}`
      : '';
    return (
      `URL: ${this.page.url()}\n标题: ${title}${errs}\n\n` +
      `可交互元素（用 ref 操作，如 click("e1")）:\n${actionable}\n\n` +
      `ARIA 快照:\n${aria}`
    );
  }

  private refsBrief(): string {
    if (this.refs.size === 0) return '(当前无已知可交互元素，请先调用 get_page_state)';
    return [...this.refs.values()].map((r) => `${r.ref} ${r.role} "${r.name}"`).join('\n');
  }

  // ---- 定位（忠实：执行的 locator === 记录的描述符）----

  /** 校验/修复 guess 描述符，使其唯一命中 data-pwref=ref 的元素；不行返回 null。 */
  private async faithfulDescriptor(ref: string, guess: LocatorDescriptor): Promise<LocatorDescriptor | null> {
    if (await elementIsRef(buildLocator(this.page, guess), ref)) return guess;
    // 据 Playwright 自己的枚举修复 nth（对齐真实序号，消除手写 accname 近似导致的偏差）
    const base = buildLocator(this.page, { ...guess, nth: undefined } as LocatorDescriptor);
    const n = await base.count();
    if (n > 1 && n <= 50) {
      for (let i = 0; i < n; i++) {
        if (await elementIsRef(base.nth(i), ref)) return { ...guess, nth: i };
      }
    }
    return null;
  }

  async resolve(target: string): Promise<{ locator: Locator; descriptor: LocatorDescriptor }> {
    const t = (target || '').trim();

    // 1. 命中已知 ref（直接 e3，或据可见名称唯一匹配到某 ref）
    let ref: string | undefined;
    if (this.refs.has(t)) {
      ref = t;
    } else {
      const low = t.toLowerCase();
      const matches = [...this.refs.values()].filter((r) => low && (r.name || '').toLowerCase().includes(low));
      if (matches.length === 1) ref = matches[0].ref;
      else if (matches.length > 1) {
        const cands = matches.map((m) => `${m.ref}("${m.name}")`).join(', ');
        throw new ResolveError(`"${target}" 匹配到多个可交互元素：${cands}。请用具体 ref。`);
      }
    }

    if (ref) {
      const r = this.refs.get(ref)!;
      // 逐个候选校验忠实性（执行 == 记录），取第一个能唯一命中该元素的
      for (const cand of r.candidates) {
        const faithful = await this.faithfulDescriptor(ref, cand);
        if (faithful) return { locator: buildLocator(this.page, faithful), descriptor: faithful };
      }
      throw new ResolveError(
        `"${target}" 无法推导出稳定唯一的语义定位，请换用更明确的元素或 ref。当前：\n${this.refsBrief()}`,
      );
    }

    // 2. 文本兜底（适合断言目标：提示 / 标题文本）
    const byText = this.page.getByText(t);
    const cnt = await byText.count();
    if (cnt === 1) return { locator: byText, descriptor: { kind: 'text', text: t } };
    if (cnt > 1) return { locator: byText.first(), descriptor: { kind: 'text', text: t, nth: 0 } };
    throw new ResolveError(`未找到匹配 "${target}" 的元素。当前可交互元素：\n${this.refsBrief()}`);
  }

  // ---- 行动（返回记录用的描述符）----

  async click(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.click({ timeout: 5000 });
    return descriptor;
  }

  async fill(target: string, text: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.fill(text, { timeout: 5000 });
    return descriptor;
  }

  async check(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.check({ timeout: 5000 });
    return descriptor;
  }

  async selectOption(target: string, value: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.selectOption(value, { timeout: 5000 });
    return descriptor;
  }

  async hover(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.hover({ timeout: 5000 });
    return descriptor;
  }

  async press(key: string, target?: string): Promise<LocatorDescriptor | undefined> {
    if (target) {
      const { locator, descriptor } = await this.resolve(target);
      await locator.press(key, { timeout: 5000 });
      return descriptor;
    }
    await this.page.keyboard.press(key);
    return undefined;
  }

  async scroll(direction: string): Promise<void> {
    const amt = { down: 600, up: -600 }[direction as 'down' | 'up'];
    if (amt) await this.page.mouse.wheel(0, amt);
    else if (direction === 'bottom') await this.page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    else if (direction === 'top') await this.page.evaluate('window.scrollTo(0, 0)');
  }

  // ---- 断言（实时校验 + 返回描述符供记录）----

  async assertVisible(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await expect(locator).toBeVisible({ timeout: 5000 });
    return descriptor;
  }

  async assertText(target: string, text: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await expect(locator).toContainText(text, { timeout: 5000 });
    return descriptor;
  }

  async assertUrl(pattern: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(pattern), { timeout: 5000 });
  }

  async assertTitle(pattern: string): Promise<void> {
    await expect(this.page).toHaveTitle(new RegExp(pattern), { timeout: 5000 });
  }

  async screenshot(path: string): Promise<string> {
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }
}
