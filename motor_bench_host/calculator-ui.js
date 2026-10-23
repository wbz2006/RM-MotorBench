import { calculateLoaderSpeed } from './calculator.js';
import { initLoaderTest } from './loader-test-ui.js';

const format = value => value !== 0 && Math.abs(value) < 0.001
  ? value.toExponential(3)
  : String(Number(value.toFixed(3)));

/** Each channel owns its inputs and results; onResult only fills its local target. */
export function initCalculator(host, prefix, onResult, positionAdapter) {
  host.appendChild(document.getElementById('calculatorTpl').content.cloneNode(true));
  const speedBody = host.querySelector('.calculator-body');
  const get = name => host.querySelector(`[data-calc="${name}"]`);
  for (const input of host.querySelectorAll('[data-calc]')) input.id = `${prefix}-${input.dataset.calc}`;
  for (const label of host.querySelectorAll('[data-calc-for]')) label.htmlFor = `${prefix}-${label.dataset.calcFor}`;
  const inputs = ['calcRate', 'calcRatio', 'calcPerTurn'].map(get);
  const outputs = ['calcRpm', 'calcRad', 'calcDiskRpm'].map(get);
  const error = get('calcError');
  const drive = get('calcDrive');
  const ratioWrap = get('calcRatioWrap');
  const driveNote = get('calcDriveNote');
  const prompt = get('calcPrompt');
  const sign = get('calcSign');
  let direction = 1;
  let type = 'loader';

  function update(write = false) {
    let result = null;
    const direct = drive.value === 'direct';
    ratioWrap.hidden = direct;
    inputs[1].disabled = direct;
    driveNote.textContent = direct ? '直驱：电机与拨盘同速' : '减速比 = 电机转速 ÷ 拨盘转速';
    error.hidden = true;
    error.textContent = '';
    prompt.hidden = inputs[2].value !== '';
    if (!prompt.hidden) {
      outputs.forEach(output => { output.value = '—'; });
      onResult(null, false);
      return;
    }
    try {
      result = calculateLoaderSpeed(inputs[0].valueAsNumber, direct ? 1 : inputs[1].valueAsNumber, inputs[2].valueAsNumber);
      // Only the final motor target carries direction; zero stays zero.
      result.rotorRpm = result.rotorRpm === 0 ? 0 : direction * result.rotorRpm;
      result.rotorRad = result.rotorRad === 0 ? 0 : direction * result.rotorRad;
      [result.rotorRpm, result.rotorRad, result.diskRpm].forEach((value, i) => { outputs[i].value = format(value); });
    } catch (e) {
      outputs.forEach(output => { output.value = '—'; });
      error.textContent = e.message;
      error.hidden = false;
    }
    if (type === 'loader') onResult(result, write);
  }

  inputs.forEach(input => input.addEventListener('input', () => update(true)));
  drive.addEventListener('change', () => update(true));
  sign.addEventListener('click', () => {
    direction *= -1;
    sign.textContent = direction < 0 ? '− 负值' : '+ 正值';
    sign.setAttribute('aria-pressed', String(direction < 0));
    update(true);
  });
  update();
  const position = initLoaderTest(host, positionAdapter);
  return {
    get positionLocked() { return position.locked; },
    refresh: () => type === 'loader' ? update() : position.refresh(),
    fill: () => type === 'loader' ? update(true) : position.refresh(),
    setType(value) {
      type = value;
      speedBody.hidden = type !== 'loader';
      position.show(type === 'loaderPosition');
      onResult(null, false);
      if (type === 'loader') update(true);
    },
    stopPositionTest: (message, disable) => position.stop(message, disable),
    positionAck: ack => position.acknowledge(ack),
    destroy: () => position.destroy(),
  };
}
