/**
 * 通用生成引擎:步骤拆分 → 逐步骤 Agent 探索 → 轨迹→代码 → clean-replay → 修复。
 *
 * 为什么按步骤驱动:把整个多步骤场景塞进一个长对话,模型会在步数上限或注意力上
 * 飘走,静默地只做前几步(旧 v2 的核心缺陷)。改为**引擎持有步骤清单**:
 * - 描述里的"步骤N:"被确定性拆分,每个步骤跑一个独立对话、有独立轮数预算;
 * - 步骤做不完就显式失败并重试,绝不静默跳过;
 * - 所有步骤的轨迹按顺序汇入**同一个用例文件**(test.step 分块)。
 *
 * Agent 在真实浏览器/应用里操作,引擎自动记录每一步真正成功的操作与断言
 * (结构化描述符),最后由 codegen 确定性渲染,再 clean-replay 校验;
 * 失败则带失败信息重新探索(verify → repair)。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { Session } from './browser';
import { computeTimeout, renderTest } from './codegen';
import { deepseekModel, envMaxSteps } from './models';
import { runPlaywright } from './runner';
import { capOutput, execShell } from './shell';
import { Trajectory, type TargetSpec } from './trajectory';
import { describeScreenshot } from './vision';

// ---------- 步骤拆分(确定性,不引入 LLM 规划器) ----------

export interface PlanStep {
  title: string; // 如 "步骤1";无标注时为 "任务"
  text: string;
}

export interface Plan {
  preamble: string; // 首个"步骤N:"之前的背景文字(无标注时为空)
  steps: PlanStep[];
}

/**
 * 按 "步骤N:" / "第N步:" / "Step N:" 标注拆分描述(标注需在句首:字符串开头或
 * 换行/句号/分号 之后)。少于 2 个标注则整段描述作为单一步骤——行为与不拆分完全一致。
 */
export function splitSteps(description: string): Plan {
  const re = /(?:^|[\n。；;.!?！？])\s*(?:(?:步骤|step)\s*(\d+)|第\s*(\d+)\s*步)\s*[：:]/gi;
  const marks: { index: number; end: number; num: string }[] = [];
  for (const m of description.matchAll(re)) {
    marks.push({ index: m.index, end: m.index + m[0].length, num: m[1] ?? m[2] });
  }
  if (marks.length < 2) {
    return { preamble: '', steps: [{ title: '任务', text: description.trim() }] };
  }
  const steps = marks.map((mk, i) => ({
    title: `步骤${mk.num}`,
    text: description.slice(mk.end, i + 1 < marks.length ? marks[i + 1].index : undefined).trim(),
  }));
  return { preamble: description.slice(0, marks[0].index).trim(), steps };
}

/**
 * 步骤描述是否含"预期结果"——含则 step_done 前必须有断言。
 * 保存/导出/下载类字样也算:产出文件的步骤必须有可回放的验证(click_and_save /
 * run_command),否则"点了按钮但文件没落盘"会静默通过。
 */
const EXPECTATION_RE =
  /预期|期望|应该|应当|出现|显示|可见|看到|包含|变为|变成|保存|导出|下载|expect|should|appear|visible|verif|assert|save|export|download/i;

// ---------- Agent 指令 ----------

