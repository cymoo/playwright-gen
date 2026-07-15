# 基准页面集（按页面复杂度）

用于验证引擎在不同复杂度页面上的表现（同一个命令，无版本分档）。

| 文件 | 复杂度 | 建议用法 | 说明 |
|---|---|---|---|
| `01_static_form.html` | 简单/静态 | 一句话描述 | 所有可断言内容初始即在 DOM |
| `02_visual_icons.html` | 视觉相关 | 加 `--vision` | 图标按钮无可见文字，视觉模型更易判断含义 |
| `03_spa_modal.html` | 动态/交互 | 一句话描述 | 弹窗/提示点击后才创建，必须驱动浏览器 |
| `04_login_app.html` | 多步骤应用 | `步骤1：…步骤2：…` 多步骤描述 | 需登录(admin/secret)后才出现多视图，适合验证逐步骤驱动与 test.step 分块 |

以 `file://` 直接打开即可（纯 DOM 操作，无需起服务）。例如：

```
file:///Users/neo/playground/playwright-gen/examples/03_spa_modal.html
```
