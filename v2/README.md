# v2 — Agent 驱动探索（动态 / 交互页）

Agent 在真实浏览器里操作（ARIA+ref 快照 → 点击/输入/断言 → 看新状态）；引擎记录**真正命中的 locator**，确定性生成同步 pytest 用例并 clean-replay 校验/修复。

```bash
uv run python -m v2 [--vision] [--max-steps N] [--headed] [--trace] --url <URL> --description "<描述>"
```

适用：SPA、弹窗、hover、多步流程等"不操作就不知道结果"的页面。详见根目录 `README.md`。
