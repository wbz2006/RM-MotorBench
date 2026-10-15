# VS Code 烧录配置 Implementation Plan

**Goal:** 在 VS Code 中选择 A/C 板和 CMSIS-DAP/J-Link 后自动编译并烧录。

**Architecture:** 使用现有 Makefile 和 OpenOCD 配置，通过 VS Code process 任务传入独立参数与工作目录。烧录任务依赖相应板的编译任务。

**Tech Stack:** VS Code tasks 2.0.0、GNU Make、ARM GNU Toolchain、OpenOCD。

## Constraints

- 只修改编辑器配置及相关文档，不改变固件。
- 使用本机已核实的工具路径，工作区目录使用相对路径。
- 配置阶段不执行实板写入，验证编译与 OpenOCD 脚本加载即可。
- 工程没有 Git 元数据，不执行提交。

## Task 1: 配置并验证编译/烧录

- [x] 核实两板 Makefile 的目标名称、本机 Make/GCC/OpenOCD 及 OpenOCD 脚本位置。
- [x] 创建外层 `RM-MotorBench.code-workspace`，目录为 `RM-MotorBench-main`。
- [x] 创建项目 `.vscode/tasks.json`，添加两种板型的编译及两种下载器的烧录任务，烧录命令使用 `verify reset exit`。
- [x] 更新 `.gitignore` 和 README，使任务配置可保存并说明使用方法。
- [x] 检查任务 JSON、路径和依赖；按配置运行两板编译，并加载四套 OpenOCD 配置后 shutdown。
- [x] 只读复核配置，解决影响使用的问题并交付工作区入口。
