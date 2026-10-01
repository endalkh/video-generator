/**
 * Minimal WAV (RIFF, PCM 16-bit) helpers.
 * Gemini TTS returns raw little-endian 16-bit PCM (24 kHz mono), which needs a header before ffmpeg/players accept it.
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const GEMINI_TTS_FORMAT: PcmFormat = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 };

export function pcmToWav(pcm: Uint8Array, fmt: PcmFormat = GEMINI_TTS_FORMAT): Buffer {
  const { sampleRate, channels, bitsPerSample } = fmt;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/** Parse duration (seconds) from a PCM WAV buffer by walking its chunks. */
export function wavDurationSeconds(wav: Uint8Array): number {
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!byteRate) throw new Error("WAV data chunk before fmt chunk");
      const dataSize = Math.min(size, buf.length - offset - 8);
      return dataSize / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/**
 * Generate a gentle melody-ish WAV (used by the mock provider).
 * Notes cycle through a pentatonic scale with a short fade per note to avoid clicks.
 */
export function toneWav(durationSec: number, seed = 0, fmt: PcmFormat = GEMINI_TTS_FORMAT): Buffer {
  const { sampleRate } = fmt;
  const total = Math.max(1, Math.round(durationSec * sampleRate));
  const pcm = Buffer.alloc(total * 2);
  const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
  const noteLen = Math.round(sampleRate * 0.4);
  const fade = Math.round(sampleRate * 0.02);
  for (let i = 0; i < total; i++) {
    const n = Math.floor(i / noteLen);
    const pos = i % noteLen;
    const freq = scale[(n * 3 + seed) % scale.length]!;
    const env = Math.min(1, pos / fade, (noteLen - pos) / fade);
    const sample = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.25 * env;
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return pcmToWav(pcm, { ...fmt, channels: 1, bitsPerSample: 16 });
}
