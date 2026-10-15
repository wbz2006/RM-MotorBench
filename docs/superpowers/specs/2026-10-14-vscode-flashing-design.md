# VS Code 烧录配置

用户要求把现有 A/C 板固件的烧录配置到 VS Code。沿用工程 Makefile 和 OpenOCD 配置，不改变固件。

## 方案与范围

采用 VS Code 内置 process 任务：A/C 板各有编译任务和 CMSIS-DAP、J-Link 烧录任务。烧录依赖相应编译任务，编译成功后执行 `program build/<target>.elf verify reset exit`。不设置默认烧录板型，用户从名称中明确选择。

也可使用 Cortex-Debug 的 F5 配置，但用户当前只要求烧录，内置任务无需扩展；J-Flash GUI 继续保留原用法。

## 文件与工具

- 项目 `.vscode/tasks.json`：六个任务，独立设置各板工作目录，编译使用本机 ARM GCC 与 Make，烧录使用本机 OpenOCD 并显式指定脚本路径。
- 外层 `RM-MotorBench.code-workspace`：相对路径打开真实项目目录，避免外层同名目录导致任务不可见。
- README：说明打开工作区、选择板型/下载器、成功日志及工具迁移。
- `.gitignore`：仅允许项目根的任务配置纳入版本控制，其他现有编辑器配置仍忽略。

## 验收

检查 JSON 格式、任务依赖、工作目录、工具和脚本存在。执行两个编译任务的实际命令；四个烧录配置仅执行 OpenOCD 配置加载和 shutdown，验证脚本能解析。实板写入由用户在 VS Code 选择任务时执行。
