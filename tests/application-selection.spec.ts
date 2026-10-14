import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/browser';
import { renderTest } from '../src/codegen';
import { configForDescription, writeRuntime } from '../src/config';
import { makeTools } from '../src/engine';
import { runPlaywright } from '../src/runner';
import { Trajectory } from '../src/trajectory';

const fixture = (sn: string, pkg: string, selectWorks = true) => `
  <input aria-label="Search or type commands" disabled>
  <label>Target device:<select><option value="">Please select</option><option>${sn}</option></select></label>
  <ul><li><span>apps</span><div>Application to profile</div><div id="selected">old.package</div></li></ul>
  <input aria-label="search" placeholder="Click to search">
  <strong onclick="${selectWorks ? `document.querySelector('#selected').textContent='${pkg}'` : ''}">${pkg}</strong>`;

test('按设置行验证已选应用，生成脚本更换设备和包名后回放；仅搜索到却未选中仍失败', async ({ page }) => {
  test.setTimeout(60000);
  const root = join(process.cwd(), 'output'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'selected-app-'));
  try {
    const html = join(dir, 'fixture.html');
    writeFileSync(html, fixture('SN-A', 'com.example.vulkan'));
    const url = pathToFileURL(html).href;
    const config = { params: { sn: 'SN-A', pkg: 'com.example.vulkan' }, rules: {} };
    const session = new Session({ mode: 'web', url }, { headless: true, ...config });
    session.page = page;
    await session.goto(url);
    const snapshot = await session.snapshot();
    expect(snapshot).toContain('combobox  "Target device:"');
    expect(snapshot).toContain('[placeholder: "Click to search"]');
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url });
    const flag = { done: false, summary: '', rejects: 0 };
    const tools = makeTools({ session, traj, runDir: dir, mark: 1, vision: false, flag,
      config, description: '选择 ${sn}，搜索 ${pkg} 并选择，预期已选应用为 ${pkg}', needsAssert: true });
    const options = { toolCallId: 'test', messages: [], context: undefined };
    expect(await tools.select_option.execute!({ target: 'Target device:', value: '${sn}' }, options)).toContain('已选择');
    expect(await tools.fill.execute!({ target: 'Click to search', text: '${pkg}' }, options)).toContain('已填入');
    expect(await tools.click.execute!({ target: '${pkg}' }, options)).toContain('已点击');
    await expect(page.getByText(config.params.pkg, { exact: true })).toHaveCount(2);
    // The title is a leaf div; correcting the assertion scope must recover this failure.
    expect(await tools.assert_text.execute!({ target: 'Application to profile', text: '${pkg}' }, options)).toContain('操作失败');
    expect(await tools.assert_text.execute!({ target: 'Application to profile', text: '${pkg}', container_role: 'listitem' }, options)).toContain('断言通过');
    await tools.step_done.execute!({ summary: '设备和应用均已选择并验证' }, options);
    expect(flag.done).toBe(true);
    expect(traj.steps.at(-1)).toEqual({ kind: 'assertText', target: { kind: 'container', role: 'listitem', text: 'Application to profile' }, text: '${pkg}' });
    const code = renderTest(traj, { testName: 'selected application', description: '', target: { mode: 'web', url } });
    for (const sample of Object.values(config.params)) expect(code).not.toContain(sample);
    expect(code).toContain("getByRole('listitem').filter({ has: page.getByText('Application to profile', { exact: true }) })");
    const spec = join(dir, 'selection.spec.ts');
    writeFileSync(spec, code); writeRuntime(dir);
    writeFileSync(html, fixture('SN-B', 'com.other.gles'));
    const next = { sn: 'SN-B', pkg: 'com.other.gles' };
    const passed = await runPlaywright(spec, 25000, next);
    expect(passed.passed, passed.output).toBe(true);
    writeFileSync(html, fixture('SN-B', 'com.other.gles', false));
    const failed = await runPlaywright(spec, 25000, next);
    expect(failed.passed).toBe(false);
    expect(failed.output).toContain('old.package');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('容器断言不扩大到搜索结果，不接受重复标题的多行', async ({ page }) => {
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true, params: { pkg: 'com.example.vulkan' } });
  session.page = page;
  await page.setContent(fixture('SN-A', 'com.example.vulkan'));
  await expect(session.assertText('Application to profile', '${pkg}', 'listitem')).rejects.toThrow('old.package');
  await page.locator('#selected').evaluate(el => { el.textContent = 'com.example.vulkan'; });
  await page.locator('li').evaluate(el => { el.after(el.cloneNode(true)); });
  await expect(session.assertText('Application to profile', '${pkg}', 'listitem')).rejects.toThrow('必须唯一');
  await expect(session.assertText('e1', '${pkg}', 'listitem')).rejects.toThrow('不是空值、ref');
});

test('只向探索暴露描述显式引用的规则，未引用的示例 scope 不参与定位', () => {
  const config = { params: { sn: 'SN-A' }, rules: {
    device: { scope: '[data-testid="record-panel"]', text: 'Target device', match: 'exact' as const, pick: 'unique' as const },
    app: { scope: '#apps', text: '${sn}', match: 'exact' as const, pick: 'unique' as const },
  } };
  expect(configForDescription('选择 ${sn}，联系 name@app.com', config)).toEqual({ params: config.params, rules: {} });
  expect(configForDescription('点击 @device；再次点击 @device', config)).toEqual({ params: config.params, rules: { device: config.rules.device } });
  expect(Object.keys(config.rules)).toEqual(['device', 'app']);
});
