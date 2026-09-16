import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paramText, paramCommand, resolveRule, type Rule } from '../src/runtime';
import { loadConfig, referenceError, validateDescription, writeRuntime } from '../src/config';
import { replay, scanFiles } from '../src/replay';
import { renderTest } from '../src/codegen';
import { Trajectory } from '../src/trajectory';
import { Session } from '../src/browser';

const rule: Rule = { scope: '#resources', role: 'button', text: 'Buffer', match: 'numberSuffix', pick: 'unique' };

test('参数保留原值、缺失报错、命令拒绝 shell 片段', () => {
  expect(paramText('${path}/${name}', { path: 'C:\\a b', name: '${literal}' })).toBe('C:\\a b/${literal}');
  expect(() => paramText('${missing}', {})).toThrow('缺少参数');
  expect(paramCommand('hdc -t ${sn}', { sn: 'SN-123' })).toBe('hdc -t SN-123');
  expect(() => paramCommand('hdc -t ${sn}', { sn: 'x & echo bad' })).toThrow('命令参数');
});

test('显式引用不能被样例或 ref 替代', () => {
  const config = { params: { sn: '123' }, rules: { buffer: rule } };
  expect(() => validateDescription('${missing}', config)).toThrow();
  expect(() => validateDescription('@unknown', config)).toThrow();
  expect(() => validateDescription('遍历前 5 个 Buffer', config)).toThrow('拆成');
  expect(() => validateDescription('输入 neo@example.com', config)).not.toThrow();
  expect(referenceError('点击 @buffer', [{ kind: 'click', target: { kind: 'text', text: 'Buffer 13' } }], config)).toContain('@buffer');
  expect(referenceError('选择 ${sn}', [{ kind: 'selectOption', target: { kind: 'text', text: '设备' }, value: '123' }], config)).toContain('${sn}');
  expect(referenceError('点击 @buffer', [{ kind: 'click', target: { kind: 'rule', rule } }], config)).toBeUndefined();
});

