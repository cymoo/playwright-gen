/**
 * 清洗 + 轻校验生成的用例代码。
 *
 * 主要用于 v1 的 LLM 直写代码；v2/v3 的 codegen 是确定性渲染，天然合法。
 * 只做：去 markdown fence + 基本标记检查（有 @playwright/test 导入、有 test(...)、
 * 且有 page.goto( 或 electron.launch( ）。真正的语法/运行校验交给随后的
 * `playwright test` 执行（失败会回灌 repair 循环），不引入运行期 TS 解析依赖。
 */

export function sanitizeCode(raw: string): string {
  let code = (raw ?? '').trim();
  code = code.replace(/^```(?:[a-zA-Z]+)?\n?/, '');
  code = code.replace(/\n?```$/, '');
  code = code.trim();

  if (!/from\s+['"]@playwright\/test['"]/.test(code)) {
    throw new Error('生成的代码缺少 @playwright/test 导入');
  }
  if (!/\btest\s*\(/.test(code)) {
    throw new Error('生成的代码没有 test(...) 用例');
  }
  if (!/\.goto\s*\(/.test(code) && !/electron\.launch\s*\(/.test(code)) {
    throw new Error('生成的代码既没有 page.goto() 也没有 electron.launch()');
  }
  return code;
}
