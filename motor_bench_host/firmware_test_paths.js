// Development defaults to A; select C or MC02 for migration checks.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = process.env.MOTORBENCH_FIRMWARE ?? 'motorbench-a';
if (!['motorbench-a', 'motorbench-c', 'motorbench-mc02'].includes(project)) {
  throw new Error('MOTORBENCH_FIRMWARE must be motorbench-a, motorbench-c or motorbench-mc02');
}

export const firmwareRelativeRoot = `../${project}/`;
export const firmwareRoot = fileURLToPath(new URL(firmwareRelativeRoot, import.meta.url));
export const firmwareSourceDir = project === 'motorbench-c' ? 'Src' : 'Core/Src';
if (!fs.existsSync(new URL(`${firmwareRelativeRoot}modules/motor_bench/motor_bench.c`, import.meta.url))) {
  throw new Error(`Motor bench firmware sources are missing: ${firmwareRoot}`);
}
console.log(`Firmware under test: ${project}`);
