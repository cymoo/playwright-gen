"""v3 规划器：把一句话需求拆成若干**自包含、各自聚焦**的测试场景。

每个场景会被生成为一个独立、可单独运行的测试，因此场景必须包含到达目标所需的全部
前置步骤（如登录）。这是 v3 相对 v2 增加的唯一一个新 Agent。
"""

from __future__ import annotations

from lovia import Agent, Runner
from pydantic import BaseModel

from common.models import deepseek_model


class Scenario(BaseModel):
    name: str          # 简短标识（英文/拼音，用于文件名与测试函数名）
    description: str   # 自包含的中文可执行指令（含登录等前置）


class Plan(BaseModel):
    scenarios: list[Scenario]


PLANNER_INSTRUCTIONS = """你是测试规划专家。把用户的一句话需求拆成若干**相互独立、各自聚焦**的测试场景。
要求：
- 每个场景必须**自包含**：从打开页面开始，包含到达目标所需的全部前置步骤（如登录）；
  因为每个场景会被生成为一个可单独运行的独立测试。
- 若需求只含一个关注点，就只返回一个场景；不要为了凑数而拆分。
- 若提供了登录凭据且页面需要登录，则每个场景的 description 都要以"先用用户名…、密码…登录"开头。
- name 用简短英文或拼音（仅字母数字下划线，用于文件名）；description 用中文、具体、可执行。
"""


def make_planner() -> Agent:
    return Agent(
        name="planner",
        instructions=PLANNER_INSTRUCTIONS,
        model=deepseek_model(),
        output_type=Plan,
    )


async def make_plan(description: str, url: str, initial_state: str, creds_hint: str) -> Plan:
    prompt = (
        f"需求：{description}\n"
        f"页面 URL：{url}\n"
        f"{creds_hint}\n"
        f"初始页面状态（供判断是否需要登录/有哪些入口）：\n{initial_state}\n\n"
        f"请把需求拆分为自包含的测试场景。"
    )
    result = await Runner.run(make_planner(), prompt)
    return result.output
