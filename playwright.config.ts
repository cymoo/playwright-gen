import { defineConfig } from '@playwright/test';

/**
 * 本仓库自身的测试（tests/：splitSteps / codegen / locator 表达式等单测）。
 * 生成出来的用例在 output/<run>/ 下，由 src/runner 单独调用 playwright 运行，
 * 不走这里的 testDir。
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  timeout: 30_000,
});
