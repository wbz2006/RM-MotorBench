# 网页 PID 记忆实现计划

**Goal:** 记住上次有效 PID 编辑,刷新和绑定后恢复,不自动下发。

**Architecture:** 在现有 ui.js 的 PID 填表、输入、恢复默认和板端读回流程加入 localStorage 读写。存储键使用选项上的 motorKey(kind:canBus:motorId)与 PID 环;记录不随卡片删除而删除。

**Tech Stack:** 浏览器 JavaScript 模块、localStorage、现有 Playwright CLI。

## 实施步骤

- [x] 在 tests/browser_pid_regression.js 添加浏览器回归:编辑整组参数后绑定、刷新、解绑并重新添加;切换同型号的另一电机、其他型号与速度/电流/位置环时恢复各自数值;默认值重置、板端读回、无效输入和不可用存储。
- [x] 运行回归,确认上次编辑被默认值覆盖的失败。
- [x] 修改 motor_bench_host/ui.js:新增字段映射、按电机与环的存储键、有效值保存与容错加载;fillPidForm 优先读记录,输入触发保存,恢复默认值显式忽略记录再保存,板端读回仅显示且忽略选择电机变化后的迟到报表。
- [x] 运行 PID 浏览器回归与 tests/browser_unbind_regression.js、tests/browser_waveform_regression.js、npm test、npm run test:waveform;确认保存不增加 pidSet 指令。
- [x] 更新 motor_bench_host/README.md,说明浏览器保存范围和应用方式;复核实现与测试。当前目录无 git 仓库,不创建提交。

验证结果:9 项 PID、10 项解绑、9 项波形浏览器场景全部通过;协议自测全部通过,7 项波形历史测试通过。独立代码复核无剩余发现。独立 3001 测试服务的真实 WebSocket 应答已验证本机串口发送失败标记;用户 3000 服务已提供最新前端文件,后端变更需服务重启生效。
