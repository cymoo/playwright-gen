/**
 * 模型接入。
 *
 * - deepseek:主模型,负责推理 / 工具调用(纯文本)。用 deepseek-chat 系
 *   (reasoner 不支持 function calling)。
 * - qwen:多模态模型,仅用于"看截图",返回文本描述(deepseek 不具备视觉)。
 *
 * 两者均为 OpenAI 兼容接口,经 AI SDK 的 createOpenAICompatible 接入。
 */

import 'dotenv/config';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`缺少环境变量 ${key}(见 .env.example)`);
  return v;
}

let _deepseek: LanguageModel | undefined;
export function deepseekModel(): LanguageModel {
  if (!_deepseek) {
    const provider = createOpenAICompatible({
      name: 'deepseek',
      baseURL: required('DEEPSEEK_BASE_URL'),
      apiKey: required('DEEPSEEK_API_KEY'),
    });
    _deepseek = provider(required('DEEPSEEK_MODEL'));
  }
  return _deepseek;
}

let _qwen: LanguageModel | undefined;
export function qwenModel(): LanguageModel {
  if (!_qwen) {
    const provider = createOpenAICompatible({
      name: 'qwen',
      baseURL: required('QWEN_BASE_URL'),
      apiKey: required('QWEN_API_KEY'),
    });
    _qwen = provider(required('QWEN_MODEL'));
  }
  return _qwen;
}

/** 每个步骤的最大探索轮数(LLM 回合数),env MAX_STEPS 可覆盖。 */
export function envMaxSteps(dflt = 30): number {
  return parseInt(process.env.MAX_STEPS ?? '', 10) || dflt;
}
