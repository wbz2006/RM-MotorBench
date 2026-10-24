# 维护脚本

在仓库根目录运行；日常使用可直接双击根目录的 `启动电机测试台.bat`，或在 `motor_bench_host` 中运行 `npm start`。

| 脚本 | 用途 | 命令 |
| --- | --- | --- |
| `make-launcher.cjs` | 生成根目录 Windows 启动器，校验纯 ASCII 内容和 CRLF 换行 | `node tools/make-launcher.cjs` |
| `doc-screenshot.cjs` | 将架构 SVG 渲染为 PNG，或使用模拟电机连接生成网页说明配图 | `node tools/doc-screenshot.cjs` / `node tools/doc-screenshot.cjs --ui` |

配图脚本使用 `motor_bench_host/node_modules` 中的 Electron 和 ws；首次运行先在上位机目录执行 `npm ci`。图片输出到 `docs/images`，不会打开真实串口或发送电机命令。

固件构建、调试、DAPLink 烧录配置保留在对应 `motorbench-*` 工程中；软件测试脚本保留在 `motor_bench_host`，通过 `npm run` 执行。旧 Makefile 参考工程和已过时的根目录编辑器配置已移除，历史内容可通过 Git 查看。
