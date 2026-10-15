/** Binding metadata for one serial session. The wire protocol has no bind ACK. */
export class ChannelBindings {
  constructor() { this.reset(); }

  reset() {
    this.confirmed = new Map();
    this.pending = new Map();
    this.seen = new Set();
    this.free = new Set();
    this.motors = [];
  }

  request({ channelId, kind, canBus, motorId, outerLoop = 2 }) {
    // An existing board's first telemetry can belong to an old, rejected binding.
    // Only an empty inventory or a board-confirmed unbind proves a channel free.
    if (!this.free.has(channelId) || this.seen.has(channelId) || this.pending.has(channelId)) return;
    this.free.delete(channelId);
    this.pending.set(channelId, { channelId, kind, canBus, motorId, outerLoop });
  }

  telemetry(items) {
    let changed = false;
    for (const { channelId } of items) {
      this.seen.add(channelId);
      this.free.delete(channelId);
      const binding = this.pending.get(channelId);
      if (!binding) continue;
      this.confirmed.set(channelId, binding);
      this.pending.delete(channelId);
      changed = true;
    }
    return changed;
  }

  unbind({ channelId, result, boardConfirmed }) {
    if (result !== 0 && !(result === 1 && boardConfirmed !== false && !this.seen.has(channelId))) return;
    this.confirmed.delete(channelId);
    this.pending.delete(channelId);
    this.seen.delete(channelId);
    this.free.add(channelId);
  }

  inventory(items) {
    const contains = (list, motor) => list.some(m => m.kind === motor.kind && m.canBus === motor.canBus && m.motorId === motor.motorId);
    const removed = this.motors.some(m => !contains(items, m));
    this.motors = items;
    for (const map of [this.confirmed, this.pending]) {
      for (const [id, binding] of map) {
        if (contains(items, binding)) continue;
        map.delete(id);
        this.seen.delete(id);
        this.free.add(id);
      }
    }
    if (removed) {
      for (const id of this.seen) if (!this.confirmed.has(id)) this.seen.delete(id);
    }
    if (!items.length) this.free = new Set(Array.from({ length: 8 }, (_, id) => id));
  }

  identify({ channelId, kind, canBus, motorId, outerLoop }) {
    if (kind === 0) {
      if (this.confirmed.get(channelId)?.identified) this.confirmed.delete(channelId);
      return;
    }
    if (!this.seen.has(channelId) || ![0, 1, 2, 4].includes(outerLoop) ||
        (this.confirmed.has(channelId) && !this.confirmed.get(channelId).identified) ||
        !this.motors.some(m => m.kind === kind && m.canBus === canBus && m.motorId === motorId)) return;
    this.confirmed.set(channelId, { channelId, kind, canBus, motorId, outerLoop, identified: true });
  }

  snapshot() { return [...this.confirmed.values()].map(binding => ({ ...binding })); }
}
