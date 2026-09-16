# 可复用用例：参数、动态编号与目录批量回放

## 适用范围

从 0.2.0 起，生成器支持显式 `${参数名}`、显式 `@规则名` 和独立 `replay` 命令。用户描述**一个文件的一次完整流程**；目录遍历由运行器负责，不需要模型重复探索每个文件。

生成时仍需要模型凭据及一个有效样例。回放不调用模型。旧的固定步骤用例不必转换，但旧脚本不会因为提供新配置就自动参数化，首次迁移需要重新生成或人工修改。

第一版不实现通用循环、条件分支、跨帧资源对应、任意脚本表达式或自动推断哪些数字会变化。不能只写“让编号自动适配”：需要说明选择规则。启用非空参数/规则配置后，常见“遍历／循环／重复若干次／如果／若／当…时”描述会在启动前被拒绝并提示改写。这是有限的文案检查，并非完整自然语言解析；未被拒绝也不代表支持隐含循环或分支。

## 1. 配置格式

生成和回放使用 `--config reuse.json`。JSON 仅允许 `params`、`rules` 两个顶层字段。参数是非空字符串，名字由字母或下划线开头，仅含字母、数字和下划线。

```json
{
  "params": {
    "deviceSn": "YOUR_DEVICE_SN",
    "packageName": "com.example.game",
    "inputFile": "D:\\captures\\sample.pb",
    "inputName": "sample.pb"
  },
  "rules": {
    "device": {
      "scope": "[data-testid='record-panel']",
      "role": "combobox",
      "text": "Target device",
      "match": "exact",
      "pick": "unique"
    },
    "swapchain": {
      "scope": "[data-testid='resource-list']",
      "text": "Swapchain",
      "match": "numberSuffix",
      "pick": "first"
    },
    "counterProcess": {
      "scope": "[data-testid='process-tracks']",
      "text": "./counters_gather",
      "match": "numberSuffix",
      "pick": "unique"
    },
    "currentFile": {
      "scope": "[data-testid='current-file']",
      "text": "${inputName}",
      "match": "exact",
      "pick": "unique"
    }
  }
}
```

**以上 data-testid 是示意，不是 Graphics Profiler 已验证存在的属性。** 需要通过实际页面检查获得范围选择器；可以使用真实的稳定 CSS 选择器。不提供自动猜测页面结构的功能。

规则字段：

| 字段 | 说明 |
|---|---|
| `scope` | CSS 范围，必须唯一匹配一个容器；不要填某次生成的 data-pwref。不支持参数插值 |
| `role` | 可选，填写真实 ARIA role；没有 role 时在容器内按文本查找 |
| `text` | 精确名称或数字后缀之前的名称，可以包含参数 |
| `match` | `exact`（默认）或 `numberSuffix` |
| `pick` | `unique`（默认）、`first` 或从 0 开始的整数序号 |
| `minCount` | first/序号模式要求至少有多少个匹配项 |

`numberSuffix` 只匹配“完整名称 + 空白 + 数字”，例如 `Buffer 13`、`./counters_gather 50955`。不会匹配 `Buffer 13 details`。它不是任意正则接口。`unique` 匹配多个时失败；只有描述明确允许任选时才使用 `first`。

规则在生成时写入轨迹和脚本，**回放配置中的 rules 不会覆盖脚本里的规则**。修改定位规则后需要重新生成或编辑脚本；修改 params 后不需要重新生成。

## 2. SN 和包名

推荐描述：

```text
步骤1：点击 Record new trace。通过 @device 下拉框选择 ${deviceSn}，预期 Application to profile 出现。
步骤2：展开应用列表，搜索 ${packageName}，点击名称精确匹配 ${packageName} 的应用，验证所选应用名称包含 ${packageName}。
```

`${...}` 在工具操作和生成代码里保留为运行时引用，不能让模型改写成样例值。对于作用范围不明确的应用名称，增加一个 `text: "${packageName}"` 的规则并用 `@规则名` 定位。

设备控件本身也必须稳定：不要把“Target device + 所有连接设备 SN”整段标签作为定位器。优先修正应用的 accessible name / testId，或在唯一范围内使用稳定名称。

