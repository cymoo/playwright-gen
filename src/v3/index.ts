/**
 * v3：规划 + 套件 + 登录/多视图。适用：复杂应用（含 Electron）。
 *
 * 相对 v2 只多一个 Planner：把一句话拆成多个自包含、各自聚焦的场景（登录等前置并入
 * 每个场景），逐个走 v2 探索引擎，汇总成测试套件。
 */

import { join } from 'node:path';

import { Session } from '../common/browser';
import { generateOne } from '../common/explore';
import { makeRunDir } from '../common/io';
import type { TargetSpec } from '../common/trajectory';
import { describeTarget, type V2Opts } from '../v2/index';
import { makePlan } from './planner';

function safeFile(name: string, idx: number): string {
  const slug =
    (name || '')
      .trim()
      .toLowerCase()
      .replace(/\W+/g, '_')
      .replace(/^_+|_+$/g, '') || `scenario${idx}`;
  return `test_${String(idx).padStart(2, '0')}_${slug.slice(0, 40)}.spec.ts`;
}

async function quickState(target: TargetSpec, headless: boolean): Promise<string> {
  const s = new Session(target, { headless });
  await s.start();
  try {
    if (target.mode === 'web') await s.goto(target.url);
    return await s.snapshot();
  } finally {
    await s.close();
  }
}

export interface V3Opts extends V2Opts {
  username?: string;
  password?: string;
}

export async function runV3(opts: V3Opts): Promise<void> {
  const runDir = makeRunDir(opts.outDir, opts.name);
  const headless = !opts.headed;
  const credsHint = opts.username
    ? `登录凭据：用户名 ${opts.username}、密码 ${opts.password}。页面若需登录，每个场景都要先登录。`
    : '';

  console.log('[v3] 规划场景…');
  const initialState = await quickState(opts.target, headless);
  const plan = await makePlan(opts.description, describeTarget(opts.target), initialState, credsHint);
  console.log(`[规划] 拆出 ${plan.scenarios.length} 个场景：`);
  plan.scenarios.forEach((sc, i) => console.log(`  ${i + 1}. ${sc.name} — ${sc.description.slice(0, 60)}`));

  const results: { name: string; testPath: string; passed: boolean }[] = [];
  for (let i = 0; i < plan.scenarios.length; i++) {
    const sc = plan.scenarios[i];
    let desc = sc.description;
    if (opts.username && !desc.includes('登录')) {
      desc = `先用用户名 ${opts.username}、密码 ${opts.password} 登录。然后：${desc}`;
    }
    const testPath = join(runDir, safeFile(sc.name, i + 1));
    console.log(`\n=== 场景 ${i + 1}/${plan.scenarios.length}: ${sc.name} ===`);
    const result = await generateOne({
      target: opts.target,
      description: desc,
      testPath,
      testName: sc.name,
      vision: opts.vision,
      headless,
      maxSteps: opts.maxSteps,
      trace: opts.trace,
    });
    results.push({ name: sc.name, testPath, passed: result.passed });
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n===== 套件汇总：${passed}/${results.length} 通过 =====`);
  results.forEach((r) => console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}  →  ${r.testPath}`));
}
