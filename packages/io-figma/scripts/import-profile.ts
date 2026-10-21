// Diagnostics: timing of .fig import stages into the model (for the profiler: node --cpu-prof).
import { Document } from '@mfp/core';
import { openFig } from '../src/container.ts';
import { decodeFigKiwi } from '../src/decode.ts';
import { FileSource } from '../src/node-source.ts';
import { buildScene } from '../src/scene.ts';
import { sceneToCore } from '../src/to-core.ts';

const t = [performance.now()];
const archive = await openFig(new FileSource(process.argv[2]!));
const { message } = decodeFigKiwi(archive.kiwi);
t.push(performance.now());
const scene = buildScene(message);
t.push(performance.now());
const { report } = sceneToCore(scene, new Document({ clientId: 1 }));
t.push(performance.now());
console.log(`чтение+декодирование ${(t[1]! - t[0]!).toFixed(0)} мс, сцена ${(t[2]! - t[1]!).toFixed(0)} мс, модель ${(t[3]! - t[2]!).toFixed(0)} мс, узлов ${report.nodes}`);