const AGENT_SYSTEM = `你是 UI 测试探索 Agent,在真实浏览器/应用里"像测试员一样操作",完成用户场景中的**当前一个步骤**,并对该步骤描述的预期结果做断言。
系统会自动记录你每一步真正成功的操作与断言,所有步骤完成后据完整轨迹生成确定性的 @playwright/test 用例——你不需要写代码,只需正确地操作和断言。

工作循环:
1. 观察:操作类工具的返回里附带最新页面状态(可交互元素 ref 列表 + ARIA 树);需要时可调 get_page_state 重新观察。
2. 操作:click / click_and_save / fill / check / uncheck / select_option / hover / press_key / scroll。优先用 ref(如 click("e3")),也可用可见名称(click("打开设置"))。
3. 等待:录制、加载、跳转等**耗时过程**,用 wait_for("<预期出现的文本>", timeout_seconds) 等待其完成,给足时间(如录制场景 120~300 秒)——不要反复 get_page_state 轮询,不要臆测已完成。
4. 断言:用 assert_visible / assert_text / assert_url / assert_title 验证该步骤的预期结果;wait_for 等到目标也会作为断言记入用例。**这是测试的价值,不要只操作不断言**。
5. 该步骤全部完成且预期已断言后,调用 step_done(summary) 并停止。

规则:
- **只做当前步骤**:不要提前执行后续步骤的操作;也不要重复之前步骤已完成的操作(它们的效果仍然有效,如已登录、已连接的设备)。每一步先看当前真实状态,只做尚未完成的部分。
- 一次只做一个动作,依据返回的真实状态推进,不要臆测看不到的元素。
- 优先用 click 直接点击可见目标(按钮、标签、链接)。除非确实没有可点元素,否则不要用 press_key 的 Tab/Enter 做导航或激活——那样生成的用例很脆弱。
- 开关/复选框:打开用 check,关闭用 uncheck(元素列表里标注了 [已选中]/[未选中]);若 check/uncheck 报不支持,改用 click 切换。
- **保存/导出/下载文件的按钮用 click_and_save**(指定保存文件名),不要用 click:下载产物和操作系统的原生保存对话框都不在页面里,普通 click 拿不到文件;click_and_save 会自动接住下载/原生对话框并把文件落到指定路径,文件真实生成才算成功——它同时就是该步骤"文件已保存"的验证。不要尝试与原生保存对话框交互。
- 若提示"未找到 / 匹配多个 / 无法唯一定位",先 get_page_state 看最新 ref,再改用具体 ref 或更精确的名称。
- 下拉选择用 select_option;若它不适用(自定义下拉),点击展开后再点击选项。
- 操作失败会返回失败原因,依据它调整策略:换更精确的目标、先 wait_for 等待、或改用其他操作。
- 禁止任何形式的硬等待/轮询;需要等待就用 wait_for(它会连同超时记入用例)。
- 本地环境工具:run_command 执行 shell 命令(交互式 CLI 用 stdin_lines 逐行输入,如 hdc shell);write_file 写入本地文件;read_file 读取文件内容用于观察(不记入用例)。run_command 与 write_file 成功后会记入用例并在回放时原样重放。仅在步骤明确要求命令行/文件操作时使用,UI 上能完成的操作必须在 UI 上做。`;

// ---------- 工具 ----------

interface StepFlag {
  done: boolean;
  summary: string;
  rejects: number;
}

interface ToolCtx {
  session: Session;
  traj: Trajectory;
  runDir: string;
  vision: boolean;
  mark: number; // 当前步骤在轨迹里的起点
  needsAssert: boolean;
  flag: StepFlag;
}

