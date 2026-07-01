/**
 * 轨迹 → @playwright/test (TypeScript) 代码（v2/v3 共用）。
 *
 * 代码不是 LLM 凭记忆盲写，而是据探索中**真正成功执行**的操作轨迹确定性渲染而来；
 * 每一步用的是当时真正命中的定位描述符（见 trajectory.ts）。产出即"已验证可回放"。
 * 同一条轨迹按 TargetSpec 渲染为 **web**（page fixture + goto）或 **electron**
 * （_electron.launch 可执行文件 + firstWindow）两种形态。
 *
 * 稳健性内建：web-first 断言 + Playwright 自动等待，绝不输出硬 sleep。
 */

import type { Step, TargetSpec, Trajectory } from './trajectory';
import { jsLit, renderLocator } from './locators';

function renderStep(s: Step): string {
  switch (s.kind) {
    case 'goto':
      return `await page.goto(${jsLit(s.url)});`;
    case 'click':
      return `await ${renderLocator(s.target)}.click();`;
    case 'fill':
      return `await ${renderLocator(s.target)}.fill(${jsLit(s.value)});`;
    case 'check':
      return `await ${renderLocator(s.target)}.check();`;
    case 'uncheck':
      return `await ${renderLocator(s.target)}.uncheck();`;
    case 'selectOption':
      return `await ${renderLocator(s.target)}.selectOption(${jsLit(s.value)});`;
    case 'hover':
      return `await ${renderLocator(s.target)}.hover();`;
    case 'press':
      return s.target
        ? `await ${renderLocator(s.target)}.press(${jsLit(s.key)});`
        : `await page.keyboard.press(${jsLit(s.key)});`;
    case 'assertVisible':
      return `await expect(${renderLocator(s.target)}).toBeVisible();`;
    case 'assertText':
      return `await expect(${renderLocator(s.target)}).toContainText(${jsLit(s.text)});`;
    case 'assertUrl':
      return `await expect(page).toHaveURL(new RegExp(${jsLit(s.pattern)}));`;
    case 'assertTitle':
      return `await expect(page).toHaveTitle(new RegExp(${jsLit(s.pattern)}));`;
    default: {
      const _never: never = s;
      throw new Error(`unknown step: ${JSON.stringify(_never)}`);
    }
  }
}

export interface RenderOpts {
  testName: string;
  description: string;
  target: TargetSpec;
}

export function renderTest(traj: Trajectory, opts: RenderOpts): string {
  const { testName, description, target } = opts;
  const title = jsLit(testName || 'generated');
  const doc = (description || '').replace(/\r?\n/g, ' ').trim();

  if (target.mode === 'electron') {
    const argsLit = `[${target.args.map(jsLit).join(', ')}]`;
    const body = traj.steps.map((s) => '  ' + renderStep(s)).join('\n') || '  // (无步骤)';
    return (
      `import { test, expect, _electron as electron } from '@playwright/test';\n\n` +
      `// ${doc}\n` +
      `test(${title}, async () => {\n` +
      `  const electronApp = await electron.launch({ executablePath: ${jsLit(target.bin)}, args: ${argsLit} });\n` +
      `  const page = await electronApp.firstWindow();\n` +
      `${body}\n` +
      `  await electronApp.close();\n` +
      `});\n`
    );
  }

  const body = traj.steps.map((s) => '  ' + renderStep(s)).join('\n') || '  // (无步骤)';
  return (
    `import { test, expect } from '@playwright/test';\n\n` +
    `// ${doc}\n` +
    `test(${title}, async ({ page }) => {\n` +
    `${body}\n` +
    `});\n`
  );
}
