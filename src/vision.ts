/**
 * 视觉能力(可选,--vision)。
 *
 * deepseek 不具备视觉,因此"看截图"统一委托给 qwen,并把结果作为**文本**返回,
 * 回传给 deepseek 使用。
 */

import { readFileSync } from 'node:fs';
import { generateText, type ModelMessage } from 'ai';

import { qwenModel } from './models';

const VISION_INSTRUCTIONS =
  '你是界面视觉分析助手。根据截图,客观描述与问题相关的可见元素:' +
  '文字/图标含义、相对位置、状态(可见/禁用/选中等),以便据此编写或校验 UI 测试。' +
  '只描述你确实看到的,不要臆测不存在的元素。回答简洁、分条。';

export async function describeScreenshot(pngPath: string, question: string): Promise<string> {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'file', mediaType: 'image/png', data: readFileSync(pngPath) },
      ],
    },
  ];
  const { text } = await generateText({
    model: qwenModel(),
    system: VISION_INSTRUCTIONS,
    messages,
  });
  return text || '';
}
