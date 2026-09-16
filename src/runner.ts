/**
 * 用 @playwright/test 运行生成的用例并裁判(clean-replay)。
 *
 * 判定:`node <playwright CLI> test <file>` 的退出码,0=通过、非 0=失败。
 * 每个 run 目录自带一份极简 playwright.config.ts(testDir: '.'),
 * 以便脱离仓库根配置独立运行该目录下的生成用例,且拿到全新浏览器上下文。
 * 用例自身的超时由生成代码里的 test.setTimeout 控制(按轨迹计算,含长等待)。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const RUN_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  reporter: 'line',
  use: { trace: 'off' },
});
`;

function ensureRunConfig(dir: string): void {
  const cfg = join(dir, 'playwright.config.ts');
  if (!existsSync(cfg)) writeFileSync(cfg, RUN_CONFIG, 'utf-8');
}

export interface RunResult {
  passed: boolean;
  output: string;
}

export function runPlaywright(specFile: string, timeoutMs = 120_000, params: Record<string, string> = {}): Promise<RunResult> {
  const dir = dirname(specFile);
  const base = basename(specFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  ensureRunConfig(dir);

  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', base, '--workers=1', '--reporter=line', '-c', 'playwright.config.ts'],
      // Direct Node invocation avoids Windows shell interpolation of user-provided filenames.
      { cwd: dir, env: { ...process.env, PWGEN_PARAMS: JSON.stringify(params) }, detached: process.platform !== 'win32' },
    );
    let out = '';
    const timer = setTimeout(() => {
      out += `\n[playwright 超时,超过 ${timeoutMs}ms]`;
      timedOut = true;
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        killer.on('error', () => child.kill());
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: !timedOut && code === 0, output: trimOutput(out) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ passed: false, output: `启动 playwright 失败:${String(e)}` });
    });
  });
}

function trimOutput(text: string, head = 1500, tail = 1500): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + `\n\n[... 省略 ${text.length - head - tail} 字符 ...]\n\n` + text.slice(-tail);
}
