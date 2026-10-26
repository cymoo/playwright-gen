# 回放诊断、准备步骤与补充控件（0.3.0）

## 先定位回放失败

```sh
npx tsx src/cli.ts replay --spec output/my-case/test_generated.spec.ts --config reuse.json
```

终端实时显示 Playwright 步骤和错误。每次运行在 spec 旁创建独立的 `.pwgen-replays/run-*/`，其中有 `replay.log`（完整输出）、`report.json`（Playwright 结构化报告）和 `test-results/`（附件）。`--report` 汇总还会保存这些绝对路径、错误摘要、退出码、是否外层超时；默认汇总文件会被下一次覆盖，但每次诊断目录不会覆盖。批量输入逐文件获得不同的诊断目录。

默认 `--trace retain-on-failure`：第一次失败就保留 trace，不需要重试。可用 `--trace on` 保留通过运行的 trace，或 `--trace off` 关闭。打开日志提示的实际 trace 路径：

```sh
npx playwright show-trace output/my-case/.pwgen-replays/run-ABC/test-results/CASE/trace.zip
```

新生成的用例会在发生错误、关闭应用之前尽力附加 `failure-screenshot` 和 `failure-state`，并保存 `initial-state`，便于比较起始状态。即使截图失败，也继续尝试页面状态与暂停，诊断采集错误不会替换原始测试错误。探索保存 `initial_state_roundN.txt`；Electron 探索的 `--trace` 也已接入。

诊断可能包含页面内容和测试参数，按测试数据管理。强制杀进程、应用崩溃或窗口已经关闭时，截图/trace 可能来不及落盘；完整日志和退出信息仍保留。

## 单步和失败后暂停

```sh
npx tsx src/cli.ts replay --spec output/my-case/test_generated.spec.ts --config reuse.json --debug
npx tsx src/cli.ts replay --spec output/my-case/test_generated.spec.ts --config reuse.json --pause-on-failure
```

`--debug` 使用 Inspector；`--pause-on-failure` 正常执行到错误后再暂停。参数仍由 `--config` 注入，不需要手写 `PWGEN_PARAMS`。这两种交互模式取消运行器的外层超时，新用例也取消显式的测试总超时，有限的断言等待仍保留。检查完在 Inspector 点 Resume，原来的失败仍会使本次运行退出码为 1；普通运行继续自动关闭 Electron。

交互调试只接受单次回放。批量场景先在配置里填写单个 `inputFile`/`inputName` 并去掉 `--input-dir`。旧脚本可用 `--debug`，但其中已有的 `test.setTimeout(...)` 可能仍生效，可临时改为 0；`--pause-on-failure` 要求重新生成的用例（头部有 `// pwgen-debug: 1`），不会在旧脚本上假装暂停。

## 探索通过不等于初始状态独立

以下顺序依赖“上次已经选中目标应用”，在初始值为 System 时必然失败：

```text
打开 Application to profile → 断言已选包名 → 搜索并选择目标包名
```

正确流程是先打开选择器、搜索、点击目标，再验证已选区域；已有正确值时，也要录制能够建立它的操作。预检查通过 `get_page_state` 观察，不要录成必须在每次回放成立的结果断言。

需要固定准备流程时显式声明：

```sh
npx tsx src/cli.ts --electron-bin /path/to/application --config reuse.json \
  --setup-description '步骤1：打开 Record trace，选择 ${deviceSn} 连接设备。步骤2：打开 Application to profile，搜索并重新选择 ${vkPackageName}，验证已选区域显示 ${vkPackageName}。' \
  --description '步骤1：设置录制参数。步骤2：开始录制，等待 Timeline 并验证 Details。'
```

准备步骤每轮探索先执行，和主流程写入同一轨迹、同一 spec，在每次回放时先执行。它不是不录制的初始化 hook，也不会清理应用磁盘配置或自动重置设备。Windows CMD 使用双引号包围描述，PowerShell 建议用单引号保留 `${参数}`。

生成器会保留失败断言，并向下一轮探索提供原始错误和失败附近的源码；不会替用户删除、放宽或移动断言。旧脚本里已有的错误顺序需要明确修正或重新生成。由于自定义应用流程由模型探索，这些约束不能替代真实应用上的 clean-replay 验证。

