import { expect, type ElectronApplication, type FileChooser, type JSHandle, type Locator, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One file selection, shared by exploration and generated specs. Keep this function
 * self-contained: codegen serializes it, so imports below must also be injected there.
 * Use inline callbacks / object methods (no transpiler-injected named local functions).
 */
export async function clickAndOpen(
  page: Page, electronApp: ElectronApplication | undefined, locator: Locator,
  filePath: string, baseDir: string, timeoutMs: number,
): Promise<void> {
  const abs = resolve(baseDir, filePath);
  try {
    if (!statSync(abs).isFile()) throw new Error('路径不是普通文件');
  } catch (error) {
    throw new Error(`无法打开本地文件: ${abs} (${(error as Error).message})`);
  }
  const deadline = Date.now() + timeoutMs;
  let hook: JSHandle<{ used: boolean; restore(): void }> | undefined;
  let chooser: FileChooser | undefined;
  const handlers = { onChooser(value: FileChooser) { chooser ??= value; } };
  try {
    if (electronApp) {
      hook = await electronApp.evaluateHandle(({ dialog }, path) => {
        const originalAsync = dialog.showOpenDialog;
        const originalSync = dialog.showOpenDialogSync;
        const state = {
          used: false,
          async open() {
            state.used = true;
            state.restore();
            return { canceled: false, filePaths: [path] };
          },
          openSync() {
            state.used = true;
            state.restore();
            return [path];
          },
          restore() {
            if (dialog.showOpenDialog === state.open) dialog.showOpenDialog = originalAsync;
            if (dialog.showOpenDialogSync === state.openSync) dialog.showOpenDialogSync = originalSync;
          },
        };
        dialog.showOpenDialog = state.open;
        dialog.showOpenDialogSync = state.openSync;
        return state;
      }, abs);
    }
    // Listen before clicking; this also handles Electron renderer <input type=file>.
    page.on('filechooser', handlers.onChooser);
    await locator.click({ timeout: Math.max(1, deadline - Date.now()) });
    try {
      await expect.poll(async () => !!chooser || !!(hook && await hook.evaluate(state => state.used)), {
        timeout: Math.max(1, deadline - Date.now()),
        message: '等待文件选择器',
      }).toBe(true);
    } catch {
      throw new Error('打开文件超时: 未捕获文件选择器或 Electron dialog.showOpenDialog(Sync)。' +
        '请将 click_and_open 用在直接触发文件选择的按钮上；不要使用 click_and_save 或操作原生窗口。');
    }
    if (chooser) await chooser.setFiles(abs, { timeout: Math.max(1, deadline - Date.now()) });
  } finally {
    page.off('filechooser', handlers.onChooser);
    if (hook) {
      try { await hook.evaluate(state => state.restore()); }
      finally { await hook.dispose(); }
    }
  }
}

// Serialize the actual executor rather than maintaining a second implementation.
export const OPEN_HELPER_TS = clickAndOpen.toString();
