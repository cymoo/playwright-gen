/**
 * 纯逻辑单测（在 @playwright/test 下运行，无需浏览器）：
 * 定位描述符推导/渲染、codegen 的 web 与 electron 两种形态、sanitizer。
 */

import { test, expect } from '@playwright/test';

import { renderTest } from '../src/common/codegen';
import { candidateDescriptors, jsLit, renderLocator, type SnapshotItem } from '../src/common/locators';
import { sanitizeCode } from '../src/common/sanitizer';
import { Trajectory } from '../src/common/trajectory';

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

test('candidateDescriptors: 命名按钮首选 role+name', () => {
  const c = candidateDescriptors(item({ role: 'button', name: '保存', tag: 'button' }));
  expect(c[0]).toEqual({ kind: 'role', role: 'button', name: '保存' });
});

test('candidateDescriptors: 表单控件补充 getByLabel 候选（兜住 password）', () => {
  const c = candidateDescriptors(item({ role: 'textbox', name: '密码', tag: 'input' }));
  expect(c[0]).toEqual({ kind: 'role', role: 'textbox', name: '密码' });
  expect(c).toContainEqual({ kind: 'label', text: '密码' });
});

test('candidateDescriptors: placeholder/testid 兜底，role+nth 收尾', () => {
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

test('renderTest: web 形态', () => {
  const t = new Trajectory();
  t.add({ kind: 'goto', url: 'https://x.test/' });
  t.add({ kind: 'click', target: { kind: 'role', role: 'button', name: 'Go' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'ok' } });
  const code = renderTest(t, { testName: 'demo', description: 'd', target: { mode: 'web', url: 'https://x.test/' } });
  expect(code).toContain(`import { test, expect } from '@playwright/test';`);
  expect(code).toContain(`test('demo', async ({ page }) => {`);
  expect(code).toContain(`await page.goto('https://x.test/');`);
  expect(code).toContain(`await page.getByRole('button', { name: 'Go' }).click();`);
  expect(code).toContain(`await expect(page.getByText('ok')).toBeVisible();`);
});

test('renderTest: electron 形态（启动可执行文件 + firstWindow，无 page fixture / 无 goto）', () => {
  const t = new Trajectory();
  t.add({ kind: 'click', target: { kind: 'role', role: 'button', name: 'Save' } });
  t.add({ kind: 'assertVisible', target: { kind: 'text', text: 'Saved' } });
  const code = renderTest(t, {
    testName: 'app',
    description: 'd',
    target: { mode: 'electron', bin: '/A/My.app/Contents/MacOS/My', args: ['--foo'] },
  });
  expect(code).toContain(`_electron as electron`);
  expect(code).toContain(`electron.launch({ executablePath: '/A/My.app/Contents/MacOS/My', args: ['--foo'] })`);
  expect(code).toContain(`const page = await electronApp.firstWindow();`);
  expect(code).toContain(`await electronApp.close();`);
  expect(code).not.toContain(`async ({ page })`);
  expect(code).not.toContain(`page.goto`);
});

test('sanitizeCode: 去 fence 并校验', () => {
  const raw =
    "```ts\nimport { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => { await page.goto('u'); });\n```";
  const out = sanitizeCode(raw);
  expect(out.startsWith('import')).toBe(true);
  expect(out).not.toContain('```');
});

test('sanitizeCode: 接受 electron.launch 代替 goto', () => {
  const raw =
    "import { test, expect, _electron as electron } from '@playwright/test';\ntest('t', async () => { const a = await electron.launch({}); });";
  expect(() => sanitizeCode(raw)).not.toThrow();
});

test('sanitizeCode: 缺导入/缺 test/缺导航时报错', () => {
  expect(() => sanitizeCode(`test('t', async () => { await page.goto('u'); })`)).toThrow();
  expect(() => sanitizeCode(`import { test } from '@playwright/test';\nconst x = 1;`)).toThrow();
  expect(() => sanitizeCode(`import { test } from '@playwright/test';\ntest('t', async () => {});`)).toThrow();
});
