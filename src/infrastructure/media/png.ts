import { crc32, deflateSync } from "node:zlib";

/**
 * Tiny dependency-free PNG encoder (RGB, 8-bit). Used by the mock provider to
 * produce placeholder scene images without network access.
 */
export type RGB = [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

export function encodePng(width: number, height: number, pixel: (x: number, y: number) => RGB): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Placeholder scene art: pastel vertical gradient, a "sun" and a simple character blob. */
export function placeholderScenePng(width: number, height: number, seed: number): Buffer {
  const hue = (seed * 67) % 360;
  const top = hsl(hue, 0.6, 0.85);
  const bottom = hsl((hue + 40) % 360, 0.55, 0.65);
  const sun = { x: width * 0.8, y: height * 0.22, r: Math.min(width, height) * 0.1 };
  const body = { x: width * (0.3 + 0.1 * (seed % 3)), y: height * 0.68, r: Math.min(width, height) * 0.16 };
  const bodyColor = hsl((hue + 180) % 360, 0.65, 0.55);
  return encodePng(width, height, (x, y) => {
    if ((x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2) return [255, 214, 90];
    if ((x - body.x) ** 2 + (y - body.y) ** 2 < body.r ** 2) {
      const eye = body.r * 0.15;
      const ex = body.x + body.r * 0.35;
      const ey = body.y - body.r * 0.25;
      if ((x - ex) ** 2 + (y - ey) ** 2 < eye ** 2 || (x - (ex - body.r * 0.7)) ** 2 + (y - ey) ** 2 < eye ** 2) return [30, 30, 30];
      return bodyColor;
    }
    if (y > height * 0.8) return hsl(110, 0.45, 0.55); // grass
    const t = y / height;
    return [0, 1, 2].map((i) => Math.round(top[i]! * (1 - t) + bottom[i]! * t)) as RGB;
  });
}