## 给 agent 补充图标和无名输入框

快照新增 title、稳定 ID、输入值、min/max/step 和 disabled/readonly。数字框是 `spinbutton`，range 是 `slider`，search 是 `searchbox`，password 不伪造 textbox 角色。带 title/testId/ARIA 名称和可聚焦特征的非标准入口也会进入候选列表；这并不保证装饰元素有点击行为。

placeholder 单独标注和匹配，不冒充 accessible name，也不会让提示文本与有名称按钮产生伪歧义；fill/value 面向匹配的表单控件，press 仍可明确针对按钮。

无名输入框可显示：

```text
spinbutton "(无名)" [邻近字段: "Poll interval" (非 accessible name); 单位: us; value: "1000"]
```

邻近关联只在小范围、单一表单控件、单一非单位标签时尝试，并校验该定位实际命中 ref。重复字段会要求消除歧义，不将猜测写成真实 accessible name，也不静默固化字段的全局序号。复杂布局、多个控件同组、重复标签或动态 ID，应显式提供规则。

`rules` 保留旧的 scope/text/role/match/pick 格式，新增 locator 格式（不要在同一条规则混用两种格式）：

```json
{
  "params": { "pollUs": "100" },
  "rules": {
    "importTrace": {
      "locator": { "kind": "title", "value": "Import trace file" }
    },
    "gpuPollInterval": {
      "scope": "#record-settings",
      "locator": { "kind": "css", "value": "#gpu-poll-interval" }
    },
    "gpuNumber": {
      "scope": "#gpu-counters",
      "locator": { "kind": "role", "role": "spinbutton" }
    }
  }
}
```

上面的 ID 仅为示例，必须换成真实 DOM 中稳定、唯一的范围/控件 ID。scope 默认 body，pick 默认 unique。scope 是祖先范围，locator 在其后代中查找。支持 title/testId/css/role/label/placeholder/text；role 可以只指定角色，其他类型的 value 必填。文字型 locator 可使用 `${参数}`，CSS 和 scope 不支持插值，避免把任意参数拼进选择器。多匹配默认失败，用户明确指定 pick 时才按序号选择。

描述中明确引用规则：

```text
点击 @importTrace。
把 @gpuPollInterval 设为 ${pollUs}，按 Tab 提交，预期输入框的值为 ${pollUs}。
```

`assert_value` 工具使用 `toHaveValue`，可设置等待超时，并在探索和回放使用相同定位。数值和单位分开处理：100us 一般填 100，再按应用要求提交，最后验证 value；不能用 `toContainText` 检查输入值。导入按钮后的原生打开文件对话框仍需要应用适配，识别按钮不等于已支持原生文件选择。

能修改被测应用时，优先补 `<button aria-label="...">`、`data-testid` 或 `label[for]`/`aria-labelledby`，减少人工规则。本次交付使用配置补充控件，未引入可视化点选器或坐标回放。

## 对抗性审查与验证边界

- 不自动删断言、不扩大到全页面包名匹配；错误选择仍然失败。
- 不默认清除真实用户配置；准备步骤进入同一回放轨迹。
- 不把邻近标签当 accname；重复 title/字段不任意取第一项。
- 不把 fill 成功当最终值正确；失焦校正后的错误值仍然失败。
- 调试不丢参数、不被外层超时杀掉；暂停必须早于 close，恢复后仍失败。
- 每次诊断独立；结构化错误不会被终端摘要截断隐藏。
- 实现后审查修正：带 testId 的字段外层容器不得抢占 fill/press/value 的真实控件，按键仍保留命名按钮优先于同名输入提示的语义；重复 title 的标准按钮也禁止序号回退；CSS 插值在配置和可分发运行时双重拒绝；启动途中失败也清理会话。

浏览器测试覆盖字段插入与换参后的真实生成回放、重复控件、输入提交校正、诊断文件保留和调试生命周期。Electron 关闭/暂停顺序使用真实 Chromium 页面与测试 launcher 验证，仓库没有 Graphics Profiler 的 Windows 二进制，不能替代真实设备录制验收。
