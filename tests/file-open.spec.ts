import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../src/browser';
import { clickAndOpen, OPEN_HELPER_TS } from '../src/file-open';
import { renderTest, computeTimeout } from '../src/codegen';
import { makeTools } from '../src/engine';
import { writeRuntime } from '../src/config';
import { runPlaywright } from '../src/runner';
import { Trajectory } from '../src/trajectory';

function tempDir() {
  const root = join(process.cwd(), 'output');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'file-open-'));
}

const uploadHTML = `<button title="Import file" onclick="setTimeout(() => document.querySelector('input').click(), 50)">Import</button>
  <input type="file" hidden onchange="this.files[0].text().then(text => document.querySelector('output').textContent = text)">
  <output data-testid="result"></output><button>No chooser</button>`;

test('真实文件选择、参数保留、页面断言门和生成脚本换参回放', async ({ page }) => {
  test.setTimeout(60000);
  const dir = tempDir();
  try {
    // Deliberately outside the run directory; imports must never delete sources.
    const inputs = join(dir, '本地 文件'); mkdirSync(inputs);
    writeFileSync(join(inputs, 'one.rdc'), 'Explorer one');
    writeFileSync(join(inputs, "two 'quoted'.rdc"), 'Explorer two');
    const runDir = join(dir, 'run'); mkdirSync(runDir);
    const html = join(dir, 'app.html'); writeFileSync(html, uploadHTML);
    const url = pathToFileURL(html).href;
    await page.goto(url);
    const params = { rdcPath: inputs, rdcName: 'one.rdc' };
    const session = new Session({ mode: 'web', url }, { headless: true, params });
    session.page = page;
    await session.snapshot();
    const traj = new Trajectory(); traj.add({ kind: 'goto', url });
    const flag = { done: false, summary: '', rejects: 0 };
    const tools = makeTools({ session, traj, runDir, vision: false, mark: 1, needsAssert: true, flag,
      config: { params, rules: {} }, description: '导入 ${rdcPath} 下的 ${rdcName}，预期显示 Explorer' });
    const options = { toolCallId: 'test', messages: [], context: undefined };
    expect(await tools.click_and_open.execute!({ target: 'Import file', file_path: '${rdcPath}/${rdcName}', timeout_seconds: 5 }, options))
      .toContain('已点击并选择本地文件');
    await expect(page.getByTestId('result')).toHaveText('Explorer one');
    expect((page as any).listenerCount('filechooser')).toBe(0);
    expect(traj.steps[1]).toEqual({ kind: 'clickOpen', target: { kind: 'role', role: 'button', name: 'Import' }, path: '${rdcPath}/${rdcName}', timeoutMs: 5000 });
    await tools.step_done.execute!({ summary: 'selected' }, options);
    expect(flag.done).toBe(false); // Source exists / selection alone cannot verify the app.
    await tools.assert_text.execute!({ target: 'Explorer one', text: 'Explorer' }, options);
    await tools.step_done.execute!({ summary: 'imported' }, options);
    expect(flag.done).toBe(true);
    // Use a stable output locator for the independent replay under another file name.
    traj.steps[2] = { kind: 'assertText', target: { kind: 'testId', testId: 'result' }, text: 'Explorer two' };
    const code = renderTest(traj, { testName: 'open', description: '', target: { mode: 'web', url } });
    expect(code).toContain('// pwgen-parameters: ["rdcPath","rdcName"]');
    expect(code).toContain('paramText("${rdcPath}/${rdcName}", params)');
    expect(code).not.toContain(inputs);
    expect(code).not.toContain('rmSync');
    expect(code).not.toContain('__name');
    const spec = join(runDir, 'open.spec.ts'); writeFileSync(spec, code); writeRuntime(runDir);
    const result = await runPlaywright(spec, 25000, { rdcPath: inputs, rdcName: "two 'quoted'.rdc" });
    expect(result.passed, result.output).toBe(true);
    expect(readFileSync(join(inputs, 'one.rdc'), 'utf8')).toBe('Explorer one');
    expect(readFileSync(join(inputs, "two 'quoted'.rdc"), 'utf8')).toBe('Explorer two');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('缺失文件、目录、选择器超时和失败点击不记录，能恢复后继续导入', async ({ page }) => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'input.rdc'), 'valid');
    await page.setContent(uploadHTML);
    const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
    session.page = page; await session.snapshot();
    const traj = new Trajectory();
    const flag = { done: false, summary: '', rejects: 0 };
    const tools = makeTools({ session, traj, runDir: dir, vision: false, mark: 0, needsAssert: false, flag,
      config: { params: {}, rules: {} }, description: 'import' });
    const options = { toolCallId: 'test', messages: [], context: undefined };
    for (const file_path of ['missing.rdc', '.']) {
      expect(await tools.click_and_open.execute!({ target: 'Import file', file_path, timeout_seconds: 1 }, options)).toContain('无法打开本地文件');
    }
    expect(await tools.click_and_open.execute!({ target: 'No chooser', file_path: 'input.rdc', timeout_seconds: 1 }, options)).toContain('打开文件超时');
    await expect(clickAndOpen(page, undefined, page.getByText('not present'), 'input.rdc', dir, 100)).rejects.toThrow();
    expect((page as any).listenerCount('filechooser')).toBe(0);
    expect(traj.steps).toHaveLength(0);
    await tools.step_done.execute!({ summary: 'done' }, options);
    expect(flag.done).toBe(false);
    expect(await tools.click_and_open.execute!({ target: 'Import file', file_path: 'input.rdc', timeout_seconds: 1 }, options)).toContain('已点击并选择本地文件');
    await tools.step_done.execute!({ summary: 'done' }, options);
    expect(flag.done).toBe(true);
    await expect(page.getByTestId('result')).toHaveText('valid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('导入工具拒绝固化参数，并计入回放超时；普通用例不注入文件工具', async () => {
  const traj = new Trajectory();
  const opened: string[] = [];
  const tools = makeTools({ session: {
    clickAndOpen: async (_target: string, path: string) => { opened.push(path); return { kind: 'text', text: 'Import' }; },
    snapshot: async () => 'state',
  } as unknown as Session, traj, runDir: '.', vision: false, mark: 0, needsAssert: false,
  flag: { done: false, summary: '', rejects: 0 }, config: { params: { inputFile: 'example.rdc' }, rules: {} }, description: '${inputFile}' });
  const options = { toolCallId: 'test', messages: [], context: undefined };
  expect(await tools.click_and_open.execute!({ target: 'Import', file_path: 'example.rdc' }, options)).toContain('样例值不能写死');
  expect(opened).toEqual([]);
  await tools.click_and_open.execute!({ target: 'Import', file_path: '${inputFile}', timeout_seconds: 900 }, options);
  expect(opened).toEqual(['${inputFile}']);
  expect(computeTimeout(traj)).toBe(631000);
  expect(OPEN_HELPER_TS).not.toContain('__name');
  const code = renderTest(new Trajectory(), { testName: 'ui', description: '', target: { mode: 'web', url: '' } });
  expect(code).not.toContain('node:fs');
  expect(code).not.toContain('clickAndOpen');
});

const electronBin = process.env.PWGEN_TEST_ELECTRON_BIN;
const fixture = resolve('tests/fixtures/file-open.cjs');
test('真实 Electron 原生异步/同步打开、补丁恢复及生成用例换参回放', async () => {
  test.skip(!electronBin, '设置 PWGEN_TEST_ELECTRON_BIN 为 Electron 可执行文件以运行原生对话框集成测试');
  test.setTimeout(60000);
  const dir = tempDir();
  const target = { mode: 'electron' as const, bin: electronBin!, args: [fixture] };
  const session = new Session(target, { headless: false, params: { inputFile: 'first.rdc' } });
  try {
    writeFileSync(join(dir, 'first.rdc'), 'Explorer first');
    writeFileSync(join(dir, 'second 文件.rdc'), 'Explorer second');
    await session.start(); await session.snapshot();
    const descriptor = await session.clickAndOpen('Import file', '${inputFile}', dir, 5000);
    await expect(session.page.getByTestId('result')).toHaveText('Explorer first');
    expect(await session.page.evaluate(() => (window as any).require('electron').ipcRenderer.invoke('dialogs-restored'))).toBe(true);
    await expect(session.clickAndOpen('No chooser', 'first.rdc', dir, 1000)).rejects.toThrow('打开文件超时');
    expect(await session.page.evaluate(() => (window as any).require('electron').ipcRenderer.invoke('dialogs-restored'))).toBe(true);
    await session.page.getByRole('button', { name: 'No chooser' }).evaluate(el => { (el as HTMLButtonElement).disabled = true; });
    await expect(session.clickAndOpen('No chooser', 'first.rdc', dir, 200)).rejects.toThrow('locator.click');
    expect(await session.page.evaluate(() => (window as any).require('electron').ipcRenderer.invoke('dialogs-restored'))).toBe(true);
    await session.clickAndOpen('Import sync', 'second 文件.rdc', dir, 5000);
    await expect(session.page.getByTestId('result')).toHaveText('Explorer second');
    expect(await session.page.evaluate(() => (window as any).require('electron').ipcRenderer.invoke('dialogs-restored'))).toBe(true);
    await session.clickAndOpen('Renderer upload', 'first.rdc', dir, 5000);
    await expect(session.page.getByTestId('result')).toHaveText('Explorer first');
    expect(await session.page.evaluate(() => (window as any).require('electron').ipcRenderer.invoke('dialogs-restored'))).toBe(true);
    expect((session.page as any).listenerCount('filechooser')).toBe(0);
    await session.close();
    const traj = new Trajectory();
    traj.add({ kind: 'clickOpen', target: descriptor, path: '${inputFile}', timeoutMs: 5000 });
    traj.add({ kind: 'assertText', target: { kind: 'testId', testId: 'result' }, text: 'Explorer second' });
    const code = renderTest(traj, { testName: 'native import', description: '', target });
    expect(code).toContain('clickAndOpen(page, electronApp,');
    const spec = join(dir, 'native.spec.ts'); writeFileSync(spec, code); writeRuntime(dir);
    const result = await runPlaywright(spec, 25000, { inputFile: join(dir, 'second 文件.rdc') });
    expect(result.passed, result.output).toBe(true);
  } finally { await session.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
