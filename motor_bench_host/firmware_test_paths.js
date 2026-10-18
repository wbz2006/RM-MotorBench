// Development defaults to A; select the independent C snapshot for migration checks.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = process.env.MOTORBENCH_FIRMWARE ?? 'motorbench-a';
if (!['motorbench-a', 'motorbench-c'].includes(project)) {
  throw new Error('MOTORBENCH_FIRMWARE must be motorbench-a or motorbench-c');
}

export const firmwareRelativeRoot = `../${project}/`;
export const firmwareRoot = fileURLToPath(new URL(firmwareRelativeRoot, import.meta.url));
export const firmwareSourceDir = project === 'motorbench-c' ? 'Src' : 'Core/Src';
if (!fs.existsSync(new URL(`${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`, import.meta.url))) {
  throw new Error(`Motor bench firmware sources are missing: ${firmwareRoot}`);
}
console.log(`Firmware under test: ${project}`);
