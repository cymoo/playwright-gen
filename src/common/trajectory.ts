/**
 * 轨迹数据结构（v2/v3 共用）。
 *
 * 核心质量杠杆（本次重构第 1 项优化 —— 忠实定位）：轨迹里记录的是**结构化的定位
 * 描述符** LocatorDescriptor，而不是预先渲染好的字符串。探索时用它构造**真正执行**
 * 的 Playwright locator 并校验唯一命中；随后 codegen 用**同一个**描述符渲染代码——
 * 从而保证"生成代码里的定位 === 探索时真正点中的定位"，并可把同一条轨迹按
 * web / electron 两种形态分别渲染。
 */

/** 一个"如何唯一定位到某元素"的结构化描述，与目标（web/electron）无关。 */
export type LocatorDescriptor =
  | { kind: 'role'; role: string; name?: string; exact?: boolean; nth?: number }
  | { kind: 'label'; text: string; exact?: boolean; nth?: number }
  | { kind: 'placeholder'; text: string; nth?: number }
  | { kind: 'testId'; testId: string; nth?: number }
  | { kind: 'text'; text: string; exact?: boolean; nth?: number };

/** 一条轨迹步骤（判别联合）。 */
export type Step =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; target: LocatorDescriptor }
  | { kind: 'fill'; target: LocatorDescriptor; value: string }
  | { kind: 'check'; target: LocatorDescriptor }
  | { kind: 'uncheck'; target: LocatorDescriptor }
  | { kind: 'selectOption'; target: LocatorDescriptor; value: string }
  | { kind: 'hover'; target: LocatorDescriptor }
  | { kind: 'press'; target?: LocatorDescriptor; key: string }
  | { kind: 'assertVisible'; target: LocatorDescriptor }
  | { kind: 'assertText'; target: LocatorDescriptor; text: string }
  | { kind: 'assertUrl'; pattern: string }
  | { kind: 'assertTitle'; pattern: string };

/** 生成用例要打开的目标：web 页面（goto url）或 electron 应用（启动可执行文件）。 */
export type TargetSpec =
  | { mode: 'web'; url: string }
  | { mode: 'electron'; bin: string; args: string[] };

export class Trajectory {
  steps: Step[] = [];

  add(step: Step): void {
    this.steps.push(step);
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }

  hasAssertion(): boolean {
    return this.steps.some((s) => s.kind.startsWith('assert'));
  }

  /** 是否有除 goto 之外的实际操作/断言。 */
  hasMeaningfulStep(): boolean {
    return this.steps.some((s) => s.kind !== 'goto');
  }
}
