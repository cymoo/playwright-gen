# v0 — 盲写基线（重构前实现，原样保留）

`快照 JSON → LLM 盲写代码 → pytest 裁判 → 失败回灌重试`。只看一次静态文本就写代码，看不到交互后的页面。保留作回归对照。

```bash
uv run python -m v0 --url <URL> --description "<描述>"
```

详见根目录 `README.md`。
