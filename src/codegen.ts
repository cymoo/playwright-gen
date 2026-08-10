/**
 * 轨迹 → @playwright/test (TypeScript) 代码。
 *
 * 代码不是 LLM 凭记忆盲写,而是据探索中**真正成功执行**的操作轨迹确定性渲染而来;
 * 每一步用的是当时真正命中的定位描述符(见 trajectory.ts)。产出即"已验证可回放"。
 * 同一条轨迹按 TargetSpec 渲染为 **web**(page fixture + goto)或 **electron**
 * (_electron.launch 可执行文件 + firstWindow,try/finally 确保关闭)两种形态。
 *
 * 多步骤描述生成**一个用例文件**:stepStart 标记把动作分进 test.step() 块。
 * 稳健性内建:web-first 断言 + 自动等待,绝不输出硬 sleep;长等待用带 timeout 的
 * toBeVisible;test.setTimeout 按轨迹(动作数 + 各断言超时 + 命令超时)自动计算。
 * runCommand / writeFile 步骤所需的 node: import 与辅助函数按需注入(见 shell.ts),
 * 纯 UI 轨迹的产物与不含此能力时完全一致。
 */

import type { Step, TargetSpec, Trajectory } from './trajectory';
import { jsLit, renderLocator } from './locators';
import { SHELL_HELPER_TS, WRITE_HELPER_TS } from './shell';

type ActionStep = Exclude<Step, { kind: 'stepStart' }>;

const DEFAULT_ASSERT_MS = 5_000;

function renderStep(s: ActionStep): string {
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
    case 'assertVisible': {
      const opt = s.timeoutMs && s.timeoutMs !== DEFAULT_ASSERT_MS ? `{ timeout: ${s.timeoutMs} }` : '';
      return `await expect(${renderLocator(s.target)}).toBeVisible(${opt});`;
    }
    case 'assertText':
      return `await expect(${renderLocator(s.target)}).toContainText(${jsLit(s.text)});`;
    case 'assertUrl':
      return `await expect(page).toHaveURL(new RegExp(${jsLit(s.pattern)}));`;
    case 'assertTitle':
      return `await expect(page).toHaveTitle(new RegExp(${jsLit(s.pattern)}));`;
    case 'runCommand': {
      const stdinLit = s.stdin?.length ? `[${s.stdin.map(jsLit).join(', ')}]` : 'undefined';
      return `expect(await runCommand(${jsLit(s.command)}, ${stdinLit}, ${s.timeoutMs})).toBe(0);`;
    }
    case 'writeFile':
      return `writeFileTo(${jsLit(s.path)}, ${jsLit(s.content)});`;
    default: {
      const _never: never = s;
      throw new Error(`unknown step: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * 按轨迹计算用例超时:基础 30s + 每个动作 1s + 各断言的完整超时预算
 * (wait_for 的长等待在回放时会真实发生,如等录制结束,必须计入)+
 * 各 runCommand 的完整超时预算(命令回放时同样真实执行)。上限 15 分钟。
 */
export function computeTimeout(traj: Trajectory): number {
  let ms = 30_000;
  for (const s of traj.steps) {
    if (s.kind === 'stepStart') continue;
    ms += 1_000;
    if (s.kind === 'assertVisible') ms += s.timeoutMs ?? DEFAULT_ASSERT_MS;
    else if (s.kind.startsWith('assert')) ms += DEFAULT_ASSERT_MS;
    else if (s.kind === 'runCommand') ms += s.timeoutMs;
  }
  return Math.min(ms, 900_000);
}

interface Group {
  title?: string;
  steps: ActionStep[];
}

function groupByStep(steps: Step[]): Group[] {
  const groups: Group[] = [];
  let cur: Group = { steps: [] };
  for (const s of steps) {
    if (s.kind === 'stepStart') {
      if (cur.title !== undefined || cur.steps.length) groups.push(cur);
      cur = { title: s.title, steps: [] };
    } else {
      cur.steps.push(s);
    }
  }
  if (cur.title !== undefined || cur.steps.length) groups.push(cur);
  return groups;
}

function renderGroups(groups: Group[], pad: string): string {
  if (groups.length === 0) return `${pad}// (无步骤)`;
  const lines: string[] = [];
  for (const g of groups) {
    if (g.title === undefined) {
      for (const s of g.steps) lines.push(pad + renderStep(s));
    } else {
      lines.push(`${pad}await test.step(${jsLit(g.title)}, async () => {`);
      if (g.steps.length === 0) lines.push(`${pad}  // (该步骤未记录到操作)`);
      for (const s of g.steps) lines.push(`${pad}  ${renderStep(s)}`);
      lines.push(`${pad}});`);
    }
  }
  return lines.join('\n');
}

/** 描述折行为 // 注释(CJK 无词边界,按宽度硬切)。 */
function docComment(description: string): string {
  const doc = (description || '').replace(/\s+/g, ' ').trim();
  if (!doc) return '';
  const lines: string[] = [];
  for (let i = 0; i < doc.length; i += 100) lines.push(`// ${doc.slice(i, i + 100)}`);
  return lines.join('\n') + '\n';
}

/** runCommand / writeFile 步骤所需的 node: import 与辅助函数,仅在轨迹用到时注入。 */
function nodeHelpers(traj: Trajectory): { imports: string; helpers: string } {
  const hasCmd = traj.steps.some((s) => s.kind === 'runCommand');
  const hasWrite = traj.steps.some((s) => s.kind === 'writeFile');
  const imports: string[] = [];
  const helpers: string[] = [];
  if (hasCmd) imports.push(`import { spawn } from 'node:child_process';`);
  if (hasWrite) imports.push(`import { mkdirSync, writeFileSync } from 'node:fs';`);
  if (hasCmd || hasWrite) imports.push(`import { dirname${hasWrite ? ', resolve' : ''} } from 'node:path';`);
  if (hasCmd) helpers.push(SHELL_HELPER_TS);
  if (hasWrite) helpers.push(WRITE_HELPER_TS);
  return {
    imports: imports.length ? imports.join('\n') + '\n' : '',
    helpers: helpers.length ? helpers.join('\n\n') + '\n\n' : '',
  };
}

export interface RenderOpts {
  testName: string;
  description: string;
  target: TargetSpec;
}

export function renderTest(traj: Trajectory, opts: RenderOpts): string {
  const { testName, description, target } = opts;
  const title = jsLit(testName || 'generated');
  const groups = groupByStep(traj.steps);
  const timeout = computeTimeout(traj);
  const extra = nodeHelpers(traj);

  if (target.mode === 'electron') {
    const argsLit = `[${target.args.map(jsLit).join(', ')}]`;
    return (
      `import { test, expect, _electron as electron } from '@playwright/test';\n` +
      extra.imports +
      `\n` +
      extra.helpers +
      docComment(description) +
      `test(${title}, async () => {\n` +
      `  test.setTimeout(${timeout});\n` +
      `  const electronApp = await electron.launch({ executablePath: ${jsLit(target.bin)}, args: ${argsLit} });\n` +
      `  try {\n` +
      `    const page = await electronApp.firstWindow();\n` +
      `${renderGroups(groups, '    ')}\n` +
      `  } finally {\n` +
      `    await electronApp.close();\n` +
      `  }\n` +
      `});\n`
    );
  }

  return (
    `import { test, expect } from '@playwright/test';\n` +
    extra.imports +
    `\n` +
    extra.helpers +
    docComment(description) +
    `test(${title}, async ({ page }) => {\n` +
    `  test.setTimeout(${timeout});\n` +
    `${renderGroups(groups, '  ')}\n` +
    `});\n`
  );
}
