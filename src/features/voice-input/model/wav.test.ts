import { describe, expect, it } from "vitest";
import {
  concatSamples,
  encodeWav,
  mixToMono,
  recordingToWav,
  resample,
  toPcm16,
  WHISPER_SAMPLE_RATE,
} from "./wav";

function header(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + 4));
  return {
    riff: text(0),
    riffSize: view.getUint32(4, true),
    wave: text(8),
    fmt: text(12),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36),
    dataSize: view.getUint32(40, true),
    sample: (index: number) => view.getInt16(44 + index * 2, true),
  };
}

function sine(frequency: number, rate: number, seconds: number) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return out;
}

function rms(samples: Float32Array) {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM header", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]));
    expect(wav.length).toBe(44 + 6);
    expect(header(wav)).toMatchObject({
      riff: "RIFF",
      riffSize: 36 + 6,
      wave: "WAVE",
      fmt: "fmt ",
      fmtSize: 16,
      format: 1,
      channels: 1,
      rate: 16_000,
      byteRate: 32_000,
      blockAlign: 2,
      bits: 16,
      data: "data",
      dataSize: 6,
    });
  });

  it("stores little-endian samples and clips out of range values", () => {
    const parsed = header(
      encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5, Number.NaN])),
    );
    expect([0, 1, 2, 3, 4, 5, 6].map((index) => parsed.sample(index))).toEqual([
      0, 32767, -32768, 32767, -32768, 16384, 0,
    ]);
  });

  it("encodes an empty recording as a bare header", () => {
    const wav = encodeWav(new Float32Array(0));
    expect(wav.length).toBe(44);
    expect(header(wav).dataSize).toBe(0);
  });
});

describe("toPcm16", () => {
  it("rounds to the nearest step", () => {
    expect(Array.from(toPcm16(new Float32Array([0.25, -0.25])))).toEqual([
      8192, -8192,
    ]);
  });
});

describe("mixToMono", () => {
  it("averages channels", () => {
    expect(
      Array.from(
        mixToMono([new Float32Array([1, 0.5]), new Float32Array([0, -0.5])]),
      ),
    ).toEqual([0.5, 0]);
  });

  it("copies a single channel and handles none", () => {
    const one = new Float32Array([0.25]);
    const mixed = mixToMono([one]);
    expect(Array.from(mixed)).toEqual([0.25]);
    expect(mixed).not.toBe(one);
    expect(mixToMono([]).length).toBe(0);
  });
});

describe("resample", () => {
  it("keeps the duration when going from 48 kHz to 16 kHz", () => {
    expect(resample(new Float32Array(48_000), 48_000).length).toBe(16_000);
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
  });

  it("averages each output window when downsampling", () => {
    expect(
      Array.from(resample(new Float32Array([1, 2, 3, 4, 5, 6]), 48_000)),
    ).toEqual([2, 5]);
  });

  it("keeps a speech-band tone and damps a tone above 8 kHz", () => {
    const voice = resample(sine(440, 48_000, 0.5), 48_000);
    const hiss = resample(sine(15_000, 48_000, 0.5), 48_000);
    expect(rms(voice)).toBeGreaterThan(0.65);
    expect(rms(hiss)).toBeLessThan(0.35);
  });

  it("interpolates when upsampling", () => {
    expect(Array.from(resample(new Float32Array([0, 1]), 8_000))).toEqual([
      0, 0.5, 1, 1,
    ]);
  });

  it("copies when the rate already matches and rejects bad rates", () => {
    const input = new Float32Array([0.1]);
    const out = resample(input, WHISPER_SAMPLE_RATE);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(() => resample(input, 0)).toThrow();
  });
});

describe("recordingToWav", () => {
  it("joins chunks, resamples and encodes", () => {
    const chunks = [new Float32Array(24_000), new Float32Array(24_000)];
    expect(concatSamples(chunks).length).toBe(48_000);
    const wav = recordingToWav(chunks, 48_000);
    expect(header(wav).dataSize).toBe(32_000);
    expect(header(wav).rate).toBe(16_000);
  });
});
