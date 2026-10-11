/** whisper.cpp reads 16 kHz mono 16-bit PCM WAV without converting it. */
export const WHISPER_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;

/** One buffer from many, in order. */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The average of every channel. Channels shorter than the first read as silence. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (const channel of channels) {
    const n = Math.min(length, channel.length);
    for (let i = 0; i < n; i += 1) out[i] += channel[i];
  }
  for (let i = 0; i < length; i += 1) out[i] /= channels.length;
  return out;
}

/**
 * Resample mono audio. Going down, each output sample is the mean of the
 * input samples it covers: a box filter, which keeps most content above the
 * new Nyquist rate from folding back into speech. Going up, it interpolates
 * linearly. Good enough for speech recognition, not for music.
 */
export function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number = WHISPER_SAMPLE_RATE,
): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) {
    throw new Error("Sample rates must be positive.");
  }
  if (fromRate === toRate) return Float32Array.from(samples);
  const length = Math.floor((samples.length * toRate) / fromRate);
  const out = new Float32Array(length);
  const ratio = fromRate / toRate;
  if (ratio > 1) {
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(
        start + 1,
        Math.min(samples.length, Math.floor((i + 1) * ratio)),
      );
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += samples[j];
      out[i] = sum / (end - start);
    }
    return out;
  }
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const t = position - left;
    out[i] = samples[left] * (1 - t) + samples[right] * t;
  }
  return out;
}

/** Float samples in [-1, 1] to signed 16-bit, clipping anything outside. */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return out;
}

/** A mono 16-bit PCM WAV file: a 44 byte RIFF header, then little-endian samples. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number = WHISPER_SAMPLE_RATE,
): Uint8Array {
  const pcm = toPcm16(samples);
  const dataBytes = pcm.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
  }
  return bytes;
}

/** Captured mono chunks at the device rate, to the WAV whisper.cpp wants. */
export function recordingToWav(
  chunks: readonly Float32Array[],
  sampleRate: number,
): Uint8Array {
  return encodeWav(resample(concatSamples(chunks), sampleRate));
}
