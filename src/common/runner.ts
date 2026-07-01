/**
 * 用 @playwright/test 运行生成的用例并裁判（所有版本共用）。
 *
 * 判定：`npx playwright test <file>` 的退出码，0=通过、非 0=失败。
 * 每个 run 目录自带一份极简 playwright.config.ts（testDir: '.'），
 * 以便脱离仓库根配置独立运行该目录下的生成用例，且拿到全新浏览器上下文（clean-replay）。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const RUN_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  reporter: 'line',
  timeout: 30_000,
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

export function runPlaywright(specFile: string, timeoutMs = 60_000): Promise<RunResult> {
  const dir = dirname(specFile);
  const base = basename(specFile);
  ensureRunConfig(dir);

  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', base, '--reporter=line', '-c', 'playwright.config.ts'],
      // Windows 上 npx 实为 npx.cmd，新版 Node 不允许无 shell 直接 spawn .cmd → Windows 走 shell；
      // POSIX 保持无 shell（超时时能干净地 kill 进程）。参数均为固定项 + slug 化文件名，shell 安全。
      { cwd: dir, env: process.env, shell: process.platform === 'win32' },
    );
    let out = '';
    const timer = setTimeout(() => {
      out += `\n[playwright 超时，超过 ${timeoutMs}ms]`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: trimOutput(out) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ passed: false, output: `启动 playwright 失败：${String(e)}` });
    });
  });
}

function trimOutput(text: string, head = 1500, tail = 1500): string {
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + `\n\n[... 省略 ${text.length - head - tail} 字符 ...]\n\n` + text.slice(-tail);
}
