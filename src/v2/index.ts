/**
 * v2：Agent 驱动浏览器/应用探索 + 轨迹→代码。适用：动态/交互页面（SPA/弹窗/多步），
 * 以及 Electron 应用（通过 --electron-bin）。
 */

import { join } from 'node:path';

import { generateOne } from '../common/explore';
import { makeRunDir } from '../common/io';
import type { TargetSpec } from '../common/trajectory';

export function describeTarget(t: TargetSpec): string {
  return t.mode === 'web' ? t.url : `Electron:${t.bin}`;
}

export interface V2Opts {
  target: TargetSpec;
  description: string;
  outDir: string;
  name?: string;
  vision?: boolean;
  headed?: boolean;
  maxSteps?: number;
  trace?: boolean;
}

export async function runV2(opts: V2Opts): Promise<void> {
  const runDir = makeRunDir(opts.outDir, opts.name);
  const testPath = join(runDir, 'test_generated.spec.ts');

  console.log(`[v2] 探索 ${describeTarget(opts.target)}`);
  const result = await generateOne({
    target: opts.target,
    description: opts.description,
    testPath,
    testName: 'generated',
    vision: opts.vision,
    headless: !opts.headed,
    maxSteps: opts.maxSteps,
    trace: opts.trace,
  });

  if (result.passed) {
    console.log(`\n全部通过（${result.steps} 步，${result.attempts} 次尝试）→ ${testPath}`);
    if (result.notes) console.log(`\n说明：${result.notes}`);
  } else {
    console.log(`\n未通过（共 ${result.attempts} 次尝试）。最后一版：${testPath}`);
    console.log(result.output.slice(-1200));
  }
}
