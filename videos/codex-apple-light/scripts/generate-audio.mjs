import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sampleRate = 48000;
const duration = 50;
const channels = 2;
const totalSamples = sampleRate * duration;
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

const clamp = (value) => Math.max(-1, Math.min(1, value));
const env = (i, start, len, attack = 0.01, release = 0.08) => {
  const t = i / sampleRate - start;
  if (t < 0 || t > len) return 0;
  if (t < attack) return t / attack;
  if (t > len - release) return Math.max(0, (len - t) / release);
  return 1;
};

function addTone(start, len, freq, gain, pan = 0, type = "sine") {
  const begin = Math.floor(start * sampleRate);
  const end = Math.min(totalSamples, Math.floor((start + len) * sampleRate));
  for (let i = begin; i < end; i += 1) {
    const t = (i - begin) / sampleRate;
    const wave =
      type === "triangle"
        ? (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t))
        : Math.sin(2 * Math.PI * freq * t);
    const shaped = wave * env(i, start, len, 0.02, 0.16) * gain;
    left[i] += shaped * (pan <= 0 ? 1 : 1 - pan);
    right[i] += shaped * (pan >= 0 ? 1 : 1 + pan);
  }
}

function addClick(start, gain = 0.08, pan = 0) {
  const begin = Math.floor(start * sampleRate);
  const len = Math.floor(0.036 * sampleRate);
  for (let n = 0; n < len && begin + n < totalSamples; n += 1) {
    const decay = Math.exp(-n / (sampleRate * 0.012));
    const tick = (Math.sin(n * 0.7) + Math.sin(n * 1.37) * 0.4) * decay * gain;
    left[begin + n] += tick * (pan <= 0 ? 1 : 1 - pan);
    right[begin + n] += tick * (pan >= 0 ? 1 : 1 + pan);
  }
}

function addNoise(start, len, gain = 0.02) {
  const begin = Math.floor(start * sampleRate);
  const end = Math.min(totalSamples, Math.floor((start + len) * sampleRate));
  let seed = 7;
  for (let i = begin; i < end; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const noise = ((seed / 2147483647) * 2 - 1) * env(i, start, len, 0.03, 0.15) * gain;
    left[i] += noise;
    right[i] += noise * 0.88;
  }
}

// Restrained premium music bed.
for (let t = 0; t < duration; t += 0.5) {
  addTone(t, 0.45, 110, 0.012, -0.08, "triangle");
  addTone(t + 0.02, 0.42, 220, 0.007, 0.12, "sine");
}
for (const t of [0, 6, 16, 31, 43]) {
  addTone(t, 2.8, 55, 0.026, -0.05, "sine");
  addTone(t + 0.04, 2.4, 165, 0.012, 0.08, "sine");
}

// Prompt typing.
let time = 1.58;
for (let i = 0; i < 38; i += 1) {
  addClick(time, 0.052 + (i % 5) * 0.004, i % 2 ? 0.08 : -0.1);
  time += 0.072 + (i % 4) * 0.012;
}
addClick(5.55, 0.11, 0);
addNoise(5.58, 0.14, 0.018);

// Context and patch output typing.
for (const base of [6.25, 10.85, 17.3, 17.58, 17.86, 18.14, 23.2, 32.15, 32.58, 33.0, 35.2]) {
  addClick(base, 0.055, -0.04);
}
for (let t = 16.4; t < 24.1; t += 0.19) addClick(t, 0.035, t % 0.4 > 0.2 ? 0.08 : -0.08);

// Passing checks and completion chime.
for (const t of [34.2, 34.55, 34.92, 35.25]) {
  addTone(t, 0.22, 880, 0.035, 0.1, "triangle");
  addClick(t, 0.04, 0.12);
}
addTone(43.05, 1.4, 523.25, 0.055, -0.12, "sine");
addTone(43.17, 1.3, 659.25, 0.045, 0.04, "sine");
addTone(43.32, 1.2, 783.99, 0.04, 0.16, "sine");

const dataSize = totalSamples * channels * 2;
const buffer = Buffer.alloc(44 + dataSize);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * 2, 28);
buffer.writeUInt16LE(channels * 2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);

let offset = 44;
for (let i = 0; i < totalSamples; i += 1) {
  buffer.writeInt16LE(Math.round(clamp(left[i]) * 32767), offset);
  offset += 2;
  buffer.writeInt16LE(Math.round(clamp(right[i]) * 32767), offset);
  offset += 2;
}

const output = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/codex-apple-light-mix.wav");
writeFileSync(output, buffer);
console.log(output);
