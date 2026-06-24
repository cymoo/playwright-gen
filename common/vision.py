"""视觉能力（所有版本共用）。

deepseek 不具备视觉，因此"看截图"统一委托给 qwen，并把结果作为**文本**返回。
- 同步版 `describe_screenshot`：供 v1 的单次流程使用。
- 异步版 `describe_screenshot_async`：供 v2/v3 在 async agent 循环里的工具使用
  （async 事件循环内不能调用 Runner.run_sync）。
"""

from __future__ import annotations

from pathlib import Path

from lovia import Agent, ImagePart, Runner, TextPart
from lovia.messages import user

from .models import qwen_provider

_VISION_INSTRUCTIONS = (
    "你是网页视觉分析助手。根据截图，客观描述与问题相关的可见元素："
    "文字/图标含义、相对位置、状态（可见 / 禁用 / 选中等），以便据此编写或校验 UI 测试。"
    "只描述你确实看到的，不要臆测不存在的元素。回答简洁、分条。"
)


def _vision_agent() -> Agent:
    return Agent(name="vision", instructions=_VISION_INSTRUCTIONS, model=qwen_provider())


def _vision_message(png_path: str | Path, question: str):
    return user([TextPart(text=question), ImagePart.from_path(str(png_path))])


def describe_screenshot(png_path: str | Path, question: str) -> str:
    """同步：用 qwen 看截图并返回文本描述。"""
    result = Runner.run_sync(_vision_agent(), [_vision_message(png_path, question)])
    return result.output or ""


async def describe_screenshot_async(png_path: str | Path, question: str) -> str:
    """异步：用 qwen 看截图并返回文本描述（供 async 工具调用）。"""
    result = await Runner.run(_vision_agent(), [_vision_message(png_path, question)])
    return result.output or ""
