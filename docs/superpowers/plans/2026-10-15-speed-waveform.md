# 实时转速波形 Implementation Plan

**Goal:** 在网页叠加目标和实际转速,帮助用户观察 PID 响应。

**Architecture:** `waveform.js` 封装有界历史和 Canvas 视图;`ui.js` 只转交遥测及通道生命周期。使用浏览器现有 API 和 Node 内置测试工具。

**Tech Stack:** ES modules, Canvas 2D, ResizeObserver, requestAnimationFrame, node:test, Playwright CLI。

## Global Constraints

- 使用板端 ref/speed;仅速度环按相同单位叠加。
- 每通道最多保存 60 秒/6000 点,20 fps 绘图;断线不插值。
- 保留其他卡片参数与控制行为;不增加包依赖,不修改固件。

## Task 1: 历史与绘图

Files: 新增 `motor_bench_host/waveform.js`、`tests/waveform_history_test.mjs`。

- [x] 编写历史测试:双值原样保存、时间/容量裁剪、非有限值/离线断点、通道隔离、暂停快照和清空。
- [x] 运行 `node --test tests/waveform_history_test.mjs`,确认缺失实现导致失败。
- [x] 实现 `SpeedHistory.append(id,item,time)`、`view(id,end,window)`、`snapshot()`、`clear(id)`、`remove(id)`、`break(time)`。
- [x] 实现 `SpeedWaveform` 的通道配置、遥测采集、暂停快照和 Canvas 双线绘图;再次运行历史测试。

## Task 2: 网页集成和回归

Files: 修改 `motor_bench_host/index.html`、`style.css`、`ui.js`、`package.json`、`README.md`;新增 `tests/browser_waveform_regression.js`。

- [x] 浏览器测试先确认页面尚无波形。
- [x] 添加图例、单位、读数、通道/时间选择、暂停和清空;接入绑定、遥测、解绑与连接状态。
- [x] 浏览器验证双线像素、目标来自板端、暂停/继续/清空、通道/单位/非速度环、掉线与解绑复用。
- [x] 运行 `npm test`、`npm run test:control`、历史测试和既有浏览器控制/解绑回归;检查桌面和窄屏截图。
- [x] 按 requesting-code-review 技能委派只读审查,处理实质问题后交付。工作目录无 Git,不创建提交。

验证结果:7 项历史测试、9 组波形浏览器测试、7 组解绑浏览器测试、原有调速/遥控浏览器测试及协议自测全部通过。只读审查最终无 Critical/Important 遗留。浏览器使用模拟板端应答,未执行实体电机测试。
