/**
 * 纯逻辑单测(在 @playwright/test 下运行,无需浏览器):
 * 步骤拆分、定位描述符推导/渲染、codegen(web/electron、test.step 分块、超时计算)。
 */

import { test, expect } from '@playwright/test';

import { computeTimeout, renderTest } from '../src/codegen';
import { splitSteps } from '../src/engine';
import { candidateDescriptors, jsLit, renderLocator, type SnapshotItem } from '../src/locators';
import { execShell } from '../src/shell';
import { Trajectory } from '../src/trajectory';

function item(p: Partial<SnapshotItem>): SnapshotItem {
  return {
    role: '',
    name: '',
    placeholder: '',
    testid: '',
    tag: '',
    type: '',
    sameKeyIndex: 0,
    sameKeyCount: 1,
    roleIndex: 0,
    roleCount: 1,
    ...p,
  };
}

// ---------- splitSteps ----------

test('splitSteps: 无步骤标注 → 整段为单一步骤', () => {
  const plan = splitSteps('打开设置弹窗,开启深色模式,验证出现提示');
  expect(plan.steps).toHaveLength(1);
  expect(plan.steps[0].text).toContain('打开设置弹窗');
});

test('splitSteps: 句号相连的多步骤描述(真实用例格式)', () => {
  const desc =
    '步骤1:点击Record trace,在Target device处选择一个设备进行连接。' +
    '步骤2:在Probes下面点击Disable all,点击Start Session。' +
    '步骤3:点击Record trace,选择一个opengl应用。' +
    '步骤4:点击Start Recording,预期自动跳转到Timeline页面。';
  const plan = splitSteps(desc);
  expect(plan.steps.map((s) => s.title)).toEqual(['步骤1', '步骤2', '步骤3', '步骤4']);
  expect(plan.steps[2].text).toContain('opengl');
  expect(plan.steps[3].text).toContain('Timeline');
});

test('splitSteps: 换行分隔 + 全角冒号', () => {
  const desc = '步骤1:连接设备。\n步骤2:开始录制,预期跳转到TimeLine页面。\n步骤3:关闭开关再录制\n确保每个步骤都执行到';
  const plan = splitSteps(desc);
  expect(plan.steps).toHaveLength(3);
  expect(plan.steps[2].text).toContain('确保每个步骤都执行到'); // 尾部说明并入最后一步,不丢失
});

test('splitSteps: 句中引用"步骤N"不触发拆分;背景前言保留', () => {
  const desc = '在设置页完成以下操作。步骤1:打开开关。步骤2:重复步骤1的操作再关闭开关。';
  const plan = splitSteps(desc);
  expect(plan.steps).toHaveLength(2);
  expect(plan.preamble).toContain('在设置页完成以下操作');
  expect(plan.steps[1].text).toContain('重复步骤1的操作');
});

test('splitSteps: 英文 Step N:', () => {
  const plan = splitSteps('Step 1: open settings. Step 2: toggle dark mode, expect a toast.');
  expect(plan.steps).toHaveLength(2);
  expect(plan.steps[0].text).toContain('open settings');
});

test('splitSteps: "第N步:"变体', () => {
  const plan = splitSteps('第1步:打开设置。第2步:切换主题,预期出现提示。');
  expect(plan.steps.map((s) => s.title)).toEqual(['步骤1', '步骤2']);
});

// ---------- 定位 ----------

test('candidateDescriptors: 命名按钮首选 role+name', () => {
  const c = candidateDescriptors(item({ role: 'button', name: '保存', tag: 'button' }));
  expect(c[0]).toEqual({ kind: 'role', role: 'button', name: '保存' });
});

test('candidateDescriptors: 表单控件补充 getByLabel 候选(兜住 password)', () => {
  const c = candidateDescriptors(item({ role: 'textbox', name: '密码', tag: 'input' }));
  expect(c[0]).toEqual({ kind: 'role', role: 'textbox', name: '密码' });
  expect(c).toContainEqual({ kind: 'label', text: '密码' });
});

test('candidateDescriptors: placeholder/testid 兜底,role+nth 收尾', () => {
  const c = candidateDescriptors(
    item({ role: 'textbox', name: '', placeholder: 'you@x.com', testid: 'email', tag: 'input' }),
  );
  expect(c).toContainEqual({ kind: 'placeholder', text: 'you@x.com' });
  expect(c).toContainEqual({ kind: 'testId', testId: 'email' });
  expect(c[c.length - 1]).toEqual({ kind: 'role', role: 'textbox', nth: 0 });
});

