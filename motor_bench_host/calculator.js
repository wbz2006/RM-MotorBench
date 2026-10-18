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