test('配置拒绝未知字段和无效序号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwgen-config-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ rules: { bad: { ...rule, pick: -1 } } }));
    expect(() => loadConfig(file)).toThrow();
    writeFileSync(file, JSON.stringify({ param: {} }));
    expect(() => loadConfig(file)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('目录变更重新扫描，大小写扩展名、递归、逐项失败汇总', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwgen-batch-'));
  try {
    const spec = join(dir, 'test.spec.ts'); writeFileSync(spec, '// pwgen-parameters: ["inputName"]');
    writeFileSync(join(dir, 'a.pb'), 'a'); writeFileSync(join(dir, 'b.PB'), 'b');
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', 'c.pb'), 'c');
    expect(scanFiles(dir, 'pb')).toHaveLength(2);
    expect(scanFiles(dir, 'pb', true)).toHaveLength(3);
    const seen: string[] = [];
    const report = join(dir, 'report.json');
    const results = await replay({ spec, params: { deviceSn: 'new' }, inputDir: dir, ext: 'pb', timeoutMs: 1000, report }, async (_, __, params) => {
      seen.push(params!.inputName);
      expect(params!.deviceSn).toBe('new');
      return { passed: params!.inputName !== 'a.pb', output: 'result' };
    });
    expect(results.map(r => r.passed)).toEqual([false, true]);
    expect(seen).toEqual(['a.pb', 'b.PB']);
    expect(JSON.parse(readFileSync(report, 'utf8')).results).toHaveLength(2);
    rmSync(join(dir, 'a.pb')); writeFileSync(join(dir, 'd.pb'), 'new');
    expect(scanFiles(dir, 'pb').map(p => basename(p))).toEqual(['b.PB', 'd.pb']);
    expect(() => scanFiles(dir, 'rdc')).toThrow('没有');
    writeFileSync(spec, '// no input references');
    await expect(replay({ spec, params: {}, inputDir: dir, ext: 'pb', timeoutMs: 1000, report })).rejects.toThrow('批量用例必须');
    await expect(replay({ spec, params: {}, timeoutMs: NaN, report })).rejects.toThrow('timeout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('动态规则只匹配指定范围和数字后缀，编号变化仍可执行', async ({ page }) => {
  await page.setContent('<button>Buffer 13</button><section id="resources"><button>Buffer 99</button></section>');
  await (await resolveRule(page, rule, {})).click();
  await page.locator('#resources').evaluate(el => el.innerHTML = '<button>Buffer 200</button><button>Buffer 201</button>');
  const second = await resolveRule(page, { ...rule, pick: 1, minCount: 2 }, {});
  await expect(second).toHaveText('Buffer 201');
  // Use a short assertion timeout for deliberate ambiguity / insufficient-count paths.
  test.setTimeout(20000);
  await expect(resolveRule(page, rule, {})).rejects.toThrow();
  await expect(resolveRule(page, { ...rule, pick: 4, minCount: 5 }, {})).rejects.toThrow();
});

test('Session 参数和规则记录保持符号引用', async ({ page }) => {
  await page.setContent('<section id="resources"><button>Buffer 27</button></section><input aria-label="SN"><p>new.package</p>');
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true, params: { packageName: 'new.package', sn: 'new-sn' }, rules: { buffer: rule } });
  session.page = page;
  expect(await session.click('@buffer')).toEqual({ kind: 'rule', rule });
  expect(await session.assertVisible('${packageName}')).toEqual({ kind: 'text', text: '${packageName}', exact: true });
  await session.snapshot();
  await session.fill('SN', '${sn}');
  await expect(page.getByLabel('SN')).toHaveValue('new-sn');
});

test('生成产物保留运行时解析，不嵌入样例值', () => {
  const traj = new Trajectory();
  traj.add({ kind: 'click', target: { kind: 'rule', rule } });
  traj.add({ kind: 'selectOption', target: { kind: 'role', role: 'combobox', name: '设备' }, value: '${deviceSn}' });
  traj.add({ kind: 'runCommand', command: 'hdc -t ${deviceSn}', stdin: ['echo ${packageName}'], timeoutMs: 1000 });
  const code = renderTest(traj, { testName: 'reuse', description: '', target: { mode: 'web', url: 'about:blank' } });
  expect(code).toContain('resolveRule(page');
  expect(code).toContain('paramText("${deviceSn}", params)');
  expect(code).toContain('paramCommand("hdc -t ${deviceSn}", params)');
  expect(code).toContain('readParams()');
  const dir = mkdtempSync(join(tmpdir(), 'pwgen-runtime-'));
  try { writeRuntime(dir); expect(readFileSync(join(dir, 'pwgen-runtime.ts'), 'utf8')).toContain('resolveRule'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一生成用例在参数和资源编号变化后通过真实回放', async () => {
  test.setTimeout(60000);
  const { runPlaywright } = await import('../src/runner');
  const root = join(process.cwd(), 'output'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'reuse-test-'));
  try {
    const html = join(dir, 'fixture.html');
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url: pathToFileURL(html).href });
    traj.add({ kind: 'fill', target: { kind: 'label', text: 'SN' }, value: '${deviceSn}' });
    traj.add({ kind: 'click', target: { kind: 'rule', rule } });
    traj.add({ kind: 'assertText', target: { kind: 'testId', testId: 'result' }, text: '${deviceSn}' });
    const spec = join(dir, 'test_generated.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'reuse', description: '', target: { mode: 'web', url: '' } }));
    writeRuntime(dir);
    for (const [id, deviceSn] of [['13', 'SN-A'], ['999', 'SN-B']]) {
      writeFileSync(html, `<input aria-label="SN"><section id="resources"><button onclick="document.querySelector('p').textContent=document.querySelector('input').value">Buffer ${id}</button></section><p data-testid="result"></p>`);
      const result = await runPlaywright(spec, 25000, { deviceSn });
      expect(result.output, '生成脚本真实回放失败').not.toContain('ReferenceError');
      expect(result.passed, result.output).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('每个工具参数在执行前校验：断言引用不能掩盖固定输入', async () => {
  const { makeTools } = await import('../src/engine');
  const { literalReferenceError } = await import('../src/runtime');
  expect(literalReferenceError({ text: 'sample-SN', assertion: '${sn}' }, { sn: 'sample-SN' })).toContain('${sn}');
  const filled: string[] = [];
  const session = {
    fill: async (_target: string, value: string) => { filled.push(value); return { kind: 'label', text: 'SN' }; },
    assertVisible: async () => ({ kind: 'text', text: '${sn}' }),
    snapshot: async () => 'state',
  } as unknown as Session;
  const traj = new Trajectory();
  const flag = { done: false, summary: '', rejects: 0 };
  const tools = makeTools({ session, traj, runDir: '.', vision: false, mark: 0, needsAssert: true,
    flag, config: { params: { sn: 'sample-SN' }, rules: {} }, description: '填写 ${sn} 并验证 ${sn}' });
  const options = { toolCallId: 'test', messages: [], context: undefined };
  const bad = await tools.fill.execute!({ target: 'e1', text: 'sample-SN' }, options);
  expect(bad).toContain('操作失败');
  expect(filled).toEqual([]);
  await tools.assert_visible.execute!({ target: '${sn}' }, options);
  await tools.step_done.execute!({ summary: 'done' }, options);
  expect(flag.done).toBe(false);
  await tools.fill.execute!({ target: 'e1', text: '${sn}' }, options);
  await tools.step_done.execute!({ summary: 'done' }, options);
  expect(filled).toEqual(['${sn}']);
  expect(flag.done).toBe(true);
});

test('规则解析和可见性共用一个截止时间', async ({ page }) => {
  const { waitRule } = await import('../src/runtime');
  await page.setContent('<script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", \'<section id="resources"><button style="display:none">Buffer 1</button></section>\'); }, 350)</script>');
  const started = Date.now();
  await expect(waitRule(page, rule, {}, 800)).rejects.toThrow();
  // Old implementation started a new 800 ms window after discovering the scope.
  expect(Date.now() - started).toBeLessThan(1150);
});

test('生成的文件写入与下载保留参数，并拒绝越界保存', async () => {
  test.setTimeout(60000);
  const { runPlaywright } = await import('../src/runner');
  const root = join(process.cwd(), 'output'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'reuse-files-'));
  try {
    const html = join(dir, 'fixture.html');
    writeFileSync(html, '<a download="file.txt" href="data:text/plain,downloaded">Save</a>');
    const traj = new Trajectory();
    traj.add({ kind: 'goto', url: pathToFileURL(html).href });
    traj.add({ kind: 'writeFile', path: 'notes/${inputName}.txt', content: '${content}' });
    traj.add({ kind: 'clickSave', target: { kind: 'role', role: 'link', name: 'Save' }, path: '${savePath}', timeoutMs: 1000 });
    const spec = join(dir, 'files.spec.ts');
    writeFileSync(spec, renderTest(traj, { testName: 'files', description: '', target: { mode: 'web', url: '' } }));
    writeRuntime(dir);
    for (const inputName of ['one', 'two']) {
      const result = await runPlaywright(spec, 20000, { inputName, content: `content ${inputName}`, savePath: `${inputName}.txt` });
      expect(result.passed, result.output).toBe(true);
      expect(readFileSync(join(dir, 'notes', `${inputName}.txt`), 'utf8')).toBe(`content ${inputName}`);
      expect(readFileSync(join(dir, `${inputName}.txt`), 'utf8')).toBe('downloaded');
    }
    const outside = join(root, `${basename(dir)}-outside.txt`);
    writeFileSync(outside, 'must remain');
    try {
      const rejected = await runPlaywright(spec, 20000, { inputName: 'three', content: 'x', savePath: `../${basename(outside)}` });
      expect(rejected.passed).toBe(false);
      expect(rejected.output).toContain('保存路径必须位于运行目录内');
      expect(readFileSync(outside, 'utf8')).toBe('must remain');
    } finally { rmSync(outside, { force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
