from __future__ import annotations

from pathlib import Path

from lovia import Agent
from pydantic import BaseModel

from common.models import deepseek_model


class GeneratedTest(BaseModel):
    code: str
    notes: str


def make_agent() -> Agent:
    prompt = (Path(__file__).parent / "prompts/generate.md").read_text(encoding="utf-8")
    return Agent(
        name="test-generator-v1",
        instructions=prompt,
        model=deepseek_model(),
        output_type=GeneratedTest,
    )
