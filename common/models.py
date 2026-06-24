"""模型接入（所有版本共用）。

- deepseek：主模型，负责推理 / 工具调用 / codegen（纯文本）。
- qwen：多模态模型，仅用于"看截图"，返回文本描述（deepseek 不具备视觉）。

两者均为 OpenAI 兼容接口。deepseek 沿用 `MODEL`/`OPENAI_BASE_URL`/`OPENAI_API_KEY`
（lovia 会自动解析形如 `openai:deepseek-v4-flash` 的标识）；qwen 用独立的
`QWEN_MODEL`/`QWEN_BASE_URL`/`QWEN_API_KEY`。
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from lovia import OpenAIChatProvider

load_dotenv()


def deepseek_model() -> str:
    """deepseek 模型标识（交给 lovia 用 OPENAI_BASE_URL/OPENAI_API_KEY 解析）。"""
    return os.environ["MODEL"]


def qwen_provider() -> OpenAIChatProvider:
    """构造 qwen 视觉 provider（独立 base_url / api_key）。"""
    return OpenAIChatProvider(
        model=os.environ["QWEN_MODEL"],
        base_url=os.environ["QWEN_BASE_URL"],
        api_key=os.environ["QWEN_API_KEY"],
    )


def max_retries(default: int = 5) -> int:
    return int(os.getenv("MAX_RETRIES", str(default)))