test('renderLocator: 各种描述符', () => {
  expect(renderLocator({ kind: 'role', role: 'button', name: '保存' })).toBe(
    `page.getByRole('button', { name: '保存' })`,
  );
  expect(renderLocator({ kind: 'role', role: 'button', name: '保存', nth: 1 })).toBe(
    `page.getByRole('button', { name: '保存' }).nth(1)`,
  );
  expect(renderLocator({ kind: 'label', text: '密码' })).toBe(`page.getByLabel('密码')`);
  expect(renderLocator({ kind: 'placeholder', text: 'you@x.com' })).toBe(`page.getByPlaceholder('you@x.com')`);
  expect(renderLocator({ kind: 'testId', testId: 'email' })).toBe(`page.getByTestId('email')`);
  expect(renderLocator({ kind: 'text', text: '欢迎' })).toBe(`page.getByText('欢迎')`);
  expect(renderLocator({ kind: 'role', role: 'button', nth: 0 })).toBe(`page.getByRole('button').nth(0)`);
});

test('jsLit: 转义引号/反斜杠/换行', () => {
  expect(jsLit(`a'b`)).toBe(`'a\\'b'`);
  expect(jsLit(`a\\b`)).toBe(`'a\\\\b'`);
  expect(jsLit(`a\nb`)).toBe(`'a\\nb'`);
});

// ---------- codegen ----------

test('renderTest: web 形态(无步骤标注 → 无 test.step 包裹)', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'https://x.test/' });
  t.add({ kind: 'click', target: { kind: 'role', role: 'button', name: 'Go' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'ok' } });
  const code = renderTest(t, { testName: 'demo', description: 'd', target: { mode: 'web', url: 'https://x.test/' } });
  expect(code).toContain(`import { test, expect } from '@playwright/test';`);
  expect(code).toContain(`test('demo', async ({ page }) => {`);
  expect(code).toContain('test.setTimeout(');
  expect(code).toContain(`await page.goto('https://x.test/');`);
  expect(code).toContain(`await page.getByRole('button', { name: 'Go' }).click();`);
  expect(code).toContain(`await expect(page.getByText('ok')).toBeVisible();`);
  expect(code).not.toContain('test.step(');
});

test('renderTest: 多步骤 → 同一用例内 test.step 分块,goto 在块外', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'https://x.test/' });
  t.add({ kind: 'stepStart', title: '步骤1:登录' });
  t.add({ kind: 'fill', target: { kind: 'label', text: '用户名' }, value: 'u' });
  t.add({ kind: 'stepStart', title: '步骤2:验证' });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: '欢迎' } });
  const code = renderTest(t, { testName: 'multi', description: 'd', target: { mode: 'web', url: 'https://x.test/' } });
  expect(code).toContain(`await test.step('步骤1:登录', async () => {`);
  expect(code).toContain(`await test.step('步骤2:验证', async () => {`);
  const gotoAt = code.indexOf('page.goto');
  const firstStepAt = code.indexOf('test.step');
  expect(gotoAt).toBeGreaterThan(-1);
  expect(gotoAt).toBeLessThan(firstStepAt);
  // 只有一个 test(...) 用例
  expect(code.match(/\btest\(/g)).toHaveLength(1);
});

test('renderTest: electron 形态(executablePath + firstWindow + try/finally)', () => {
  const t = new Trajectory();
  t.add({ kind: 'click', target: { kind: 'role', role: 'button', name: 'Save' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'Saved' } });
  const code = renderTest(t, {
    testName: 'app',
    description: 'd',
    target: { mode: 'electron', bin: 'C:\\Apps\\My\\My.exe', args: ['--foo'] },
  });
  expect(code).toContain(`_electron as electron`);
  expect(code).toContain(`electron.launch({ executablePath: 'C:\\\\Apps\\\\My\\\\My.exe', args: ['--foo'] })`);
  expect(code).toContain(`const page = await electronApp.firstWindow();`);
  expect(code).toContain('try {');
  expect(code).toContain('} finally {');
  expect(code).toContain(`await electronApp.close();`);
  expect(code).not.toContain(`async ({ page })`);
  expect(code).not.toContain(`page.goto`);
});

