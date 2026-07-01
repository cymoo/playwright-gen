/**
 * v1 单次生成 Agent：据静态快照一次性写出用例（结构化输出 GeneratedTest）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateObject } from 'ai';
import { z } from 'zod';

import { deepseekModel } from '../common/models';

export const GeneratedTest = z.object({
  code: z.string().describe('完整的 TypeScript @playwright/test 用例，纯代码，不含 markdown fence'),
  notes: z.string().describe('selector 选择策略与已知限制'),
});
export type GeneratedTest = z.infer<typeof GeneratedTest>;

const PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'generate.md'),
  'utf-8',
);

export async function generateTest(userPrompt: string): Promise<GeneratedTest> {
  const { object } = await generateObject({
    model: deepseekModel(),
    schema: GeneratedTest,
    system: PROMPT,
    prompt: userPrompt,
  });
  return object;
}
