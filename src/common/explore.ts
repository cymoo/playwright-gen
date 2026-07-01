/**
 * 探索引擎（v2/v3 共用）：AI SDK 工具 + Explorer 循环 + generateOne 流水线。
 *
 * Agent 在真实浏览器/应用里操作，引擎**自动记录每一步真正成功的操作与断言**（结构化
 * 描述符），finalize 后由 codegen 据轨迹**确定性**生成 @playwright/test 用例，再 clean-replay
 * 校验；失败则回灌失败信息让 Agent 重新探索（verify→repair，已覆盖"回放失败"）。
 *
 * 工具依赖（session / trajectory 等）通过闭包工厂注入，而非框架 context。
 */

import { basename, dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { generateText, hasToolCall, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { ResolveError, Session } from './browser';
import { renderTest } from './codegen';
import { deepseekModel, maxSteps as envMaxSteps } from './models';
import { runPlaywright } from './runner';
import { sanitizeCode } from './sanitizer';
import { Trajectory, type TargetSpec } from './trajectory';
import { describeScreenshot } from './vision';

interface Finalized {
  done: boolean;
  testName: string;
  notes: string;
}

interface ExploreCtx {
  session: Session;
  traj: Trajectory;
  vision: boolean;
  runDir: string;
  finalized: Finalized;
}

const EXPLORE_INSTRUCTIONS = `你是浏览器测试探索 Agent，在真实浏览器/应用里"像测试员一样操作"，完成用户描述的场景，并对关键结果做断言。
系统会**自动记录你每一步真正成功的操作与断言**，最终据此生成确定性的 @playwright/test 用例——
所以你**不需要自己写代码**，只需正确地操作和断言。

工作循环：
1. 用 get_page_state 观察页面（列出 ARIA 树与可交互元素 ref，如 e1/e2）。操作类工具的返回里也已附带最新状态。
2. 操作：click / fill / check / select_option / hover / press_key / scroll。优先用 ref（click("e3")），也可用可见名称（click("打开设置")）。
3. 操作后页面常会变化（弹窗/跳转/异步内容），依据返回的新状态继续。
4. 在合适时机用 assert_visible / assert_text / assert_url / assert_title 验证目标结果——**这是测试的价值，不要只操作不断言**。
5. 完成后调用 finalize(test_name, notes) 并停止。

规则：
- 一次只做一个动作，依据真实观察推进，不要臆测看不到的元素。
- **优先用 click 直接点击可见目标元素**（标签、按钮、链接）。除非确实没有可点击元素，
  否则不要用 press_key 的 Tab/Enter 做导航或激活——那样生成的用例很脆弱。
- **不要重复已经完成的操作**：例如登录成功后登录表单会消失、应用主界面出现，此时
  **不要再次填写用户名/密码或再次点击登录**，直接依据新界面继续（如点击目标标签页）。
  每一步都先看当前真实状态，只做尚未完成的部分。
- 若提示"未找到 / 匹配多个 / 无法唯一定位"，先重新 get_page_state 看最新 ref，再改用具体 ref 或更精确的名称。
- 下拉选择用 select_option；校验某处出现特定文字用 assert_text。
- 至少产生一个有意义的断言再 finalize。
- 不要使用任何形式的硬等待；交互后看新状态即可。`;

function makeTools(ctx: ExploreCtx) {
  const { session, traj } = ctx;

  const withState = async (msg: string) => `${msg}\n\n${await session.snapshot()}`;
  const guard = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResolveError) return e.message;
      throw e;
    }
  };

  const tools: ToolSet = {
    get_page_state: tool({
      description: '获取当前页面状态（ARIA 树 + 可交互元素 ref 列表）。每次操作后都应重新调用。',
      inputSchema: z.object({}),
      execute: async () => await session.snapshot(),
    }),

    click: tool({
      description: '点击元素。target 可为 ref（如 e3）或元素可见名称（如 打开设置）。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.click(target);
          traj.add({ kind: 'click', target: d });
          return withState(`已点击：${target}`);
        }),
    }),

    fill: tool({
      description: '在输入框填入文本。target 可为 ref 或输入框可见名称/占位符。',
      inputSchema: z.object({ target: z.string(), text: z.string() }),
      execute: async ({ target, text }) =>
        guard(async () => {
          const d = await session.fill(target, text);
          traj.add({ kind: 'fill', target: d, value: text });
          return withState(`已填入：${target} = ${text}`);
        }),
    }),

    check: tool({
      description: '勾选复选框 / 开关。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.check(target);
          traj.add({ kind: 'check', target: d });
          return withState(`已勾选：${target}`);
        }),
    }),

    select_option: tool({
      description: '在下拉框（select / combobox）选择一个选项。value 为选项的可见文本或 value。',
      inputSchema: z.object({ target: z.string(), value: z.string() }),
      execute: async ({ target, value }) =>
        guard(async () => {
          const d = await session.selectOption(target, value);
          traj.add({ kind: 'selectOption', target: d, value });
          return withState(`已选择：${target} = ${value}`);
        }),
    }),

    hover: tool({
      description: '把鼠标悬停到元素上（用于触发 hover 才出现的内容）。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.hover(target);
          traj.add({ kind: 'hover', target: d });
          return withState(`已悬停：${target}`);
        }),
    }),

    press_key: tool({
      description: '按键（如 Enter / Escape / Tab）。target 为空则对页面按键，否则对该元素按键。',
      inputSchema: z.object({ key: z.string(), target: z.string().optional() }),
      execute: async ({ key, target }) =>
        guard(async () => {
          const d = await session.press(key, target || undefined);
          traj.add({ kind: 'press', target: d, key });
          return withState(`已按键：${key}`);
        }),
    }),

    scroll: tool({
      description: '滚动页面，direction 为 up/down/top/bottom。',
      inputSchema: z.object({ direction: z.string() }),
      execute: async ({ direction }) => {
        await session.scroll(direction);
        return await session.snapshot();
      },
    }),

    assert_visible: tool({
      description: '断言元素/文本当前可见（会记入最终用例）。target 可为 ref 或可见文本。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) => {
        try {
          const d = await session.assertVisible(target);
          traj.add({ kind: 'assertVisible', target: d });
          return `断言通过：${target} 可见。`;
        } catch (e) {
          if (e instanceof ResolveError) return e.message;
          return `断言失败：${target} 当前不可见（请确认操作是否到位，或改用更精确的目标）。`;
        }
      },
    }),

    assert_text: tool({
      description: '断言某元素包含指定文本（会记入最终用例）。',
      inputSchema: z.object({ target: z.string(), text: z.string() }),
      execute: async ({ target, text }) => {
        try {
          const d = await session.assertText(target, text);
          traj.add({ kind: 'assertText', target: d, text });
          return `断言通过：${target} 含文本 "${text}"。`;
        } catch (e) {
          if (e instanceof ResolveError) return e.message;
          return `断言失败：${target} 未包含 "${text}"。`;
        }
      },
    }),

    assert_url: tool({
      description: '断言当前 URL 匹配正则 pattern（会记入最终用例）。',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        try {
          await session.assertUrl(pattern);
          traj.add({ kind: 'assertUrl', pattern });
          return `断言通过：URL 匹配 ${pattern}。`;
        } catch {
          return `断言失败：当前 URL 不匹配 ${pattern}（当前为 ${session.page.url()}）。`;
        }
      },
    }),

    assert_title: tool({
      description: '断言页面标题匹配正则 pattern（会记入最终用例）。',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        try {
          await session.assertTitle(pattern);
          traj.add({ kind: 'assertTitle', pattern });
          return `断言通过：标题匹配 ${pattern}。`;
        } catch {
          return `断言失败：标题不匹配 ${pattern}。`;
        }
      },
    }),

    finalize: tool({
      description: '完成任务：给出用例名与说明。系统据已记录的轨迹生成代码。调用后请停止，不要再调用工具。',
      inputSchema: z.object({ test_name: z.string(), notes: z.string().optional() }),
      execute: async ({ test_name, notes }) => {
        ctx.finalized.done = true;
        ctx.finalized.testName = test_name;
        ctx.finalized.notes = notes ?? '';
        return `已记录轨迹（共 ${traj.steps.length} 步）。任务完成，请停止。`;
      },
    }),
  };

  if (ctx.vision) {
    tools.look = tool({
      description: '【需 --vision】对当前页面截图，用视觉模型(qwen)返回文字描述；DOM 信息不足时使用。',
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question }) => {
        const p = join(ctx.runDir, '_look.png');
        await session.screenshot(p);
        return await describeScreenshot(p, question);
      },
    });
  }

  return tools;
}

