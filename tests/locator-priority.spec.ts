import { test, expect } from '@playwright/test';
import { Session } from '../src/browser';

for (const { name, placeholder } of [
  { name: 'Search', placeholder: 'Search' },
  { name: 'Search documents', placeholder: 'Search packages' },
  { name: 'Search documents', placeholder: 'Search' },
]) {
  test(`名称 ${name} 优先于另一控件的 placeholder ${placeholder}`, async ({ page }) => {
    await page.setContent(`<input aria-label="${name}"><input aria-label="Package filter" placeholder="${placeholder}">`);
    const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
    session.page = page;
    await session.snapshot();
    const descriptor = await session.fill('sEaRcH', 'wanted');
    await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue('wanted');
    await expect(page.getByRole('textbox', { name: 'Package filter', exact: true })).toHaveValue('');
    expect(descriptor).toEqual({ kind: 'role', role: 'textbox', name });
  });
}

test('名称匹配歧义时拒绝定位，不绕过到唯一的 placeholder', async ({ page }) => {
  await page.setContent('<input aria-label="Search documents"><input aria-label="Search history"><input aria-label="Package filter" placeholder="Search">');
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
  session.page = page;
  await session.snapshot();
  await expect(session.fill('Search', 'wrong')).rejects.toThrow('匹配到多个可交互元素');
  await expect(page.getByRole('textbox', { name: 'Package filter' })).toHaveValue('');
});

test('无名称匹配时 placeholder 仍支持精确优先和唯一部分匹配', async ({ page }) => {
  await page.setContent('<input aria-label="Application filter" placeholder="Click to search"><input aria-label="Device filter" placeholder="Click to search devices">');
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
  session.page = page;
  await session.snapshot();
  await session.fill('Click to search', 'app');
  await session.fill('search devices', 'device');
  await expect(page.getByRole('textbox', { name: 'Application filter' })).toHaveValue('app');
  await expect(page.getByRole('textbox', { name: 'Device filter' })).toHaveValue('device');
});

test('无名称匹配且 placeholder 重复时仍拒绝歧义', async ({ page }) => {
  await page.setContent('<input aria-label="Application filter" placeholder="Click to search"><input aria-label="Device filter" placeholder="Click to search">');
  const session = new Session({ mode: 'web', url: 'about:blank' }, { headless: true });
  session.page = page;
  await session.snapshot();
  await expect(session.fill('Click to search', 'wrong')).rejects.toThrow('匹配到多个可交互元素');
});
