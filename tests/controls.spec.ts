import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/browser';
import { loadConfig, validateDescription, writeRuntime } from '../src/config';
import { resolveRule } from '../src/runtime';
import { renderTest } from '../src/codegen';
import { runPlaywright } from '../src/runner';
import { Trajectory } from '../src/trajectory';

const sessionFor = (page: import('@playwright/test').Page) => {
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
  session.page = page;
  return session;
};

test('无名数字字段关联局部标签，执行与生成共用定位，提交后的值才是结果', async ({ page }) => {
  await page.setContent(`<div><span>Poll interval</span><div><input type="number" value="1000" min="10" max="1000" step="10" onblur="this.value=Math.max(10, Number(this.value))"><span>us</span></div></div>`);
  const session = sessionFor(page);
  const state = await session.snapshot();
  expect(state).toContain('spinbutton  "(无名)"');
  expect(state).toContain('邻近字段: "Poll interval" (非 accessible name)');
  expect(state).toContain('value: "1000"');
  expect(state).toContain('min: 10');
  expect(state).toContain('单位: us');
  const target = await session.fill('Poll interval', '100');
  expect(target.kind).toBe('field');
  await session.press('Tab', 'Poll interval');
  await session.assertValue('Poll interval', '100', 500);
  await session.fill('Poll interval', '1');
  await session.press('Tab', 'Poll interval');
  await expect(session.assertValue('Poll interval', '1', 100)).rejects.toThrow();
  await session.assertValue('Poll interval', '10', 500);
});

test('图标 title 入口进入快照；重复 title 不会静默固化序号', async ({ page }) => {
  await page.setContent('<div title="Import trace file" onclick="document.querySelector(\'output\').textContent=\'opened\'"><i>folder</i></div><output></output>');
  const session = sessionFor(page);
  expect(await session.snapshot()).toContain('title: "Import trace file"');
  expect(await session.click('Import trace file')).toEqual({ kind: 'title', text: 'Import trace file' });
  await expect(page.locator('output')).toHaveText('opened');
  await page.setContent('<div title="Refresh"><i>A</i></div><div title="Refresh"><i>B</i></div>');
  await session.snapshot();
  await expect(session.resolve('Refresh', 100)).rejects.toThrow('多个');
  await expect(session.resolve('e1', 100)).rejects.toThrow('稳定唯一');
  await page.setContent('<button title="Refresh"></button><button title="Refresh"></button>');
  await session.snapshot();
  await expect(session.resolve('e1', 100)).rejects.toThrow('稳定唯一');
});

test('带 testId 的字段容器不会抢占数字框的 fill/press/value 操作', async ({ page }) => {
  await page.setContent('<div data-testid="field"><span>Poll interval</span><input type="number" value="1000"><span>us</span></div>');
  const session = sessionFor(page);
  await session.snapshot();
  expect((await session.fill('Poll interval', '100')).kind).toBe('field');
  await session.press('Tab', 'Poll interval');
  await session.assertValue('Poll interval', '100', 500);
});

test('按键保持命名按钮优先，填写仍定位同名 placeholder 的表单控件', async ({ page }) => {
  await page.setContent('<button aria-label="Run" onclick="document.querySelector(\'output\').textContent=\'button\'">执行</button><input placeholder="Run"><output></output>');
  const session = sessionFor(page);
  await session.snapshot();
  await session.press('Enter', 'Run');
  await expect(page.locator('output')).toHaveText('button');
  await session.fill('Run', 'typed');
  await expect(page.locator('input')).toHaveValue('typed');
  const parameterized = new Session({ mode: 'web', url: 'about:blank' }, { headless: true, params: { label: 'Run' } });
  parameterized.page = page;
  await parameterized.snapshot();
  await parameterized.press('Enter', '${label}');
  await parameterized.fill('${label}', 'next');
  await expect(page.locator('input')).toHaveValue('next');
});

test('同名邻近字段不擅自选第一个；稳定 ID 仍可通过显式规则定位', async ({ page }) => {
  await page.setContent('<section><span>Poll interval</span><input id="gpu-poll" type="number"></section><section><span>Poll interval</span><input type="number"></section>');
  const session = sessionFor(page);
  await session.snapshot();
  await expect(session.resolve('Poll interval', 100)).rejects.toThrow('多个');
  await (await resolveRule(page, { scope: 'body', locator: { kind: 'css', value: '#gpu-poll' }, pick: 'unique' }, {}, 500)).fill('100');
  await expect(page.locator('#gpu-poll')).toHaveValue('100');
});