function buildPrompt(target: TargetSpec, description: string, state: string, failure?: string): string {
  const opened =
    target.mode === 'web' ? `起始页面已打开：${target.url}` : `起始应用已启动（Electron）。`;
  const parts = [`任务：${description}`, `\n${opened}`, `\n当前页面状态：\n${state}`];
  if (failure) {
    parts.push(`\n注意：上一版用例在 clean-replay 时失败，请调整操作/断言后重试。失败信息：\n${failure}`);
  }
  parts.push('\n请开始探索并完成任务，最后调用 finalize。');
  return parts.join('\n');
}

function validate(traj: Trajectory): string | undefined {
  if (!traj.hasMeaningfulStep()) return '没有产生任何有效操作或断言，请实际操作页面并断言关键结果。';
  if (!traj.hasAssertion()) {
    return '缺少断言。请在操作完成后用 assert_visible / assert_text / assert_url / assert_title 验证关键结果，再 finalize。';
  }
  return undefined;
}

export interface GenResult {
  testName: string;
  code?: string;
  passed: boolean;
  output: string;
  steps: number;
  attempts: number;
  notes: string;
}

export interface GenerateOneOpts {
  target: TargetSpec;
  description: string;
  testPath: string;
  testName: string;
  vision?: boolean;
  headless?: boolean;
  maxSteps?: number;
  maxRepairs?: number;
  trace?: boolean;
}