test('renderTest: uncheck 与带超时的长等待(wait_for 记录)', () => {
  const t = new Trajectory();
  t.add({ kind: 'uncheck', target: { kind: 'role', role: 'switch', name: 'collect user-mode data' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'Timeline', nth: 0 }, timeoutMs: 180_000 });
  const code = renderTest(t, { testName: 'w', description: 'd', target: { mode: 'web', url: 'u' } });
  expect(code).toContain(`.uncheck();`);
  expect(code).toContain(`await expect(page.getByText('Timeline').nth(0)).toBeVisible({ timeout: 180000 });`);
});

test('computeTimeout: 计入动作数与长等待预算', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'u' });
  t.add({ kind: 'click', target: { kind: 'text', text: 'a' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'b' }, timeoutMs: 120_000 });
  // 30s 基础 + 3 个动作×1s + 120s 等待
  expect(computeTimeout(t)).toBe(30_000 + 3_000 + 120_000);
  const generated = renderTest(t, { testName: 'x', description: 'd', target: { mode: 'web', url: 'u' } });
  expect(generated).toContain(`test.setTimeout(${30_000 + 3_000 + 120_000});`);
});

// ---------- runCommand / writeFile codegen ----------

test('renderTest: runCommand 步骤 → 注入 child_process import 与 runCommand 辅助函数', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'https://x.test/' });
  t.add({
    kind: 'runCommand',
    command: 'hdc shell',
    stdin: ['cd vendor/bin', 'counters gather xxx', 'exit'],
    timeoutMs: 120_000,
  });
  const code = renderTest(t, { testName: 'cmd', description: 'd', target: { mode: 'web', url: 'https://x.test/' } });
  expect(code).toContain(`import { spawn } from 'node:child_process';`);
  expect(code).toContain(`import { dirname } from 'node:path';`);
  expect(code).toContain('async function runCommand(');
  expect(code).toContain(
    `expect(await runCommand('hdc shell', ['cd vendor/bin', 'counters gather xxx', 'exit'], 120000)).toBe(0);`,
  );
});

test('renderTest: runCommand 无 stdin → 传 undefined;writeFile → 注入 fs/path import 与内容转义', () => {
  const t = new Trajectory();
  t.add({ kind: 'runCommand', command: 'echo hello', timeoutMs: 60_000 });
  t.add({ kind: 'writeFile', path: 'out/trace.cfg', content: 'line1\nline2' });
  const code = renderTest(t, { testName: 'wf', description: 'd', target: { mode: 'web', url: 'u' } });
  expect(code).toContain(`expect(await runCommand('echo hello', undefined, 60000)).toBe(0);`);
  expect(code).toContain(`import { mkdirSync, writeFileSync } from 'node:fs';`);
  expect(code).toContain(`import { dirname, resolve } from 'node:path';`);
  expect(code).toContain('function writeFileTo(');
  expect(code).toContain(`writeFileTo('out/trace.cfg', 'line1\\nline2');`);
});

test('renderTest: 纯 UI 轨迹不注入 node: import 与辅助函数(产物与从前一致)', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'u' });
  t.add({ kind: 'click', target: { kind: 'text', text: 'a' } });
  const code = renderTest(t, { testName: 'ui', description: 'd', target: { mode: 'web', url: 'u' } });
  expect(code).not.toContain('node:child_process');
  expect(code).not.toContain('node:fs');
  expect(code).not.toContain('runCommand(');
  expect(code).not.toContain('writeFileTo(');
  expect(code).not.toContain('clickAndSave(');
});

// ---------- clickSave(click_and_save)codegen ----------

test('renderTest: clickSave web 形态 → 注入 fs/path import 与 clickAndSave 辅助函数,electronApp 传 undefined', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'https://x.test/' });
  t.add({
    kind: 'clickSave',
    target: { kind: 'role', role: 'button', name: '保存' },
    path: 'GPU_Counters_Data.csv',
    timeoutMs: 60_000,
  });
  const code = renderTest(t, { testName: 'sv', description: 'd', target: { mode: 'web', url: 'https://x.test/' } });
  expect(code).toContain(`import { existsSync, mkdirSync, rmSync } from 'node:fs';`);
  expect(code).toContain(`import { dirname, resolve } from 'node:path';`);
  expect(code).toContain('async function clickAndSave(');
  expect(code).toContain(
    `await clickAndSave(page, undefined, page.getByRole('button', { name: '保存' }), 'GPU_Counters_Data.csv', 60000);`,
  );
});

