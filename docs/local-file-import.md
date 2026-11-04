# 打开指定本地文件（0.3.1）

原先只有 `click_and_save`，模型可能将 Import file 当成保存文件，等待并不存在的下载事件。原生“打开”窗口不在 DOM 中，普通 click 后也无法通过页面快照填写文件名。现在提供独立的 `click_and_open`，在点击前准备好文件选择，再由应用自行读取文件。

## Graphics Profiler 示例

`reuse.json`：

```json
{
  "params": {
    "rdcPath": "D:\\test-data\\traces",
    "rdcName": "sample.rdc"
  }
}
```

Windows CMD（占位符原样传给 agent）：

```bat
npx tsx src/cli.ts --electron-bin "C:\Program Files\Graphics Profiler\Graphics Profiler.exe" --config reuse.json --description "步骤1：点击Open file，点击图标按钮Import file，选择${rdcPath}目录下的${rdcName}文件打开，预期可以跳转到Explorer页面。步骤2：点击Resources窗口，预期展示Buffer、Memory、Texture、Shader、Swapchain等资源信息。"
```

无需改动已有描述。Agent 应先 `click("Open file")`，再 `click_and_open(target="Import file", file_path="${rdcPath}/${rdcName}")`，最后等待并断言 Explorer。斜杠拼接在 Windows 路径解析中可用，盘符、反斜杠、空格和中文都按路径处理，不经过 shell。PowerShell / POSIX shell 中请用单引号包住含 `${...}` 的描述，避免 shell 提前替换参数。

生成轨迹保留参数模板，回放时重新解析、检查源文件并重演同一导入动作；更换 `rdcPath` / `rdcName` 即可选择其他文件。批量扫描用例建议描述使用 `${inputFile}` 完整路径，由 `replay --input-dir` 为每个文件注入该参数；目录扫描不会自行补充导入步骤。

## 执行与验证

- 文件路径为绝对路径或相对 run 目录的路径；生成用例按 spec 所在目录解析相对路径，执行与回放一致。文件缺失或为目录时，在点击前报错，不记录成功轨迹。
- Electron 在主进程临时替换 `dialog.showOpenDialog` 和 `showOpenDialogSync`，分别返回 `{ canceled: false, filePaths: [完整路径] }` 和 `[完整路径]`。首次调用即恢复原方法，失败或超时也清理替换，后续文件选择不会沿用上一个文件。
- 同时监听网页 `filechooser`，使用 `setFiles`，因此 Electron renderer 的文件输入框也可使用。
- 必须实际捕获文件选择才算工具成功；文件已存在、点击了按钮均不足以成功。选择成功仅是操作，步骤要求跳转、加载或资源列表时仍必须单独断言。
- `timeout_seconds` 默认 60，上限 600；选择器等待计入回放总超时。导入耗时用独立的 `wait_for("Explorer", timeout_seconds=120)` 等待。
- 探索和生成用例使用同一个执行函数源码，按需注入；不会记录临时 ref、文件样例值或临时系统窗口探测脚本。

## 支持边界

支持通过 Electron `dialog.showOpenDialog(Sync)` 或 HTML 文件输入框选择单个文件。应用自行调用原生扩展、外部进程的系统选择器、启动时缓存了 dialog 函数引用、文件夹选择或多文件选择不在本次支持范围，需在真实应用中确认其入口实现。工具失败时查看 `exploration_roundN.jsonl`，不要退回 `click_and_save`；已经弹出的原生窗口需要关闭并从新会话重探。

仓库提供真实 Chromium 文件选择与换参回放，以及可选的真实 Electron IPC 夹具测试（异步、同步、恢复和生成回放）：

```sh
npm run typecheck
PWGEN_TEST_ELECTRON_BIN=/path/to/electron npx playwright test tests/file-open.spec.ts --workers=1
```

没有 `PWGEN_TEST_ELECTRON_BIN` 时仅跳过原生 Electron 集成测试。此变量应指向未打包的 Electron runtime，而不是 Graphics Profiler。夹具测试不等同于 Windows Graphics Profiler 现场验收；现场需确认 Explorer 与 Resources 页面内容、真实 RDC 兼容性及设备连接。

## 对抗性审查

- 检查“源文件存在就算导入成功”的假阳性：无选择器按钮会超时且不记录；导入操作不能满足步骤的预期断言门。
- 检查跨次导入污染：真实 Electron 连续选择不同文件，验证异步、同步、超时、点击失败与 renderer filechooser 路径均恢复原对话框方法。
- 检查参数固化与源文件安全：拒绝样例值，生成脚本换目录/文件名后读到新文件；源文件位于 run 目录外也保持内容不变。
- 检查生成函数的外部依赖：浏览器和 Electron 均运行独立生成 spec，验证注入的函数无需仓库源码或转译器私有 helper。

API 依据：[Electron dialog](https://www.electronjs.org/docs/latest/api/dialog)、[Playwright FileChooser](https://playwright.dev/docs/api/class-filechooser)、[ElectronApplication.evaluateHandle](https://playwright.dev/docs/api/class-electronapplication#electron-application-evaluate-handle)。
