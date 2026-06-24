import os
from pathlib import Path

from pydantic import BaseModel
from lovia import Agent


class GeneratedTest(BaseModel):
    code: str
    notes: str


def make_agent() -> Agent:
    prompt = (Path(__file__).parent / "prompts/generate.md").read_text()
    return Agent(
        name="test-generator",
        instructions=prompt,
        model=os.environ["MODEL"],
        output_type=GeneratedTest,
    )