test('字段关系和 title 的生成用例，在外部控件插入后仍能正确回放', async ({ page }) => {
  test.setTimeout(60000);
  mkdirSync('output', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), 'output', 'controls-'));
  try {
    const html = join(dir, 'fixture.html');
    const fixture = (extra = '') => `${extra}<div title="Open settings" onclick="document.querySelector('input[disabled]').disabled=false">settings</div><div><span>Poll interval</span><input type="number" value="1000" disabled><span>us</span></div>`;
    writeFileSync(html, fixture());
    const url = pathToFileURL(html).href;
    const session = sessionFor(page);
    await session.goto(url);
    await session.snapshot();
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url });
    traj.add({ kind: 'click', target: await session.click('Open settings') });
    traj.add({ kind: 'fill', target: await session.fill('Poll interval', '100'), value: '100' });
    traj.add({ kind: 'press', target: (await session.resolve('Poll interval')).descriptor, key: 'Tab' });
    traj.add({ kind: 'assertValue', target: await session.assertValue('Poll interval', '100'), value: '100' });
    const spec = join(dir, 'controls.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'controls', description: '', target: { mode: 'web', url } }));
    writeFileSync(html, fixture('<input type="number" value="777"><input placeholder="unrelated">'));
    const result = await runPlaywright(spec, 25000);
    expect(result.passed, result.failureSummary ?? result.output).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('新旧规则兼容，参数精确匹配；拒绝 CSS 插值和混合规则语义', async ({ page }) => {
  mkdirSync('output', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), 'output', 'rules-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ params: { label: 'Import A' }, rules: {
      icon: { locator: { kind: 'title', value: '${label}' } },
      old: { scope: '#settings', text: 'Poll interval', pick: 'unique' },
      number: { locator: { kind: 'role', role: 'spinbutton' }, scope: '#settings' },
    } }));
    const config = loadConfig(path);
    validateDescription('点击 @icon，验证 ${label}；填入 @number', config);
    await page.setContent('<div title="Import A">A</div><div title="Import B">B</div><div id="settings"><span>Poll interval</span><input type="number"></div>');
    await expect(await resolveRule(page, config.rules.icon, config.params, 500)).toHaveText('A');
    await expect(await resolveRule(page, config.rules.icon, { label: 'Import B' }, 500)).toHaveText('B');
    await expect(await resolveRule(page, config.rules.number, {}, 500)).toHaveAttribute('type', 'number');
    writeFileSync(path, JSON.stringify({ rules: { unsafe: { locator: { kind: 'css', value: '#${label}' } } } }));
    expect(() => loadConfig(path)).toThrow();
    await expect(resolveRule(page, { scope: 'body', pick: 'unique', locator: { kind: 'css', value: '#${label}' } }, { label: 'x' }, 100)).rejects.toThrow('不支持参数插值');
    writeFileSync(path, JSON.stringify({ rules: { mixed: { text: 'x', locator: { kind: 'title', value: 'x' } } } }));
    expect(() => loadConfig(path)).toThrow();
    writeRuntime(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('新 locator 规则通过工具轨迹生成后可换参回放', async ({ page }) => {
  test.setTimeout(30000);
  mkdirSync('output', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), 'output', 'rule-replay-'));
  try {
    const html = join(dir, 'fixture.html');
    writeFileSync(html, '<div title="Settings" onclick="document.querySelector(\'input\').disabled=false">settings</div><input id="poll" type="number" value="1000" disabled>');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ params: { pollUs: '100' }, rules: {
      open: { locator: { kind: 'title', value: 'Settings' } },
      poll: { locator: { kind: 'css', value: '#poll' } },
    } }));
    const config = loadConfig(configPath);
    const session = new Session({ mode: 'web', url: pathToFileURL(html).href }, { headless: true, ...config });
    session.page = page;
    await session.goto(pathToFileURL(html).href);
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url: pathToFileURL(html).href });
    traj.add({ kind: 'click', target: await session.click('@open') });
    traj.add({ kind: 'fill', target: await session.fill('@poll', '${pollUs}'), value: '${pollUs}' });
    traj.add({ kind: 'assertValue', target: await session.assertValue('@poll', '${pollUs}'), value: '${pollUs}' });
    const spec = join(dir, 'rules.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'rules', description: '', target: { mode: 'web', url: '' } }));
    writeRuntime(dir);
    const result = await runPlaywright(spec, 20000, { pollUs: '250' });
    expect(result.passed, result.failureSummary ?? result.output).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('已选应用的准备操作仍录制，回放默认/其他/相同应用均能建立目标状态', async ({ page }) => {
  test.setTimeout(30000);
  mkdirSync('output', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), 'output', 'setup-selection-'));
  try {
    const html = join(dir, 'fixture.html');
    const fixture = (selected: string) => `<label>Application to profile<select>${['System', 'wanted.app', 'other.app'].map(value => `<option ${value === selected ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`;
    writeFileSync(html, fixture('wanted.app'));
    const url = pathToFileURL(html).href;
    const session = new Session({ mode: 'web', url }, { headless: true, params: { pkg: 'wanted.app' } });
    session.page = page;
    await session.goto(url);
    await session.snapshot();
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url });
    traj.add({ kind: 'stepStart', title: '准备：重新选择目标应用' });
    traj.add({ kind: 'selectOption', target: await session.selectOption('Application to profile', '${pkg}'), value: '${pkg}' });
    traj.add({ kind: 'stepStart', title: '验证已选应用' });
    traj.add({ kind: 'assertValue', target: await session.assertValue('Application to profile', '${pkg}'), value: '${pkg}' });
    const spec = join(dir, 'setup.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'setup', description: '', target: { mode: 'web', url } }));
    writeRuntime(dir);
    for (const initial of ['System', 'other.app', 'wanted.app']) {
      writeFileSync(html, fixture(initial));
      const result = await runPlaywright(spec, 10000, { pkg: 'wanted.app' });
      expect(result.passed, `${initial}: ${result.failureSummary ?? result.output}`).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