入口 URL 和应用可执行文件路径仍通过 CLI 直接提供，不支持占位符。

支持参数的操作包括：文本目标、fill、select_option、按键、文本/URL/标题断言、文件写入内容和路径、保存文件名。URL/标题断言的 pattern 保持正则语义，参数值不是自动转义的正则字面量；验证包名优先用精确文本规则。

命令示例：`hdc -t ${deviceSn} shell ...`。命令和 stdin 中的参数仅允许字母、数字、下划线、点、冒号和连字符；拒绝空格、引号、shell 元字符。该功能适合 SN/包名，**不是任意路径或 shell 片段的插值接口**。包含空格的路径应通过 UI 输入处理。

保存路径仍限制在生成用例目录内，参数替换后也会检查。回放配置要自行保管；参数值在探索提示、日志及测试标题中可能可见，不应用于秘密凭据。

## 3. 动态资源与进程

把“点击 Swapchain 352”改为：

```text
步骤1：打开指定 RDC，等待该文件的 Frame view 数据加载完成。
步骤2：进入 Resource Inspector，搜索 Swapchain，等待资源列表加载完成，点击 @swapchain。
步骤3：等待当前资源详情加载完成，验证 Initialization Parameters 内出现 MlnCreateSwapchain。
```

把“点击 ./counters_gather 50955”改为：

```text
步骤1：等待本次 trace 完成加载，通过 @counterProcess 展开 counters_gather 进程，要求唯一匹配。
步骤2：验证该进程下出现 EU Active 和 GPU Active 指标。
```

进程规则应指向**当前 trace 的轨道**，不用设备此刻的 PID 替代历史 trace 的 PID。指标检查也应限制在对应进程区域；仅验证全页面文字出现可能检查到另一个进程。

### 检查前 5 个 Buffer

第一版采用五个显式步骤，不自动生成资源循环。配置 `buffer1` 至 `buffer5`，每项使用相同 scope/text/match，`pick` 分别为 0–4，`minCount` 均为 5。每一步都写完整的点击、等待、断言，不写“重复上一步”。

```text
步骤1：搜索 Buffer，等待列表加载完成，点击 @buffer1，等待当前资源详情完成，验证指定初始化字段。
步骤2：点击 @buffer2，等待当前资源详情完成，验证指定初始化字段。
步骤3：点击 @buffer3，等待当前资源详情完成，验证指定初始化字段。
步骤4：点击 @buffer4，等待当前资源详情完成，验证指定初始化字段。
步骤5：点击 @buffer5，等待当前资源详情完成，验证指定初始化字段。
```

**前提：顺序在这五步期间不变，所有目标都存在于 DOM。** 每一步重新按当前顺序定位，并不固定首次选中的五个资源身份。若点击引起重排，先选择稳定排序；若虚拟列表只渲染少量行，改写为能通过搜索唯一选中的场景，或后续增加应用适配器。不要把此能力描述成通用集合遍历。

### 有历史 / 无历史

拆成两个用例，分别使用具备历史和不具备历史的样例文件。先验证当前资源已加载，再验证历史条目或 `No history for the resource`，最后执行该场景动作。第一版不支持运行时 if/else。

## 4. 单文件生成，目录回放

单文件描述使用 `${inputFile}`（完整路径）或 `${inputName}`（文件名）。如果应用有文件路径输入框，使用完整路径；如果仅能点击 Files 列表，需要保证指定目录的文件已导入且文件名唯一。

```text
步骤1：打开 Files，搜索 ${inputName}，点击精确名称为 ${inputName} 的文件。
步骤2：等待当前文件加载完成，验证 @currentFile，并验证 Timeline 中本文件的有效数据出现。
```

`replay` 不负责导入文件、不自动操纵原生“打开文件”对话框，也不清理应用磁盘缓存。若应用只暴露原生打开对话框，需要先提供可自动操作的导入入口，或单独实现并验证适配器。不要直接用整个目录跑一个尚未验证的导入流程。

生成示例（POSIX shell，单引号保护占位符不被 shell 展开；Windows PowerShell 同样使用单引号，cmd 用双引号）：

