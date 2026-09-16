/** Portable runtime copied beside generated specs; no dependency on the generator. */
import { expect, type Page, type Locator } from '@playwright/test';

export type Params = Record<string, string>;
export interface Rule {
  scope: string;
  role?: string;
  text: string;
  match: 'exact' | 'numberSuffix';
  pick: 'unique' | 'first' | number;
  minCount?: number;
}

export function readParams(): Params {
  const value: unknown = JSON.parse(process.env.PWGEN_PARAMS || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.values(value).some(v => typeof v !== 'string')) throw new Error('PWGEN_PARAMS 必须是字符串值的 JSON 对象');
  return value as Params;
}

export function paramText(text: string, params: Params): string {
  return text.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, key: string) => {
    if (!Object.hasOwn(params, key) || params[key] === '') throw new Error(`缺少参数: ${key}`);
    return params[key];
  });
}

export async function resolveRule(page: Page, rule: Rule, params: Params, timeout = 5000): Promise<Locator> {
  const scope = page.locator(rule.scope);
  await expect(scope, `定位范围必须唯一: ${rule.scope}`).toHaveCount(1, { timeout });
  const text = paramText(rule.text, params);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = rule.match === 'numberSuffix' ? new RegExp(`^${escaped}\\s+\\d+$`) : text;
  const matches = rule.role
    ? scope.getByRole(rule.role as Parameters<Page['getByRole']>[0], { name, exact: true })
    : scope.getByText(name, { exact: true });
  if (rule.pick === 'unique') {
    await expect(matches, `规则必须唯一匹配: ${text}`).toHaveCount(1, { timeout });
    return matches;
  }
  const index = rule.pick === 'first' ? 0 : rule.pick;
  await expect.poll(() => matches.count(), { message: `候选数量不足: ${text}`, timeout })
    .toBeGreaterThanOrEqual(Math.max(index + 1, rule.minCount ?? 1));
  return matches.nth(index);
}

/** Shell templates accept identifier tokens only, never arbitrary paths or shell fragments. */
export function paramCommand(text: string, params: Params): string {
  for (const match of text.matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
    const value = paramText(match[0], params);
    if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new Error(`命令参数 ${match[1]} 仅允许字母、数字、下划线、点、冒号和连字符`);
  }
  return paramText(text, params);
}
