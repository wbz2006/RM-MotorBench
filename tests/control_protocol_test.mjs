import assert from 'node:assert/strict';
import * as protocol from '../motor_bench_host/protocol.js';

assert.equal(typeof protocol.buildControlSource, 'function', '缺少网页/遥控器控制切换协议');
const frame = protocol.buildControlSource(1, 2, 6000);
assert.deepEqual([...frame.subarray(1, 9)], [0x0d, 6, 1, 2, 0, 128, 187, 69]);
assert.equal(new protocol.FrameParser().push(frame)[0].type, 0x0d);
assert.throws(() => protocol.buildControlSource(2, 0, 1));
assert.throws(() => protocol.buildControlSource(1, 8, 1));
assert.throws(() => protocol.buildControlSource(1, 0, NaN));
const body = Buffer.from([0, 1, 2, 1, 1, 1, 74, 1, 0, 128, 187, 69]);
assert.deepEqual(protocol.parseControlReport(body), {
  result: 0, source: 1, channelId: 2, online: true, switchRight: 1,
  ready: true, rocker: 330, maxRef: 6000,
});
assert.equal(protocol.parseControlReport(Buffer.alloc(11)), null);
console.log('PASS: remote control frame and status report');

assert.equal(typeof protocol.buildChassisControl, 'function', '缺少四轮底盘配置协议');
const chassis = protocol.buildChassisControl(2, [0, 2, 4, 6], 6000, 10);
assert.deepEqual([...chassis.subarray(1, 13)], [0x0d,10,2,0,2,4,6,10,0,128,187,69]);
assert.equal(new protocol.FrameParser().push(chassis)[0].type, 0x0d);
assert.throws(() => protocol.buildChassisControl(2, [0,0,2,3], 6000, 0));
assert.throws(() => protocol.buildChassisControl(2, [0,1,2,8], 6000, 0));
assert.throws(() => protocol.buildChassisControl(2, [0,1,2,3], NaN, 0));
assert.throws(() => protocol.buildChassisControl(2, [0,1,2,3], 6000, 16));
assert.throws(() => protocol.buildChassisControl(1, [0,1,2,3], 6000, 0));
const report = Buffer.concat([Buffer.from([0,2,255,1,1,1,74,1,0,128,187,69]), Buffer.from([0,2,4,6,10,156,255,200,0])]);
assert.deepEqual(protocol.parseControlReport(report), {
  result:0,source:2,channelId:255,online:true,switchRight:1,ready:true,rocker:330,maxRef:6000,
  channels:[0,2,4,6],reverseMask:10,lateral:-100,yaw:200,
});
const enable = protocol.buildChassisEnable(true);
assert.deepEqual([...enable.subarray(1, 4)], [0x0e,1,1]);
console.log('PASS: four-wheel chassis configuration, report and group enable');
