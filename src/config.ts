import { readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paramText, type Params, type Rule } from './runtime';

const schema = z.object({
  params: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.string().min(1)).default({}),
  rules: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.object({
    scope: z.string().min(1).refine(v => !v.includes('${'), 'scope 不支持参数，请使用稳定范围'), role: z.string().optional(), text: z.string().min(1),
    match: z.enum(['exact', 'numberSuffix']).default('exact'),
    pick: z.union([z.enum(['unique', 'first']), z.number().int().min(0)]).default('unique'),
    minCount: z.number().int().min(1).optional(),
  }).strict()).default({}),
}).strict();
export interface ReuseConfig { params: Params; rules: Record<string, Rule> }
export function loadConfig(path?: string): ReuseConfig {
  return schema.parse(path ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
export function validateDescription(description: string, config: ReuseConfig): void {
  if ((Object.keys(config.params).length || Object.keys(config.rules).length) &&
      /遍历|循环|重复.{0,12}(?:次|遍)|如果|若|当[^。\n]{1,80}时/.test(description)) {
    throw new Error('复用描述暂不支持自动循环或条件分支：目录遍历请用 replay；前 N 项请拆成 N 个步骤；条件场景请拆成独立用例');
  }
  paramText(description, config.params);
  for (const match of description.matchAll(/(?<![\w.+-])@([A-Za-z_]\w*)/g)) {
    const rule = config.rules[match[1]];
    if (!rule) throw new Error(`未定义定位规则 @${match[1]}，请在配置 rules 中声明`);
    paramText(rule.text, config.params);
  }
}
export function writeRuntime(dir: string): void {
  copyFileSync(new URL('./runtime.ts', import.meta.url), join(dir, 'pwgen-runtime.ts'));
}

/** Prevent an agent from silently replacing explicit reusable references with sample values. */
export function referenceError(description: string, steps: import('./trajectory').Step[], config: ReuseConfig): string | undefined {
  const serialized = JSON.stringify(steps.filter(s => s.kind !== 'stepStart'));
  for (const match of description.matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
    if (!serialized.includes(match[0])) return `必须保留参数引用 ${match[0]}，不能写死样例值`;
  }
  for (const match of description.matchAll(/(?<![\w.+-])@([A-Za-z_]\w*)/g)) {
    const expected = JSON.stringify(config.rules[match[1]]);
    if (!steps.some(s => 'target' in s && s.target?.kind === 'rule' && JSON.stringify(s.target.rule) === expected)) {
      return `必须通过 @${match[1]} 执行并记录操作或断言，不能替换成 ref 或固定编号`;
    }
  }
  return undefined;
}
