# v1 — 单次生成（简单 / 静态页）

富 ARIA 快照 → DeepSeek 单次生成 → 校验/重试；`--vision` 用 Qwen 看截图补充上下文。

```bash
uv run python -m v1 [--vision] [--headed] --url <URL> --description "<描述>"
```

适用：元素初始即在 DOM 的静态页。对"点击后才出现的内容"会诚实说明无法验证——这是该升级到 v2 的信号。详见根目录 `README.md`。
