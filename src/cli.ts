/**
 * pwgen:URL / Electron 应用 + 自然语言描述 → 可运行的 @playwright/test 用例(单文件)。
 *
 *   npx tsx src/cli.ts --url <URL> --description "<描述>" [选项]
 *   npx tsx src/cli.ts --electron-bin <PATH> [--electron-args "…"] --description "<描述>" [选项]
 *
 * 描述里可用"步骤1:… 步骤2:…"标注多个步骤:引擎逐步执行(每步独立对话与预算,
 * 不会静默跳步),全部步骤生成进同一个用例文件(test.step 分块)。
 */

import { Command } from 'commander';

import { resolveElectronBinary } from './browser';
import { run } from './engine';
import type { TargetSpec } from './trajectory';

function resolveTarget(
  url: string | undefined,
  electronBin: string | undefined,
  electronArgs: string | undefined,
): TargetSpec {
  const hasUrl = !!url;
  const hasBin = !!electronBin;
  if (hasUrl === hasBin) {
    throw new Error('请且仅提供 --url 或 --electron-bin 其中之一。');
  }
  if (hasUrl) return { mode: 'web', url: url! };
  const args = (electronArgs ?? '').trim() ? electronArgs!.trim().split(/\s+/) : [];
  // 这里就解析出真实可执行文件(macOS .app → 内部二进制),生成的用例里即是可回放路径
  return { mode: 'electron', bin: resolveElectronBinary(electronBin!), args };
}

const intArg = (v: string) => parseInt(v, 10);

const program = new Command();
program
  .name('pwgen')
  .description('从 URL 或 Electron 应用 + 自然语言描述,自动生成可运行的 Playwright(TypeScript)测试')
  .option('--url <url>', '目标页面 URL(web)')
  .option('--electron-bin <path>', 'Electron 可执行文件路径(macOS 可传 .app,自动解析内部二进制)')
  .option('--electron-args <args>', 'Electron 启动参数(空格分隔)')
  .requiredOption('--description <text>', '自然语言场景描述;多步骤用"步骤1:… 步骤2:…"标注')
  .option('--out-dir <dir>', '输出目录', './output')
  .option('--name <name>', '本次运行名称(默认时间戳)')
  .option('--vision', '启用 qwen 视觉 look 工具', false)
  .option('--headed', '显示浏览器窗口(调试用)', false)
  .option('--max-steps <n>', '每个步骤的最大探索轮数(默认 30,env MAX_STEPS)', intArg)
  .option('--max-repairs <n>', '探索/回放失败后的额外重试轮数(默认 1)', intArg)
  .option('--trace', '录制探索过程的 Playwright trace(.zip)', false)
  .action(async (o) => {
    const target = resolveTarget(o.url, o.electronBin, o.electronArgs);
    await run({
      target,
      description: o.description,
      outDir: o.outDir,
      name: o.name,
      vision: o.vision,
      headed: o.headed,
      maxSteps: o.maxSteps,
      maxRepairs: o.maxRepairs,
      trace: o.trace,
    });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
