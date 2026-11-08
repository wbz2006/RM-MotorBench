/** Inputs are validated by the mode UI; samples use motor speed and disk degrees. */
export class FeederController {
  constructor(options, now, angle = 0) {
    this.options = options;
    this.phase = 'feeding';
    this.jams = 0;
    this.attempts = 0;
    this.readyAt = now + 1000;
    this.suspectAt = null;
    this.stableAt = null;
    this.reason = '';
    this.lastAngle = angle;
    this.travel = 0;
  }

  get shots() {
    return Math.floor(Math.max(0, this.travel) * this.options.roundsPerTurn / 360 + 1e-9);
  }

  recordAngle(angle) {
    let delta = angle - this.lastAngle;
    if (this.options.anglePeriod) delta -= Math.round(delta / this.options.anglePeriod) * this.options.anglePeriod;
    this.lastAngle = angle;
    this.travel += Math.sign(this.options.target) * delta;
    return delta;
  }

  sample({ at, speed, load, angle }) {
    const o = this.options;
    if (this.phase === 'stopped') return null;
    const delta = this.recordAngle(angle);
    if (this.phase === 'reversing') {
      this.reverseProgress += -Math.sign(o.target) * delta;
      if (this.reverseProgress >= o.reverseAngle) {
        this.phase = 'feeding';
        this.readyAt = at + 1000;
        this.suspectAt = this.stableAt = null;
        return o.target;
      }
      if (at - this.reverseAt >= o.reverseTimeout) return this.stop('回退超时，请检查负载和回退参数');
      return null;
    }
    if (at < this.readyAt) return null;
    const ratio = speed / o.target;
    const jammed = load > o.threshold && ratio < o.lowSpeed;
    if (!jammed) this.suspectAt = null;
    if (ratio >= 0.8 && ratio <= 1.2 && load <= o.threshold) {
      this.stableAt ??= at;
      if (at - this.stableAt >= 1000) this.attempts = 0;
    } else this.stableAt = null;
    if (!jammed) return null;
    this.suspectAt ??= at;
    if (at - this.suspectAt < o.detectMs) return null;
    this.jams++;
    if (this.attempts >= o.maxRetries) return this.stop('连续解卡失败，已达到重试上限');
    this.attempts++;
    this.phase = 'reversing';
    this.reverseProgress = 0;
    this.reverseAt = at;
    return -Math.sign(o.target) * o.reverseSpeed;
  }

  stop(reason) {
    this.phase = 'stopped';
    this.reason = reason;
    return 0;
  }
}
