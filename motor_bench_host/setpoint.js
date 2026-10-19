/** Speed setpoint programs. Times are seconds; values use the motor's native speed unit. */
export function createSetpointProgram(options, limit) {
  const number = (value, name, min, max) => {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${name}需在 ${min}～${max} 之间`);
    }
    return value;
  };
  number(limit, '转速限幅', Number.MIN_VALUE, Number.MAX_VALUE);
  const cycles = number(options.cycles ?? 0, '循环次数', 0, 1000); // 0 = repeat until stopped
  if (!Number.isInteger(cycles)) throw new Error('循环次数需为整数');
  let program;
  if (options.mode === 'sine') {
    const amplitude = number(options.amplitude, '幅值', 0, limit);
    const period = number(options.period, '周期（秒）', 0.5, 3600);
    program = { mode: 'sine', amplitude, cycleSeconds: period };
  } else if (options.mode === 'steps') {
    const text = String(options.steps ?? '').trim();
    if (!text) throw new Error('请填写阶梯目标序列');
    const entries = text.split(/[,，\s]+/);
    if (entries.some(value => !value)) throw new Error('阶梯目标不能为空');
    const steps = entries.map(Number);
    if (steps.length > 64) throw new Error('阶梯序列最多 64 级');
    for (const step of steps) number(step, '阶梯目标', -limit, limit);
    const dwell = number(options.dwell, '每级保持（秒）', 0.1, 3600);
    program = { mode: 'steps', steps, dwell, cycleSeconds: steps.length * dwell };
  } else {
    throw new Error('请选择正弦或阶梯输出');
  }
  return { ...program, cycles, duration: cycles === 0 ? Infinity : program.cycleSeconds * cycles };
}

export function sampleSetpoint(program, elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('运行时间无效');
  // Decimal dwell times (e.g. 0.1 s) must transition exactly at their boundaries.
  const epsilon = 1e-9;
  if (elapsed + epsilon >= program.duration) return { ref: 0, done: true, cycle: program.cycles };
  const cycle = Math.floor((elapsed + epsilon) / program.cycleSeconds) + 1;
  const phase = Math.max(0, elapsed - (cycle - 1) * program.cycleSeconds);
  if (program.mode === 'sine') {
    return { ref: program.amplitude * Math.sin(2 * Math.PI * phase / program.cycleSeconds), done: false, cycle };
  }
  const step = Math.min(program.steps.length - 1, Math.floor((phase + epsilon) / program.dwell));
  return { ref: program.steps[step], done: false, cycle, step: step + 1 };
}
