"""playwright-gen 入口（默认 v0 基线，保留向后兼容）。

各版本按页面复杂度选择，均可独立运行：
    uv run python -m v0 --url <URL> --description "<描述>"   # 盲写基线
    uv run python -m v1 --url <URL> --description "<描述>"   # 单次生成（简单/静态页）
    uv run python -m v2 --url <URL> --description "<描述>"   # Agent 探索（动态/交互页）
    uv run python -m v3 --url <URL> --description "<描述>"   # 规划+套件（复杂应用）
"""

from v0.cli import main

if __name__ == "__main__":
    main()