export async function generateOne(opts: GenerateOneOpts): Promise<GenResult> {
  const { target, description, testPath } = opts;
  const vision = opts.vision ?? false;
  const headless = opts.headless ?? true;
  const steps = opts.maxSteps ?? envMaxSteps();
  const maxRepairs = opts.maxRepairs ?? 2;
  const runDir = dirname(testPath);

  let failure: string | undefined;
  let lastCode: string | undefined;
  let traj = new Trajectory();
  let notes = '';
  let chosenName = opts.testName;

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    traj = new Trajectory();
    const finalized: Finalized = { done: false, testName: opts.testName, notes: '' };
    const tracePath = opts.trace ? join(runDir, `trace_${basename(testPath)}_${attempt}.zip`) : undefined;
    const session = new Session(target, { headless, slowMo: headless ? 0 : 500, tracePath });

    console.log(`  [探索] 第 ${attempt} 次（${opts.testName}）`);
    try {
      await session.start();
      if (target.mode === 'web') {
        await session.goto(target.url);
        traj.add({ kind: 'goto', url: target.url });
      }
      const state = await session.snapshot();
      const ctx: ExploreCtx = {
        session,
        traj,
        vision,
        runDir,
        finalized,
      };
      await generateText({
        model: deepseekModel(),
        system: EXPLORE_INSTRUCTIONS,
        prompt: buildPrompt(target, description, state, failure),
        tools: makeTools(ctx),
        stopWhen: [stepCountIs(steps), hasToolCall('finalize')],
      });
      notes = finalized.notes || notes;
      chosenName = finalized.testName || opts.testName;
    } catch (e) {
      failure = `探索异常：${String(e)}`;
      await session.close().catch(() => {});
      continue;
    }
    await session.close().catch(() => {});

    const problem = validate(traj);
    if (problem && attempt <= maxRepairs) {
      failure = problem;
      continue;
    }

    const code = sanitizeCode(renderTest(traj, { testName: chosenName, description, target }));
    lastCode = code;
    writeFileSync(testPath, code, 'utf-8');
    const { passed, output } = await runPlaywright(testPath);
    if (passed) {
      return { testName: chosenName, code, passed: true, output, steps: traj.steps.length, attempts: attempt, notes };
    }
    failure = output;
  }

  return {
    testName: chosenName,
    code: lastCode,
    passed: false,
    output: failure ?? '',
    steps: traj.steps.length,
    attempts: maxRepairs + 1,
    notes,
  };
}
