/**
 * 统一 CLI：`pwgen v1|v2|v3`。
 *
 * 目标为"恰好其一"：web 用 --url，Electron 用 --electron-bin（+ --electron-args）。
 * v1 仅 web（静态页单次生成）；v2/v3 支持 web 与 Electron。
 *
 *   npx tsx src/cli.ts v1 --url <URL> --description "<描述>" [--vision]
 *   npx tsx src/cli.ts v2 --url <URL> --description "<描述>" [--vision --headed --max-steps N --trace]
 *   npx tsx src/cli.ts v2 --electron-bin <PATH> --description "<描述>"
 *   npx tsx src/cli.ts v3 --url <URL> --username U --password P --description "<描述>"
 */

import { Command } from 'commander';

import type { TargetSpec } from './common/trajectory';
import { runV1 } from './v1/index';
import { runV2 } from './v2/index';
import { runV3 } from './v3/index';

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
  return { mode: 'electron', bin: electronBin!, args };
}

const intArg = (v: string) => parseInt(v, 10);

const program = new Command();
program
  .name('pwgen')
  .description('从 URL 或 Electron 应用 + 自然语言，自动生成可运行的 Playwright(TypeScript) 测试');

program
  .command('v1')
  .description('单次生成（简单/静态 web 页；可选视觉）')
  .requiredOption('--url <url>', '目标页面 URL')
  .requiredOption('--description <text>', '用自然语言描述要验证的行为')
  .option('--out-dir <dir>', '输出目录', './output')
  .option('--name <name>', '本次运行名称（默认时间戳）')
  .option('--vision', '启用 qwen 视觉：对截图生成文本描述补充上下文', false)
  .option('--headed', '显示浏览器窗口（调试用）', false)
  .action(async (o) => {
    await runV1({
      url: o.url,
      description: o.description,
      outDir: o.outDir,
      name: o.name,
      vision: o.vision,
      headed: o.headed,
    });
  });

program
  .command('v2')
  .description('Agent 驱动浏览器/应用探索（动态/交互页；支持 Electron）')
  .option('--url <url>', '目标页面 URL（web）')
  .option('--electron-bin <path>', 'Electron 打包后可执行文件路径（.app 会自动解析内部二进制）')
  .option('--electron-args <args>', 'Electron 启动参数（空格分隔）')
  .requiredOption('--description <text>', '用自然语言描述要验证的行为')
  .option('--out-dir <dir>', '输出目录', './output')
  .option('--name <name>', '本次运行名称（默认时间戳）')
  .option('--vision', '启用 qwen 视觉 look 工具', false)
  .option('--headed', '显示浏览器窗口（调试用）', false)
  .option('--max-steps <n>', '探索最大步数', intArg)
  .option('--trace', '录制 Playwright trace（.zip）', false)
  .action(async (o) => {
    const target = resolveTarget(o.url, o.electronBin, o.electronArgs);
    await runV2({
      target,
      description: o.description,
      outDir: o.outDir,
      name: o.name,
      vision: o.vision,
      headed: o.headed,
      maxSteps: o.maxSteps,
      trace: o.trace,
    });
  });

program
  .command('v3')
  .description('规划 + 套件 + 登录/多视图（复杂应用；支持 Electron）')
  .option('--url <url>', '目标页面 URL（web）')
  .option('--electron-bin <path>', 'Electron 打包后可执行文件路径（.app 会自动解析内部二进制）')
  .option('--electron-args <args>', 'Electron 启动参数（空格分隔）')
  .requiredOption('--description <text>', '用自然语言描述要验证的行为（可含多个关注点）')
  .option('--username <user>', '登录用户名（需要鉴权时）')
  .option('--password <pass>', '登录密码')
  .option('--out-dir <dir>', '输出目录', './output')
  .option('--name <name>', '本次运行名称（默认时间戳）')
  .option('--vision', '启用 qwen 视觉 look 工具', false)
  .option('--headed', '显示浏览器窗口（调试用）', false)
  .option('--max-steps <n>', '每个场景的探索最大步数', intArg)
  .option('--trace', '录制 Playwright trace（.zip）', false)
  .action(async (o) => {
    const target = resolveTarget(o.url, o.electronBin, o.electronArgs);
    await runV3({
      target,
      description: o.description,
      username: o.username,
      password: o.password,
      outDir: o.outDir,
      name: o.name,
      vision: o.vision,
      headed: o.headed,
      maxSteps: o.maxSteps,
      trace: o.trace,
    });
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
