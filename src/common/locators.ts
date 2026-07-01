/**
 * 定位描述符的推导与渲染（纯函数，可单测）。
 *
 * - `descriptorFor`：据快照阶段扫描出的元素元数据，推导**唯一的语义定位描述符**
 *   （旧 Python 里的 expr_for，改为返回结构化描述符）。
 * - `renderLocator`：把描述符渲染为 Playwright locator 表达式（供 codegen 用）。
 *
 * 二者与 browser 里的 `buildLocator`（据同一描述符构造实时 Locator）配套，
 * 共同保证"执行的定位 === 记录的定位"。
 */

import type { LocatorDescriptor } from './trajectory';

/** 快照阶段一段 JS 扫描出来的单个可交互元素的元数据。 */
export interface SnapshotItem {
  role: string;
  name: string;
  placeholder: string;
  testid: string;
  tag: string;
  type: string;
  sameKeyIndex: number; // 同 (role+name) 的第几个（0 基）
  sameKeyCount: number; // 同 (role+name) 的总数
  roleIndex: number; // 同 role 的第几个（0 基）
  roleCount: number; // 同 role 的总数
}

/**
 * 据元素元数据推导**有序候选**语义定位描述符列表。
 * resolve() 会逐个用 Playwright 自己的枚举校验，取第一个能唯一命中该元素的候选
 * （必要时修复 nth）——因此这里给的是"优先尝试顺序"，正确性由校验保证。
 *
 * 顺序：role+name > getByLabel（表单控件，兜住 password 等无 textbox role 的情况）
 *      > placeholder > testid > role+全局序号。
 */
export function candidateDescriptors(item: SnapshotItem): LocatorDescriptor[] {
  const role = item.role || '';
  const name = item.name || '';
  const isFormControl = item.tag === 'input' || item.tag === 'textarea' || item.tag === 'select';
  const out: LocatorDescriptor[] = [];
  if (name) out.push({ kind: 'role', role, name });
  if (isFormControl && name) out.push({ kind: 'label', text: name });
  if (item.placeholder) out.push({ kind: 'placeholder', text: item.placeholder });
  if (item.testid) out.push({ kind: 'testId', testId: item.testid });
  out.push({ kind: 'role', role, nth: item.roleIndex });
  return out;
}

/** JS 单引号字符串字面量转义。 */
export function jsLit(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

/**
 * 把定位描述符渲染成 Playwright locator 表达式（默认基于 `page`）。
 * electron 形态下窗口对象也绑定为 `page`，故同一表达式两处通用。
 */
export function renderLocator(d: LocatorDescriptor, base = 'page'): string {
  let expr: string;
  switch (d.kind) {
    case 'role': {
      const opts: string[] = [];
      if (d.name) opts.push(`name: ${jsLit(d.name)}`);
      if (d.exact) opts.push('exact: true');
      const optStr = opts.length ? `, { ${opts.join(', ')} }` : '';
      expr = `${base}.getByRole(${jsLit(d.role)}${optStr})`;
      break;
    }
    case 'label': {
      const optStr = d.exact ? ', { exact: true }' : '';
      expr = `${base}.getByLabel(${jsLit(d.text)}${optStr})`;
      break;
    }
    case 'placeholder':
      expr = `${base}.getByPlaceholder(${jsLit(d.text)})`;
      break;
    case 'testId':
      expr = `${base}.getByTestId(${jsLit(d.testId)})`;
      break;
    case 'text': {
      const optStr = d.exact ? ', { exact: true }' : '';
      expr = `${base}.getByText(${jsLit(d.text)}${optStr})`;
      break;
    }
    default: {
      const _never: never = d;
      throw new Error(`unknown locator kind: ${JSON.stringify(_never)}`);
    }
  }
  if (d.nth !== undefined) {
    expr += `.nth(${d.nth})`;
  }
  return expr;
}