function makeTools(ctx: ToolCtx): ToolSet {
  const { session, traj } = ctx;

  const withState = async (msg: string) => `${msg}\n\n${await session.snapshot()}`;
  // 所有异常(定位失败/超时等)都转为文字反馈给模型,让它自纠而不是中断对话
  const guard = async (fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `操作失败:${msg.slice(0, 600)}`;
    }
  };

  const tools: ToolSet = {
    get_page_state: tool({
      description: '获取当前页面状态(ARIA 树 + 可交互元素 ref 列表)。操作类工具的返回已附带最新状态,仅在需要重新观察时调用。',
      inputSchema: z.object({}),
      execute: async () => await session.snapshot(),
    }),

    click: tool({
      description: '点击元素。target 可为 ref(如 e3)或元素可见名称(如 打开设置)。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.click(target);
          traj.add({ kind: 'click', target: d });
          return withState(`已点击:${target}`);
        }),
    }),

    click_and_save: tool({
      description:
        '点击会触发"保存文件/下载"的元素(保存/导出/下载类按钮)并把产物保存为 save_as(文件名或相对路径,相对本次运行目录;要求"保存在当前路径"就直接写文件名)。' +
        '自动接住下载事件与 Electron 原生保存对话框——原生对话框不在页面里,你看不到也点不到,所以这类点击必须用本工具而不是 click。' +
        '若目标文件已存在会先删除,文件真实落盘才算成功并记入用例,回放时重演点击并断言文件生成。timeout_seconds 默认 60、最长 600。',
      inputSchema: z.object({
        target: z.string(),
        save_as: z.string(),
        timeout_seconds: z.number().optional(),
      }),
      execute: async ({ target, save_as, timeout_seconds }) =>
        guard(async () => {
          const ms = Math.round(Math.min(Math.max(timeout_seconds ?? 60, 1), 600) * 1000);
          const abs = resolve(ctx.runDir, save_as);
          const d = await session.clickAndSave(target, abs, ms);
          traj.add({ kind: 'clickSave', target: d, path: save_as, timeoutMs: ms });
          return withState(`已点击并保存文件:${save_as}(${statSync(abs).size} 字节),已记录到用例。`);
        }),
    }),

    fill: tool({
      description: '在输入框填入文本。target 可为 ref 或输入框可见名称/占位符。',
      inputSchema: z.object({ target: z.string(), text: z.string() }),
      execute: async ({ target, text }) =>
        guard(async () => {
          const d = await session.fill(target, text);
          traj.add({ kind: 'fill', target: d, value: text });
          return withState(`已填入:${target} = ${text}`);
        }),
    }),

    check: tool({
      description: '勾选复选框/打开开关(已是选中态则保持)。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.check(target);
          traj.add({ kind: 'check', target: d });
          return withState(`已勾选:${target}`);
        }),
    }),

    uncheck: tool({
      description: '取消勾选复选框/关闭开关(已是未选中态则保持)。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.uncheck(target);
          traj.add({ kind: 'uncheck', target: d });
          return withState(`已取消勾选:${target}`);
        }),
    }),

    select_option: tool({
      description: '在下拉框(select / combobox)选择一个选项。value 为选项的可见文本或 value。',
      inputSchema: z.object({ target: z.string(), value: z.string() }),
      execute: async ({ target, value }) =>
        guard(async () => {
          const d = await session.selectOption(target, value);
          traj.add({ kind: 'selectOption', target: d, value });
          return withState(`已选择:${target} = ${value}`);
        }),
    }),

    hover: tool({
      description: '把鼠标悬停到元素上(用于触发 hover 才出现的内容)。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.hover(target);
          traj.add({ kind: 'hover', target: d });
          return withState(`已悬停:${target}`);
        }),
    }),

    press_key: tool({
      description: '按键(如 Enter / Escape)。target 为空则对页面按键,否则对该元素按键。',
      inputSchema: z.object({ key: z.string(), target: z.string().optional() }),
      execute: async ({ key, target }) =>
        guard(async () => {
          const d = await session.press(key, target || undefined);
          traj.add({ kind: 'press', target: d, key });
          return withState(`已按键:${key}`);
        }),
    }),

    scroll: tool({
      description: '滚动页面,direction 为 up/down/top/bottom。',
      inputSchema: z.object({ direction: z.string() }),
      execute: async ({ direction }) => {
        await session.scroll(direction);
        return await session.snapshot();
      },
    }),

    wait_for: tool({
      description:
        '等待某文本/元素出现并可见,用于录制、加载、跳转等**耗时过程**。target 通常填预期出现的文本(不必当前就在页面上);timeout_seconds 默认 60、最长 600,请按过程时长给足。等待成功会作为断言记入用例。',
      inputSchema: z.object({ target: z.string(), timeout_seconds: z.number().optional() }),
      execute: async ({ target, timeout_seconds }) =>
        guard(async () => {
          const ms = Math.round(Math.min(Math.max(timeout_seconds ?? 60, 1), 600) * 1000);
          const d = await session.waitFor(target, ms);
          traj.add({ kind: 'assertVisible', target: d, timeoutMs: ms });
          return withState(`已等到:${target}`);
        }),
    }),

    assert_visible: tool({
      description: '断言元素/文本当前可见(会记入最终用例)。target 可为 ref 或可见文本。',
      inputSchema: z.object({ target: z.string() }),
      execute: async ({ target }) =>
        guard(async () => {
          const d = await session.assertVisible(target);
          traj.add({ kind: 'assertVisible', target: d });
          return `断言通过:${target} 可见。`;
        }),
    }),

    assert_text: tool({
      description: '断言某元素包含指定文本(会记入最终用例)。',
      inputSchema: z.object({ target: z.string(), text: z.string() }),
      execute: async ({ target, text }) =>
        guard(async () => {
          const d = await session.assertText(target, text);
          traj.add({ kind: 'assertText', target: d, text });
          return `断言通过:${target} 含文本 "${text}"。`;
        }),
    }),

    assert_url: tool({
      description: '断言当前 URL 匹配正则 pattern(会记入最终用例)。',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) =>
        guard(async () => {
          await session.assertUrl(pattern);
          traj.add({ kind: 'assertUrl', pattern });
          return `断言通过:URL 匹配 ${pattern}。`;
        }),
    }),

    assert_title: tool({
      description: '断言页面标题匹配正则 pattern(会记入最终用例)。',
      inputSchema: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) =>
        guard(async () => {
          await session.assertTitle(pattern);
          traj.add({ kind: 'assertTitle', pattern });
          return `断言通过:标题匹配 ${pattern}。`;
        }),
    }),

    run_command: tool({
      description:
        '执行一条 shell 命令并等待其结束,返回输出与退出码(darwin/linux 用 sh,Windows 用 cmd;需要 powershell 时命令写 powershell -Command "…")。' +
        'stdin_lines 用于给交互式 CLI 逐行输入,如 run_command("hdc shell", stdin_lines=["cd vendor/bin","counters gather xxx","exit"]);' +
        '若交互输入无效,改用单条命令形式,如 hdc shell "cd vendor/bin && counters gather xxx"。' +
        '退出码为 0 才记入用例,回放时会重跑该命令并断言退出码为 0;预期非 0 的命令请写成 cmd || true。' +
        'timeout_seconds 默认 60、最长 600。仅在步骤明确要求命令行操作时使用,UI 能完成的操作不要用命令代替。',
      inputSchema: z.object({
        command: z.string(),
        stdin_lines: z.array(z.string()).optional(),
        timeout_seconds: z.number().optional(),
      }),
      execute: async ({ command, stdin_lines, timeout_seconds }) =>
        guard(async () => {
          const ms = Math.round(Math.min(Math.max(timeout_seconds ?? 60, 1), 600) * 1000);
          const r = await execShell(command, { stdinLines: stdin_lines, timeoutMs: ms, cwd: ctx.runDir });
          if (r.timedOut) return `命令超时(${ms}ms)已终止,未记录到用例。输出:\n${capOutput(r.output)}`;
          if (r.code === null) return `命令启动失败或被信号终止,未记录到用例。输出:\n${capOutput(r.output)}`;
          if (r.code !== 0) return `命令退出码 ${r.code}(非 0,未记录到用例)。输出:\n${capOutput(r.output)}`;
          traj.add({ kind: 'runCommand', command, stdin: stdin_lines, timeoutMs: ms });
          return `命令成功(退出码 0),已记录到用例。输出:\n${capOutput(r.output)}`;
        }),
    }),

    write_file: tool({
      description:
        '把文本内容写入本地文件(UTF-8,自动创建父目录)。会记入用例并在回放时重写同一文件。相对路径相对本次运行目录解析,跨目录请用绝对路径。',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) =>
        guard(async () => {
          const abs = resolve(ctx.runDir, path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, 'utf-8');
          traj.add({ kind: 'writeFile', path, content });
          return `已写入文件:${path}(${Buffer.byteLength(content, 'utf-8')} 字节),已记录到用例。`;
        }),
    }),

    read_file: tool({
      description:
        '读取本地文件内容用于观察判断(UTF-8,超长会截断中间)。只用于观察,不记入用例。相对路径相对本次运行目录解析。',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        guard(async () => capOutput(readFileSync(resolve(ctx.runDir, path), 'utf-8'))),
    }),

    step_done: tool({
      description: '当前步骤的全部要求(含预期结果的断言)都完成后调用,给出一句执行摘要。成功后停止,不要再调用任何工具。',
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }) => {
        const delta = traj.since(ctx.mark);
        if (delta.length === 0) {
          return '还没有执行任何操作或断言,不能结束该步骤。请先按步骤描述实际操作页面。';
        }
        // runCommand / clickSave 也算验证:回放时会重演并断言(命令退出码 0 / 文件真实落盘)
        const hasAssert = delta.some(
          (s) => s.kind.startsWith('assert') || s.kind === 'runCommand' || s.kind === 'clickSave',
        );
        if (ctx.needsAssert && !hasAssert && ctx.flag.rejects < 2) {
          ctx.flag.rejects += 1;
          return '该步骤描述了预期结果,但尚未做任何断言。请先用 assert_visible / assert_text / wait_for 验证预期(命令执行由成功的 run_command 覆盖,文件保存由 click_and_save 覆盖),再调用 step_done。';
        }
        ctx.flag.done = true;
        ctx.flag.summary = summary;
        return '该步骤已完成,请停止。';
      },
    }),
  };

  if (ctx.vision) {
    tools.look = tool({
      description: '【需 --vision】对当前页面截图,用视觉模型(qwen)返回文字描述;DOM 信息不足时使用。',
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

// ---------- 逐步骤探索 ----------

function buildStepPrompt(
  plan: Plan,
  index: number,
  summaries: string[],
  state: string,
  hints: string[],
): string {
  const { steps } = plan;
  const cur = steps[index];
  const lines: string[] = [];

  if (steps.length > 1) {
    lines.push(`整体任务共 ${steps.length} 个步骤(全部步骤最终生成同一个用例):`);
    if (plan.preamble) lines.push(`背景:${plan.preamble}`);
    steps.forEach((p, i) => {
      const tag = i < index ? '[已完成]' : i === index ? '[当前]' : '[后续]';
      lines.push(`${tag} ${p.title}:${p.text}`);
    });
    if (summaries.length) {
      lines.push('', '已完成步骤的执行摘要:');
      summaries.forEach((s, i) => lines.push(`- ${steps[i].title}:${s}`));
    }
    lines.push(
      '',
      `现在只需完成 ${cur.title}:${cur.text}`,
      '后续步骤不要提前做;已完成步骤的效果仍然有效,不要重做。',
    );
  } else {
    lines.push(`任务:${cur.text}`);
  }

  for (const h of hints) lines.push('', `注意:${h}`);
  lines.push('', `当前页面状态:\n${state}`, '', '请开始操作,完成后调用 step_done。');
  return lines.join('\n');
}

interface ExploreResult {
  traj: Trajectory;
  summaries: string[];
  failed?: { index: number; reason: string };
}

async function explore(
  opts: RunOpts,
  plan: Plan,
  runDir: string,
  round: number,
  replayHint: string | undefined,
): Promise<ExploreResult> {
  const headless = !opts.headed;
  const budget = opts.maxSteps ?? envMaxSteps();
  const tracePath = opts.trace ? join(runDir, `trace_round${round}.zip`) : undefined;
  const session = new Session(opts.target, { headless, slowMo: headless ? 0 : 500, tracePath });

  const traj = new Trajectory();
  const summaries: string[] = [];

  await session.start();
  try {
    if (opts.target.mode === 'web') {
      await session.goto(opts.target.url);
      traj.add({ kind: 'goto', url: opts.target.url });
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (plan.steps.length > 1) {
        traj.add({ kind: 'stepStart', title: `${step.title}:${step.text.slice(0, 50)}` });
      }
      const mark = traj.steps.length;
      console.log(`  [${step.title} · ${i + 1}/${plan.steps.length}] ${step.text.slice(0, 60)}`);

      let done = false;
      let retryHint: string | undefined;
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        const flag: StepFlag = { done: false, summary: '', rejects: 0 };
        const tools = makeTools({
          session,
          traj,
          runDir,
          vision: !!opts.vision,
          mark,
          needsAssert: EXPECTATION_RE.test(step.text),
          flag,
        });
        const hints = [replayHint, retryHint].filter((h): h is string => !!h);
        const state = await session.snapshot();
        await generateText({
          model: deepseekModel(),
          system: AGENT_SYSTEM,
          prompt: buildStepPrompt(plan, i, summaries, state, hints),
          tools,
          stopWhen: [stepCountIs(budget), () => flag.done],
        });

        if (flag.done) {
          done = true;
          summaries.push(flag.summary || '(已完成)');
          console.log(`    ✓ ${flag.summary.slice(0, 80)}`);
        } else if (attempt === 1) {
          retryHint =
            '上一次尝试未能完成该步骤就停止了。请更直接地按步骤要求执行;若在等待耗时过程,用 wait_for 并给足 timeout_seconds;完成后必须调用 step_done。';
          console.log('    ↻ 未完成,重试一次');
        }
      }

      if (!done) {
        return { traj, summaries, failed: { index: i, reason: '两次尝试均未完成该步骤' } };
      }
    }
    return { traj, summaries };
  } finally {
    await session.close().catch(() => {});
  }
}

// ---------- 顶层流程 ----------

export interface RunOpts {
  target: TargetSpec;
  description: string;
  outDir: string;
  name?: string;
  vision?: boolean;
  headed?: boolean;
  maxSteps?: number;
  maxRepairs?: number;
  trace?: boolean;
}

export async function run(opts: RunOpts): Promise<void> {
  const runDir = makeRunDir(opts.outDir, opts.name);
  const testPath = join(runDir, 'test_generated.spec.ts');
  const plan = splitSteps(opts.description);
  const testName = opts.name?.trim() || opts.description.replace(/\s+/g, ' ').slice(0, 50);

  console.log(`[目标] ${opts.target.mode === 'web' ? opts.target.url : opts.target.bin}`);
  if (plan.steps.length > 1) {
    console.log(`[计划] 描述含 ${plan.steps.length} 个步骤,逐步执行并生成到同一个用例:`);
    plan.steps.forEach((p) => console.log(`  ${p.title}: ${p.text.slice(0, 60)}`));
  }

  const rounds = 1 + Math.max(0, opts.maxRepairs ?? 1);
  let replayHint: string | undefined;
  let lastFailure = '';
  let wrote = false;

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n[探索] 第 ${round}/${rounds} 轮`);
    let ex: ExploreResult;
    try {
      ex = await explore(opts, plan, runDir, round, replayHint);
    } catch (e) {
      lastFailure = `探索异常:${String(e)}`;
      replayHint = lastFailure;
      console.log(`  ✗ ${lastFailure.slice(0, 300)}`);
      continue;
    }

    // 无论成败都写出当前最好的一版,便于查看/调试
    writeFileSync(testPath, renderTest(ex.traj, { testName, description: opts.description, target: opts.target }), 'utf-8');
    wrote = true;

    if (ex.failed) {
      const st = plan.steps[ex.failed.index];
      lastFailure = `${st.title} 未完成:${ex.failed.reason}(${st.text.slice(0, 80)})`;
      replayHint = `上一轮探索中 ${lastFailure}。本轮到该步骤时请换思路:先观察页面找到正确入口,耗时过程用 wait_for 给足超时。`;
      console.log(`  ✗ ${lastFailure}`);
      continue;
    }

    console.log('[回放] 用全新上下文运行生成的用例…');
    const { passed, output } = await runPlaywright(testPath, computeTimeout(ex.traj) + 60_000);
    if (passed) {
      console.log(`\n✅ 全部 ${plan.steps.length} 个步骤完成,clean-replay 通过 → ${testPath}`);
      ex.summaries.forEach((s, i) => console.log(`  ${plan.steps[i].title}: ${s}`));
      return;
    }
    lastFailure = `clean-replay 失败:\n${output.slice(-1200)}`;
    replayHint = `上一轮生成的用例在干净回放时失败(探索时成功但重放不稳定)。本轮请优先选更稳定的定位/断言,耗时过程用 wait_for 并给足超时。失败日志:\n${output.slice(-1200)}`;
    console.log('  ✗ 回放失败');
  }

  process.exitCode = 1;
  console.log(
    wrote
      ? `\n❌ ${rounds} 轮内未能生成完整通过的用例。最后一版已写入:${testPath}`
      : `\n❌ ${rounds} 轮内未能生成用例(探索未产生轨迹)。`,
  );
  if (lastFailure) console.log(`\n${lastFailure}`);
}

// ---------- 输出目录 ----------

function makeRunDir(outDir: string, name?: string | null): string {
  const stamp = name && name.trim() ? name.trim() : timestamp();
  const dir = join(outDir, stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
