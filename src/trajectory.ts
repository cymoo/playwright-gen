/**
 * 结构化轨迹:LocatorDescriptor / Step / TargetSpec / Trajectory。
 *
 * 核心质量杠杆(忠实定位):轨迹记录的是**结构化定位描述符**,不是预先渲染好的字符串。
 * 探索时用它构造**真正执行**的 Playwright locator 并校验唯一命中;codegen 用**同一个**
 * 描述符渲染代码——保证"生成代码里的定位 === 探索时真正点中的定位",且同一条轨迹
 * 可按 web / electron 两种形态分别渲染。
 *
 * stepStart 是步骤分组标记:多步骤描述时引擎在每个步骤开始前打标,codegen 据此把
 * 动作分进 test.step() 块。
 */

/** 一个"如何唯一定位到某元素"的结构化描述,与目标(web/electron)无关。 */
export type LocatorDescriptor =
  | { kind: 'role'; role: string; name?: string; exact?: boolean; nth?: number }
  | { kind: 'label'; text: string; exact?: boolean; nth?: number }
  | { kind: 'placeholder'; text: string; nth?: number }
  | { kind: 'testId'; testId: string; nth?: number }
  | { kind: 'text'; text: string; exact?: boolean; nth?: number };

/**
 * 一条轨迹步骤(判别联合)。assertVisible 的 timeoutMs 用于 wait_for 的长等待。
 * runCommand / writeFile 是非页面步骤(无定位描述符,同 goto/assertUrl):
 * 记录真正成功执行过的 shell 命令(含喂给 stdin 的行)与文件写入,回放时原样重放。
 * clickSave 是"点击触发保存/下载并把产物落到 path"的复合步骤:探索时文件真实
 * 落盘才记录,回放时重演点击并断言文件生成(path 相对 run 目录)。
 */
export type Step =
  | { kind: 'stepStart'; title: string }
  | { kind: 'goto'; url: string }
  | { kind: 'click'; target: LocatorDescriptor }
  | { kind: 'clickSave'; target: LocatorDescriptor; path: string; timeoutMs: number }
  | { kind: 'fill'; target: LocatorDescriptor; value: string }
  | { kind: 'check'; target: LocatorDescriptor }
  | { kind: 'uncheck'; target: LocatorDescriptor }
  | { kind: 'selectOption'; target: LocatorDescriptor; value: string }
  | { kind: 'hover'; target: LocatorDescriptor }
  | { kind: 'press'; target?: LocatorDescriptor; key: string }
  | { kind: 'assertVisible'; target: LocatorDescriptor; timeoutMs?: number }
  | { kind: 'assertText'; target: LocatorDescriptor; text: string }
  | { kind: 'assertUrl'; pattern: string }
  | { kind: 'assertTitle'; pattern: string }
  | { kind: 'runCommand'; command: string; stdin?: string[]; timeoutMs: number }
  | { kind: 'writeFile'; path: string; content: string };

/** 生成用例要打开的目标:web 页面(goto url)或 electron 应用(启动可执行文件)。 */
export type TargetSpec =
  | { mode: 'web'; url: string }
  | { mode: 'electron'; bin: string; args: string[] };

export class Trajectory {
  steps: Step[] = [];

  add(step: Step): void {
    this.steps.push(step);
  }

  /** 自 mark 位置起的步骤(供逐步骤校验:该步骤是否有操作/断言)。 */
  since(mark: number): Step[] {
    return this.steps.slice(mark);
  }
}