```bash
npx tsx src/cli.ts --electron-bin '/path/to/GraphicsProfiler' \
  --config reuse.json --name pb-open \
  --description '步骤1：打开 Files，搜索 ${inputName}，点击精确名称为 ${inputName} 的文件。步骤2：等待当前文件加载完成，验证 @currentFile，预期 Timeline 显示本文件数据。'
```

修改配置 params 后单次回放：

```bash
npx tsx src/cli.ts replay --spec output/pb-open/test_generated.spec.ts \
  --config reuse.json --report output/single-results.json
```

批量回放（不会调用模型）：

```bash
npx tsx src/cli.ts replay --spec output/pb-open/test_generated.spec.ts \
  --config reuse.json --input-dir /data/captures --ext pb \
  --recursive --timeout 960 --report output/pb-results.json
```

RDC 使用对应的单文件 RDC 用例，并把 `--ext` 改为 `rdc`。PB/RDC 不共用未经验证的同一套页面流程。

批量规则：

- 每次启动重新扫描，扩展名不区分大小写，按路径排序；默认不递归，不跟随符号链接。
- 启动时固定清单；运行期间新增文件留到下次。清单不锁定文件内容，请在文件复制/采集完成后运行，运行期间不要替换文件。
- 空目录失败。批量用例必须在实际操作或断言中使用 inputFile/inputName（仅标题中提及不算）；旧脚本缺少生成器参数元数据时会拒绝批量运行。仅使用 inputName 且目录中存在同名文件时失败。每项覆盖配置中的 `inputFile`、`inputName`，其他参数不变。
- 每个文件启动独立 Playwright 进程，串行执行。生成的 Electron 用例每次启动/关闭应用；不意味着应用持久化状态已清空，也不能保证单实例应用会创建独立实例。
- 某项失败继续执行下一项，报告保留逐项输出；任一失败，命令退出码为 1。JSON 在每项结束后更新，包含完整计划清单和已完成结果；异常中断后可据此识别未执行项。
- `--timeout` 是每文件外层超时，不能替代脚本自身的 `test.setTimeout`。当前生成脚本预算上限仍为 15 分钟；更长单文件流程需要另行调整。
- 多文件产物可能使用同名路径，导出时请显式加入 `${inputName}` 避免覆盖。

生成目录中的 `pwgen-runtime.ts` 是随用例分发的运行时。复制用例时一起复制该文件，并确保目标环境安装 `@playwright/test`。它不依赖生成器或模型 SDK。使用标准 Playwright 直接运行时，通过 `PWGEN_PARAMS` JSON 环境变量传参；推荐 replay 命令避免跨平台转义问题。

## 5. 等待和断言如何写

`Timeline`、`Bottlenecks`、`Initialization Parameters` 可能在上一次操作后一直可见，不能仅靠这些标题判断加载完成。描述应明确：

1. 当前文件或资源身份与本次选择一致。
2. 当前对象的加载完成信号成立（由实际应用提供）。
3. 需要的字段或有效采样值满足要求。

本版本提供定位和参数机制，不会自动发现业务上的“加载完成”。没有可靠信号时需要改善应用可测试性；不要用固定 sleep 替代。

参数缺失、规则未定义、唯一规则匹配多项、候选数量不足都应报错。显式引用被模型替换成固定值会阻止完成；有预期的步骤缺少断言也不会因重试次数耗尽而放行。这些检查不是完整的自然语言语义证明：仍需检查每一步是否验证了正确业务对象。

## 6. 验收清单与已知边界

- 同一生成脚本更换 SN/包名，确认操作和断言均使用新值。
- PID/资源编号变化仍能定位；同名多项应按声明规则处理。
- 增删文件后不重新生成即可回放；同路径覆盖需确认应用没有复用旧缓存。
- 列表不足 5 项、空目录、损坏文件、加载失败均不能显示通过。
- 检查有效数据，而不只是标题文字。

仓库测试覆盖参数解析、命令插值拒绝、规则引用校验、动态编号、范围与数量约束、目录变化、失败汇总及生成用例真实浏览器回放。Graphics Profiler 的 Windows Electron 页面、虚拟列表、导入入口、缓存和设备连接需要在真实应用上验证，不能用浏览器夹具测试代替。