test('renderTest: clickSave electron 形态 → 传 electronApp(回放时 stub 原生保存对话框)', () => {
  const t = new Trajectory();
  t.add({
    kind: 'clickSave',
    target: { kind: 'role', role: 'button', name: 'Save' },
    path: 'out.csv',
    timeoutMs: 120_000,
  });
  const code = renderTest(t, {
    testName: 'app',
    description: 'd',
    target: { mode: 'electron', bin: '/apps/my', args: [] },
  });
  expect(code).toContain('_electron as electron');
  expect(code).toContain(
    `await clickAndSave(page, electronApp, page.getByRole('button', { name: 'Save' }), 'out.csv', 120000);`,
  );
  expect(code).toContain('dialog.showSaveDialog');
});

test('renderTest: clickSave 与 writeFile 共存 → fs import 合并去重', () => {
  const t = new Trajectory();
  t.add({ kind: 'writeFile', path: 'a.txt', content: 'x' });
  t.add({ kind: 'clickSave', target: { kind: 'text', text: '保存' }, path: 'b.csv', timeoutMs: 60_000 });
  const code = renderTest(t, { testName: 'mix', description: 'd', target: { mode: 'web', url: 'u' } });
  expect(code).toContain(`import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';`);
  expect(code).toContain(`import { dirname, resolve } from 'node:path';`);
  expect(code).toContain('function writeFileTo(');
  expect(code).toContain('async function clickAndSave(');
});

test('computeTimeout: 计入 clickSave 的完整超时预算', () => {
  const t = new Trajectory();
  t.add({ kind: 'clickSave', target: { kind: 'text', text: '保存' }, path: 'b.csv', timeoutMs: 90_000 });
  t.add({ kind: 'click', target: { kind: 'text', text: 'a' } });
  // 30s 基础 + 2 个动作×1s + 90s 保存预算
  expect(computeTimeout(t)).toBe(30_000 + 2_000 + 90_000);
});

test('renderTest: electron 形态 + runCommand → 辅助函数与 _electron 共存', () => {
  const t = new Trajectory();
  t.add({ kind: 'runCommand', command: 'echo ok', timeoutMs: 60_000 });
  t.add({ kind: 'click', target: { kind: 'role', role: 'button', name: 'Start' } });
  const code = renderTest(t, {
    testName: 'app',
    description: 'd',
    target: { mode: 'electron', bin: '/apps/my', args: [] },
  });
  expect(code).toContain('_electron as electron');
  expect(code).toContain(`import { spawn } from 'node:child_process';`);
  expect(code).toContain('async function runCommand(');
  expect(code).toContain(`expect(await runCommand('echo ok', undefined, 60000)).toBe(0);`);
});

test('computeTimeout: 计入 runCommand 的完整超时预算', () => {
  const t = new Trajectory();
  t.add({ kind: 'runCommand', command: 'sleep 1', timeoutMs: 120_000 });
  t.add({ kind: 'click', target: { kind: 'text', text: 'a' } });
  // 30s 基础 + 2 个动作×1s + 120s 命令预算
  expect(computeTimeout(t)).toBe(30_000 + 2_000 + 120_000);
});

// ---------- execShell(真实 spawn,node 命令跨平台) ----------

test('execShell: 返回真实退出码', async () => {
  const r = await execShell('node -e "process.exit(3)"', { timeoutMs: 30_000 });
  expect(r.timedOut).toBe(false);
  expect(r.code).toBe(3);
});

test('execShell: stdin_lines 逐行写入并 end(交互式 CLI 输入)', async () => {
  const r = await execShell('node -e "process.stdin.pipe(process.stdout)"', {
    stdinLines: ['hello', 'world'],
    timeoutMs: 30_000,
  });
  expect(r.code).toBe(0);
  expect(r.output).toContain('hello');
  expect(r.output).toContain('world');
});

test('execShell: 超时 → SIGKILL 并标记 timedOut', async () => {
  const r = await execShell('node -e "setTimeout(()=>{},10000)"', { timeoutMs: 500 });
  expect(r.timedOut).toBe(true);
});

test('execShell: 海量输出在采集阶段封顶(内存有界,保头保尾)', async () => {
  const r = await execShell(`node -e "const s='x'.repeat(65536); for (let i=0;i<50;i++) process.stdout.write(s); process.stdout.write('TAIL-MARK')"`, {
    timeoutMs: 30_000,
  });
  expect(r.code).toBe(0);
  expect(r.output.length).toBeLessThanOrEqual(1_100_000); // 上限 1MB + 单块余量
  expect(r.output).toContain('TAIL-MARK'); // 尾部保留
});
