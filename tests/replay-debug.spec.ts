import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPlaywright } from '../src/runner';
import { replay } from '../src/replay';
import { renderTest } from '../src/codegen';
import { writeRuntime } from '../src/config';
import { Trajectory } from '../src/trajectory';
import { buildPlan, repairContext } from '../src/engine';

function temporaryDir(prefix: string) {
  mkdirSync('output', { recursive: true });
  return mkdtempSync(join(process.cwd(), 'output', prefix));
}

test('失败回放保存独立现场、原始错误与完整日志，连续运行不覆盖', async () => {
  test.setTimeout(60000);
  const dir = temporaryDir('replay-artifacts-');
  try {
    const html = join(dir, 'fixture.html');
    writeFileSync(join(dir, 'playwright.config.ts'), "export default { testDir: '.', use: { trace: 'off' } };\n");
    writeFileSync(html, '<label>Poll interval<input type="number" value="1000"></label>');
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url: pathToFileURL(html).href });
    traj.add({ kind: 'stepStart', title: '提交 Poll interval' });
    traj.add({ kind: 'assertValue', target: { kind: 'label', text: 'Poll interval' }, value: '${poll}', timeoutMs: 100 });
    const spec = join(dir, 'case.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'failing', description: '', target: { mode: 'web', url: '' } }));
    writeRuntime(dir);
    const report = join(dir, 'results.json');
    const [first] = await replay({ spec, params: { poll: '100' }, timeoutMs: 20000, report });
    expect(first.passed).toBe(false);
    expect(first.failureSummary).toContain('1000');
    expect(first.failureSummary).toContain('100');
    expect(readFileSync(first.logPath!, 'utf8')).toContain('提交 Poll interval');
    const raw = JSON.parse(readFileSync(first.reportPath!, 'utf8'));
    const result = raw.suites[0].specs[0].tests[0].results[0];
    const names = result.attachments.map((a: any) => a.name);
    expect(names).toContain('failure-screenshot');
    expect(names).toContain('failure-state');
    expect(names).toContain('trace');
    expect(existsSync(result.attachments.find((a: any) => a.name === 'failure-screenshot').path)).toBe(true);
    expect(JSON.parse(readFileSync(report, 'utf8')).results[0].logPath).toBe(first.logPath);
    const second = await runPlaywright(spec, 20000, { poll: '1000' });
    expect(second.passed, second.output).toBe(true);
    expect(second.artifactsDir).not.toBe(first.artifactsDir);
    expect(existsSync(first.logPath!)).toBe(true);
    expect(readFileSync(first.reportPath!, 'utf8')).toContain('failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('debug 保留参数并解除外层超时，不需要模型或浏览器即可验证', async () => {
  test.setTimeout(30000);
  const dir = temporaryDir('debug-params-');
  try {
    const spec = join(dir, 'debug.spec.ts');
    writeFileSync(join(dir, 'playwright.config.ts'), "export default { testDir: '.', globalTimeout: 1 };\n");
    writeFileSync(spec, `// pwgen-debug: 1
import { test, expect } from '@playwright/test';
test('debug params', async () => {
  test.setTimeout(process.env.PWGEN_DEBUG === '1' ? 0 : 10);
  expect(JSON.parse(process.env.PWGEN_PARAMS!).device).toBe('SN-NEW');
  expect(process.env.PWGEN_DEBUG).toBe('1');
  await new Promise(resolve => setTimeout(resolve, 100));
});`);
    const result = await runPlaywright(spec, 1, { device: 'SN-NEW' }, undefined, { debug: true, trace: 'off' });
    expect(result.passed, result.output).toBe(true);
    expect(result.timedOut).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('失败暂停发生在 Electron 关闭之前，恢复后仍报告原始失败', async () => {
  test.setTimeout(30000);
  const dir = temporaryDir('pause-order-');
  try {
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url: 'data:text/html,<p>actual</p>' });
    traj.add({ kind: 'assertValue', target: { kind: 'css', selector: 'input' }, value: 'missing', timeoutMs: 100 });
    let code = renderTest(traj, { testName: 'pause failure', description: '', target: { mode: 'electron', bin: '/unused', args: [] } });
    // Exercise the generated Electron lifecycle with a real Chromium page and a
    // test launcher, without requiring the user's Windows executable or Inspector.
    code = code.replace("import { test, expect, _electron as electron } from '@playwright/test';", `import { test, expect, chromium } from '@playwright/test';
const electron = { launch: async (_options: unknown) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let paused = false;
  page.pause = async () => { if (page.isClosed()) throw Error('closed too early'); paused = true; console.log('PAUSE_BEFORE_CLOSE'); };
  return { firstWindow: async () => page, close: async () => { console.log(paused ? 'CLOSE_AFTER_PAUSE' : 'CLOSE_TOO_EARLY'); await browser.close(); throw Error('CLEANUP_ERROR'); } };
} };`);
    const spec = join(dir, 'pause.spec.ts');
    writeFileSync(spec, code);
    const result = await runPlaywright(spec, 20000, {}, undefined, { pauseOnFailure: true });
    expect(result.passed).toBe(false);
    const log = readFileSync(result.logPath!, 'utf8');
    expect(log).toContain('PAUSE_BEFORE_CLOSE');
    expect(log).toContain('CLOSE_AFTER_PAUSE');
    expect(log.indexOf('PAUSE_BEFORE_CLOSE')).toBeLessThan(log.indexOf('CLOSE_AFTER_PAUSE'));
    expect(result.failureSummary).not.toContain('CLEANUP_ERROR');
    expect(result.failureSummary).toContain('toHaveValue');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧脚本失败暂停与批量交互调试明确拒绝，不假装支持', async () => {
  const dir = temporaryDir('legacy-debug-');
  try {
    const spec = join(dir, 'old.spec.ts');
    writeFileSync(spec, '// old');
    writeFileSync(join(dir, 'one.pb'), '');
    expect(() => runPlaywright(spec, 1000, {}, undefined, { pauseOnFailure: true })).toThrow('重新生成');
    await expect(replay({ spec, params: {}, inputDir: dir, ext: 'pb', debug: true, timeoutMs: 1000, report: join(dir, 'results.json') })).rejects.toThrow('调试仅支持单次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('准备步骤与主流程共用计划并保持顺序和显式引用', () => {
  const plan = buildPlan('步骤1：开始录制。步骤2：验证结果', '步骤1：连接 ${sn}。步骤2：通过 @app 选择 ${pkg}');
  expect(plan.steps.map(s => s.title)).toEqual(['准备步骤1', '准备步骤2', '步骤1', '步骤2']);
  expect(plan.steps[0].text).toContain('${sn}');
  expect(plan.steps[1].text).toContain('@app');
});

test('自动修复获得失败处源码，而非长辅助函数头部', () => {
  const code = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join('\n');
  const context = repairContext(code, 'at D:\\output\\test_generated.spec.ts:150:22');
  expect(context).toContain('150: line150');
  expect(context).toContain('149: line149');
  expect(context).not.toContain('1: line1\n');
  expect(context.split('\n')).toHaveLength(17);
});
