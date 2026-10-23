/** Original shoot.c: deg/s = shoot_rate * 360 * reduction / roundsPerTurn.
 * The host uses rotor rpm for DJI targets, so divide that result by 6.
 */
export function calculateLoaderSpeed(rate, reduction, roundsPerTurn) {
  if (!Number.isFinite(rate) || rate < 0) throw new Error('射频需为大于或等于 0 的有限数值');
  if (!Number.isFinite(reduction) || reduction <= 0) throw new Error('总减速比需为大于 0 的有限数值');
  if (!Number.isSafeInteger(roundsPerTurn) || roundsPerTurn < 1) throw new Error('每圈发数需为正整数');
  const diskRpm = rate * 60 / roundsPerTurn;
  const rotorRpm = diskRpm * reduction;
  const rotorRad = rotorRpm * Math.PI / 30;
  if (![diskRpm, rotorRpm, rotorRad].every(Number.isFinite)) throw new Error('计算结果超出数值范围，请减小输入');
  return { diskRpm, rotorRpm, rotorRad };
}

// Keep the per-action bound in sync with MB_POSITION_STEP_MAX_DEG.
export const POSITION_STEP_MAX_DEG = 36000;
// reduction is external gearbox-output-to-disk reduction; built-in DJI gearing is handled by firmware.
export function calculateLoaderStep(reduction, roundsPerTurn, shots = 1, direction = 1) {
  if (!Number.isFinite(reduction) || reduction <= 0) throw new Error('总减速比需为大于 0 的有限数值');
  if (!Number.isSafeInteger(roundsPerTurn) || roundsPerTurn < 1) throw new Error('每圈发数需为正整数');
  if (![1, 2].includes(shots) || ![1, -1].includes(direction)) throw new Error('请选择单发或双发及转动方向');
  const perShot = 360 * reduction / roundsPerTurn;
  const delta = direction * perShot * shots;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.001 || Math.abs(delta) > POSITION_STEP_MAX_DEG)
    throw new Error(`本次输出轴步进角度需在 0.001～${POSITION_STEP_MAX_DEG}° 之间`);
  return { perShot, delta, shots };
}
