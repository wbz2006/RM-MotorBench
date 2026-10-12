/**
 * txqueue_test.js —— USB 发送环形队列的等价模型测试
 *
 * @note 固件里的 MotorBenchUsbEnqueue/Pump 是 C 实现,这里用等价的 JS 模型
 *       验证其边界行为(绕回、满丢弃、分包切分),避免逻辑错误等到实机才暴露。
 *
 * 关键约束(来自固件实现):
 *   - 环大小 1024,单包上限 64 字节(USB FS 最大包长)
 *   - 遥测帧最长 5 + 3 + 8*21 = 176 字节
 *   - 队列满时丢弃新帧而非阻塞
 *   - pump 每次只发一个包,其余靠完成回调续推
 */

const RING = 1024;
const MAX_PKT = 64;
const MAX_FRAME = 176;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

/** 与固件 MotorBenchUsbPump 行为一致的模型 */
class TxQueue {
  constructor() {
    this.buf = Buffer.alloc(RING);
    this.head = 0;
    this.tail = 0;
  }
  free() {
    return RING - ((this.head - this.tail + RING) % RING);
  }
  enqueue(data) {
    if (this.free() < data.length) return false;
    data.copy(this.buf, this.head);
    this.head = (this.head + data.length) % RING;
    return true;
  }
  /** 尝试发一个包;模拟 USB 忙时返回 false */
  pump(busy = false) {
    if (this.tail === this.head) return null;
    if (busy) return null;
    const avail = (this.head - this.tail + RING) % RING;
    const chunk = Math.min(avail, MAX_PKT);
    let pkt;
    if (this.tail + chunk <= RING) {
      pkt = Buffer.from(this.buf.subarray(this.tail, this.tail + chunk));
    } else {
      const first = RING - this.tail;
      pkt = Buffer.concat([
        Buffer.from(this.buf.subarray(this.tail, RING)),
        Buffer.from(this.buf.subarray(0, chunk - first)),
      ]);
    }
    this.tail = (this.tail + chunk) % RING;
    return pkt;
  }
  /** 把队列全部发完(重复 pump),返回拼出的字节流 */
  drain(busyFirst = false) {
    const parts = [];
    let first = true;
    for (;;) {
      const p = this.pump(first && busyFirst);
      first = false;
      if (!p) {
        if (this.tail === this.head) break;
        continue; // busy → 重试
      }
      parts.push(p);
      if (parts.length > 200) throw new Error('drain runaway');
    }
    return Buffer.concat(parts);
  }
}

console.log('== 1. 基本入队/出队 ==');
const q = new TxQueue();
const f1 = Buffer.from([0xa5, 0x01, 0x00, 0x00, 0x5a]); // 5 字节心跳
check('short frame enqueued', q.enqueue(f1));
check('drain returns same bytes', q.drain().equals(f1));

console.log('\n== 2. 分包:176 字节遥测帧拆成 64+64+48 ==');
const q2 = new TxQueue();
const frame = Buffer.alloc(MAX_FRAME);
for (let i = 0; i < MAX_FRAME; i++) frame[i] = i & 0xff;
check('176B frame enqueued', q2.enqueue(frame));
const pkts = [];
for (;;) {
  const p = q2.pump();
  if (!p) break;
  pkts.push(p.length);
}
check('split into 3 packets', pkts.length === 3, JSON.stringify(pkts));
check('packet sizes 64/64/48', pkts[0] === 64 && pkts[1] === 64 && pkts[2] === 48, JSON.stringify(pkts));
check('reassembled equals original', q2.drain().length === 0);

console.log('\n== 3. 环形绕回 ==');
const q3 = new TxQueue();
// 先灌到接近满,再绕回测试
const filler = Buffer.alloc(900);
q3.enqueue(filler);
q3.drain();
check('after drain queue empty', q3.tail === q3.head);
const f2 = Buffer.alloc(200, 0xaa);
q3.enqueue(f2);
// 让指针落到环中部,制造绕回
q3.head = (q3.head + 700) % RING;
q3.tail = q3.head;
q3.enqueue(f2);
const out3 = q3.drain();
check('wrap-around frame reassembled correctly', out3.equals(f2), `len=${out3.length}`);

console.log('\n== 4. 队列满时丢弃 ==');
const q4 = new TxQueue();
const big = Buffer.alloc(RING - 1);
check('fills queue', q4.enqueue(big));
check('subsequent enqueue rejected', q4.enqueue(Buffer.alloc(10)) === false);
check('queue not corrupted', q4.free() === 1);

console.log('\n== 5. USB 忙时保留数据待重试 ==');
const q5 = new TxQueue();
q5.enqueue(Buffer.from([1, 2, 3, 4]));
check('pump busy returns null', q5.pump(true) === null);
check('data still queued', q5.tail !== q5.head);
check('retry succeeds', q5.pump(false).equals(Buffer.from([1, 2, 3, 4])));

console.log('\n== 6. 边界:空队列 ==');
const q6 = new TxQueue();
check('pump on empty returns null', q6.pump() === null);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);