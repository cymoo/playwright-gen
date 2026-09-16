/**
 * 浏览器/应用会话引擎。
 *
 * 统一 web 与 electron:两者最终都归一到一个 Playwright `Page`(electron 用
 * firstWindow()),因此 ARIA + data-pwref 快照、定位、操作、断言全部共享。
 *
 * 元素定位(最难的部分)——忠实定位:
 * - 一段 JS 一次性扫描可交互元素,算 role / 可见名称 / 同名重复数,并打上 data-pwref。
 *   data-pwref 只作 Agent 的"寻址句柄"(agent 说 click("e3"))。
 * - 真正执行与记录用**同一个语义定位描述符**:resolve() 先据元素元数据推导描述符,
 *   再用 Playwright 自己的枚举**校验它唯一命中到该 data-pwref 元素**(必要时据
 *   Playwright 的真实序号修复 nth)。只有校验通过才执行+记录——从而
 *   "生成代码里的定位 === 探索时真正点中的定位"。校验不过则回退文本描述符或
 *   返回候选让 Agent 自纠,绝不记录一个没真正执行过的定位。
 */

import {
  chromium,
  _electron as electron,
  expect,
  type Browser,
  type BrowserContext,
  type Download,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { paramText, resolveRule, waitRule, timeBudget, literalReferenceError, type Params, type Rule } from './runtime';
import type { LocatorDescriptor, TargetSpec } from './trajectory';
import { candidateDescriptors, type SnapshotItem } from './locators';

const INTERACTIVE_SELECTOR =
  'button,[role=button],a[href],[role=link],input:not([type=hidden]),' +
  'textarea,select,[role=checkbox],[role=radio],[role=switch],[role=tab],' +
  '[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],' +
  '[role=combobox],[role=treeitem],summary';

/** 操作类动作的超时(重型应用的界面切换可能较慢);断言保持 5s,与回放默认一致。 */
const ACTION_TIMEOUT = 10_000;
const ASSERT_TIMEOUT = 5_000;

/** 生成在浏览器里执行的扫描脚本(IIFE,返回可交互元素元数据数组并打 data-pwref)。 */
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
    if (tag === 'summary') return 'button';
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
    checked: (el.getAttribute('aria-checked') === 'true') || !!el.checked || false,
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

/** 快照条目附带的选中态(供 Agent 判断开关/复选框当前状态)。 */
interface ScanItem extends SnapshotItem {
  checked?: boolean;
}

/** 据描述符构造实时 Playwright Locator(与 codegen.renderLocator 一一对应)。 */
export function buildLocator(page: Page, d: LocatorDescriptor): Locator {
  let loc: Locator;
  switch (d.kind) {
    case 'rule': throw new Error('规则必须通过 resolveRule 异步解析');
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

/** macOS: MyApp.app → MyApp.app/Contents/MacOS/<可执行文件>;其他平台原样返回。 */
export function resolveElectronBinary(p: string): string {
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
  params?: Params;
  rules?: Record<string, Rule>;
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

  /** 仅 web:导航。electron 无 goto(启动即打开)。不使用硬等待,靠自动等待。 */
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async snapshot(): Promise<string> {
    const items = (await this.page.evaluate(snapshotScript(INTERACTIVE_SELECTOR))) as ScanItem[];
    this.refs = new Map();
    const lines: string[] = [];
    items.forEach((it, i) => {
      const ref = `e${i + 1}`;
      this.refs.set(ref, { ref, role: it.role || '', name: it.name || '', candidates: candidateDescriptors(it) });
      const shown = it.name || it.placeholder || '(无名)';
      const checkable = it.role === 'checkbox' || it.role === 'radio' || it.role === 'switch';
      const state = checkable ? (it.checked ? ' [已选中]' : ' [未选中]') : '';
      lines.push(`${ref}  ${it.role || ''}  "${shown}"${state}`);
    });
    let aria = await this.page.locator('body').ariaSnapshot();
    if (aria.length > 3000) aria = aria.slice(0, 3000) + '\n…(ARIA 已截断)';
    const actionable = lines.length ? lines.join('\n') : '(无可交互元素)';
    const title = await this.page.title();
    const errs = this.consoleErrors.length
      ? `\n控制台错误: ${JSON.stringify(this.consoleErrors.slice(-5))}`
      : '';
    return (
      `URL: ${this.page.url()}\n标题: ${title}${errs}\n\n` +
      `可交互元素(用 ref 操作,如 click("e1")):\n${actionable}\n\n` +
      `ARIA 快照:\n${aria}`
    );
  }

  private refsBrief(): string {
    if (this.refs.size === 0) return '(当前无已知可交互元素,请先调用 get_page_state)';
    return [...this.refs.values()].map((r) => `${r.ref} ${r.role} "${r.name}"`).join('\n');
  }

  // ---- 定位(忠实:执行的 locator === 记录的描述符)----

  /** 校验/修复 guess 描述符,使其唯一命中 data-pwref=ref 的元素;不行返回 null。 */
  private async faithfulDescriptor(ref: string, guess: LocatorDescriptor): Promise<LocatorDescriptor | null> {
    if (guess.kind === 'rule') return null;
    if (await elementIsRef(buildLocator(this.page, guess), ref)) return guess;
    // 据 Playwright 自己的枚举修复 nth(对齐真实序号,消除手写 accname 近似导致的偏差)
    const base = buildLocator(this.page, { ...guess, nth: undefined } as LocatorDescriptor);
    const n = await base.count();
    if (n > 1 && n <= 50) {
      for (let i = 0; i < n; i++) {
        if (await elementIsRef(base.nth(i), ref)) return { ...guess, nth: i };
      }
    }
    return null;
  }

  async resolve(target: string, timeout = ASSERT_TIMEOUT): Promise<{ locator: Locator; descriptor: LocatorDescriptor }> {
    const t = (target || '').trim();
    if (t.startsWith('@')) {
      const rule = this.opts.rules?.[t.slice(1)];
      if (!rule) throw new ResolveError(`未定义规则 ${t}`);
      return { locator: await resolveRule(this.page, rule, this.opts.params ?? {}, timeout), descriptor: { kind: 'rule', rule } };
    }
    if (/\$\{[A-Za-z_]\w*\}/.test(t)) {
      const descriptor: LocatorDescriptor = { kind: 'text', text: t, exact: true };
      const locator = this.page.getByText(paramText(t, this.opts.params ?? {}), { exact: true });
      await expect(locator).toHaveCount(1, { timeout });
      return { locator, descriptor };
    }

    // 1. 命中已知 ref(直接 e3,或据可见名称唯一匹配到某 ref)
    let ref: string | undefined;
    if (this.refs.has(t)) {
      ref = t;
    } else {
      const low = t.toLowerCase();
      const matches = [...this.refs.values()].filter((r) => low && (r.name || '').toLowerCase().includes(low));
      if (matches.length === 1) ref = matches[0].ref;
      else if (matches.length > 1) {
        const cands = matches.map((m) => `${m.ref}("${m.name}")`).join(', ');
        throw new ResolveError(`"${target}" 匹配到多个可交互元素:${cands}。请用具体 ref。`);
      }
    }

    if (ref) {
      const r = this.refs.get(ref)!;
      // 逐个候选校验忠实性(执行 == 记录),取第一个能唯一命中该元素的
      for (const cand of r.candidates) {
        const faithful = await this.faithfulDescriptor(ref, cand);
        if (faithful) {
          const error = literalReferenceError(faithful, this.opts.params ?? {});
          if (error) throw new ResolveError(error);
          return { locator: buildLocator(this.page, faithful), descriptor: faithful };
        }
      }
      throw new ResolveError(
        `"${target}" 无法推导出稳定唯一的语义定位,请换用更明确的元素或 ref。当前:\n${this.refsBrief()}`,
      );
    }

    // 2. 文本兜底(适合断言目标:提示 / 标题文本)
    const error = literalReferenceError(t, this.opts.params ?? {});
    if (error) throw new ResolveError(error);
    const byText = this.page.getByText(t);
    const cnt = await byText.count();
    if (cnt === 1) return { locator: byText, descriptor: { kind: 'text', text: t } };
    if (cnt > 1) return { locator: byText.first(), descriptor: { kind: 'text', text: t, nth: 0 } };
    throw new ResolveError(`未找到匹配 "${target}" 的元素。当前可交互元素:\n${this.refsBrief()}`);
  }

  // ---- 行动(返回记录用的描述符)----

  async click(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.click({ timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  /**
   * 点击触发"保存文件/下载"的元素,并确保产物落到 savePath(绝对路径):
   * - web:接住 download 事件后 saveAs 到目标路径。不接的话 Playwright 会把下载收进
   *   临时目录并在 context 关闭时删除——文件永远不会出现在期望的路径;
   * - electron:先在主进程 stub dialog.showSaveDialog(Sync) 直接返回目标路径——原生
   *   保存对话框不在 DOM 里,Playwright 看不见也点不到,stub 是唯一可自动化的方式;
   *   应用自行写盘的场景靠轮询等文件出现。
   * 先删除已存在的目标文件,保证"文件存在"确实是本次点击的产物(重试/回放不误判)。
   */
  async clickAndSave(target: string, savePath: string, timeoutMs: number): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    mkdirSync(dirname(savePath), { recursive: true });
    rmSync(savePath, { force: true });
    if (this.electronApp) {
      await this.electronApp.evaluate(({ dialog }, p) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
        dialog.showSaveDialogSync = () => p;
      }, savePath);
    }
    // 手动挂/摘监听而非 waitForEvent:无下载事件的路径(应用直写盘)下,
    // waitForEvent 的监听会一直挂到自身超时,反复调用会堆积
    let download: Download | undefined;
    const onDownload = (d: Download) => (download = d);
    this.page.on('download', onDownload);
    try {
      await locator.click({ timeout: ACTION_TIMEOUT });
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (download) {
          await download.saveAs(savePath);
          return descriptor;
        }
        if (existsSync(savePath)) return descriptor;
        if (Date.now() >= deadline) {
          throw new Error(
            `点击后 ${Math.round(timeoutMs / 1000)}s 内未捕获到下载事件,目标文件也未出现:${savePath}。` +
              `可能:该元素不触发保存;导出前还有未完成的选择;或应用把文件写去了别处。`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.page.off('download', onDownload);
    }
  }

  async fill(target: string, text: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.fill(paramText(text, this.opts.params ?? {}), { timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  async check(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.check({ timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  async uncheck(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.uncheck({ timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  async selectOption(target: string, value: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.selectOption(paramText(value, this.opts.params ?? {}), { timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  async hover(target: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await locator.hover({ timeout: ACTION_TIMEOUT });
    return descriptor;
  }

  async press(key: string, target?: string): Promise<LocatorDescriptor | undefined> {
    if (target) {
      const { locator, descriptor } = await this.resolve(target);
      await locator.press(paramText(key, this.opts.params ?? {}), { timeout: ACTION_TIMEOUT });
      return descriptor;
    }
    await this.page.keyboard.press(paramText(key, this.opts.params ?? {}));
    return undefined;
  }

  async scroll(direction: string): Promise<void> {
    const amt = { down: 600, up: -600 }[direction as 'down' | 'up'];
    if (amt) await this.page.mouse.wheel(0, amt);
    else if (direction === 'bottom') await this.page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    else if (direction === 'top') await this.page.evaluate('window.scrollTo(0, 0)');
  }

  // ---- 断言 / 等待(实时校验 + 返回描述符供记录)----

  async assertVisible(target: string): Promise<LocatorDescriptor> {
    if (target.startsWith('@')) return this.waitFor(target, ASSERT_TIMEOUT);
    const { locator, descriptor } = await this.resolve(target);
    await expect(locator).toBeVisible({ timeout: ASSERT_TIMEOUT });
    return descriptor;
  }

  async assertText(target: string, text: string): Promise<LocatorDescriptor> {
    const { locator, descriptor } = await this.resolve(target);
    await expect(locator).toContainText(paramText(text, this.opts.params ?? {}), { timeout: ASSERT_TIMEOUT });
    return descriptor;
  }

  async assertUrl(pattern: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(paramText(pattern, this.opts.params ?? {})), { timeout: ASSERT_TIMEOUT });
  }

  async assertTitle(pattern: string): Promise<void> {
    await expect(this.page).toHaveTitle(new RegExp(paramText(pattern, this.opts.params ?? {})), { timeout: ASSERT_TIMEOUT });
  }

  /**
   * 等待某文本/元素出现并可见(录制、加载、跳转等耗时过程)。
   * 目标不必当前就在页面上:已知 ref 走忠实定位,否则用 getByText(t).first() 等待出现。
   */
  async waitFor(target: string, timeoutMs: number): Promise<LocatorDescriptor> {
    const t = (target || '').trim();
    if (t.startsWith('@')) {
      const rule = this.opts.rules?.[t.slice(1)];
      if (!rule) throw new ResolveError(`未定义规则 ${t}`);
      await waitRule(this.page, rule, this.opts.params ?? {}, timeoutMs);
      return { kind: 'rule', rule };
    }
    const remaining = timeBudget(timeoutMs);
    if (this.refs.has(t) || t.includes('${')) {
      const { locator, descriptor } = await this.resolve(t, remaining());
      await expect(locator).toBeVisible({ timeout: remaining() });
      return descriptor;
    }
    const d: LocatorDescriptor = { kind: 'text', text: t, nth: 0 };
    await expect(buildLocator(this.page, d)).toBeVisible({ timeout: timeoutMs });
    return d;
  }

  async screenshot(path: string): Promise<string> {
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }
}

/**
 * 生成用例里的 clickAndSave 辅助函数:与 Session.clickAndSave 同语义(下载事件 +
 * Electron 对话框 stub + 轮询文件 + 先删旧文件),同文件放置保证探索/回放不漂移。
 * 相对路径按 spec 所在目录解析,与 run_command / write_file 一致。web 形态 electronApp 传 undefined。
 */
export const SAVE_HELPER_TS = `async function clickAndSave(page: any, electronApp: any, locator: any, p: string, timeoutMs: number): Promise<void> {
  const root = dirname(test.info().file);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('保存路径必须位于运行目录内');
  mkdirSync(dirname(abs), { recursive: true });
  rmSync(abs, { force: true });
  if (electronApp) {
    await electronApp.evaluate(({ dialog }: any, fp: string) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: fp });
      dialog.showSaveDialogSync = () => fp;
    }, abs);
  }
  let download: any;
  const onDownload = (d: any) => (download = d);
  page.on('download', onDownload);
  try {
    await locator.click();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (download) { await download.saveAs(abs); break; }
      if (existsSync(abs)) break;
      if (Date.now() >= deadline) throw new Error('保存超时 ' + timeoutMs + 'ms:未捕获下载事件,文件也未出现:' + abs);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    page.off('download', onDownload);
  }
  expect(existsSync(abs)).toBe(true);
}`;
