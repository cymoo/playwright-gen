/**
 * v1：单次生成（富 ARIA 快照 + 可选 qwen 视觉）。适用：简单/静态 web 页。
 *
 * 复用公共 Session 做**只读**快照（本次重构第 2 项优化：v1/v2/v3 共用一套快照逻辑），
 * 单次 generateObject 生成代码，sanitize → 运行 → 失败带日志重试。仅 web（静态页）；
 * 需要交互的（含 Electron 应用）请用 v2/v3。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Session } from '../common/browser';
import { makeRunDir } from '../common/io';
import { maxRetries } from '../common/models';
import { runPlaywright } from '../common/runner';
import { sanitizeCode } from '../common/sanitizer';
import { describeScreenshot } from '../common/vision';
import { generateTest } from './agent';

export interface V1Opts {
  url: string;
  description: string;
  outDir: string;
  name?: string;
  vision?: boolean;
  headed?: boolean;
}

function buildPrompt(
  url: string,
  title: string,
  state: string,
  description: string,
  visionDesc: string | undefined,
  prevCode: string | undefined,
  failure: string | undefined,
): string {
  const parts = [`URL：${url}`, `标题：${title}`, `\n页面状态（ARIA 无障碍树 + 可交互元素）：\n${state}`];
  if (visionDesc) parts.push(`\n截图的视觉描述（来自视觉模型）：\n${visionDesc}`);
  parts.push(`\n需求描述：${description}`);
  if (prevCode) parts.push(`\n上次生成的代码：\n${prevCode}`);
  if (failure) parts.push(`\nplaywright 运行失败日志：\n${failure}`);
  return parts.join('\n');
}

export async function runV1(opts: V1Opts): Promise<void> {
  const runDir = makeRunDir(opts.outDir, opts.name);
  const testPath = join(runDir, 'test_generated.spec.ts');

  console.log(`[快照] ${opts.url}`);
  const session = new Session({ mode: 'web', url: opts.url }, { headless: !opts.headed });
  let state: string;
  let title: string;
  let shotPath: string | undefined;
  await session.start();
  try {
    await session.goto(opts.url);
    state = await session.snapshot();
    title = await session.page.title();
    if (opts.vision) {
      shotPath = join(runDir, 'screenshot.png');
      await session.screenshot(shotPath);
    }
  } finally {
    await session.close();
  }
  console.log(`  title: ${title}`);

  let visionDesc: string | undefined;
  if (opts.vision && shotPath) {
    console.log('[视觉] qwen 分析截图…');
    visionDesc = await describeScreenshot(shotPath, `请描述与以下测试需求相关的可见元素：${opts.description}`);
    console.log('  ' + visionDesc.slice(0, 200) + (visionDesc.length > 200 ? '…' : ''));
  }

  const retries = maxRetries();
  let prevCode: string | undefined;
  let failure: string | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`\n[生成] 第 ${attempt}/${retries} 轮`);
    const userPrompt = buildPrompt(opts.url, title, state, opts.description, visionDesc, prevCode, failure);
    const gen = await generateTest(userPrompt);

    let code: string;
    try {
      code = sanitizeCode(gen.code);
    } catch (e) {
      console.log(`[校验失败] ${String(e)}，重试`);
      prevCode = gen.code;
      failure = String(e);
      continue;
    }

    writeFileSync(testPath, code, 'utf-8');
    console.log('[运行] playwright test');
    const { passed, output } = await runPlaywright(testPath);
    if (passed) {
      console.log(`\n全部通过 → ${testPath}`);
      if (gen.notes) console.log(`\n${gen.notes}`);
      return;
    }
    console.log(`失败，准备第 ${attempt + 1} 轮修复`);
    prevCode = code;
    failure = output;
  }

  console.log(`\n已达最大重试次数。最后一版：${testPath}`);
}
