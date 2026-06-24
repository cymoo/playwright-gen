# v3 — 规划 + 套件（复杂应用）

在 v2 引擎上加一个 Planner：把一句话拆成多个自包含场景（含登录），逐个探索生成**独立可运行**的用例，汇总为套件。

```bash
uv run python -m v3 [--username U --password P] [--backend inhouse|mcp] [--vision] [--trace] \
    --url <URL> --description "<描述>"
```

适用：需登录、多视图、一句话含多个关注点。`--backend mcp` 用官方 Playwright MCP（需 `uv sync --extra mcp` + Node/npx）。详见根目录 `README.md`。
