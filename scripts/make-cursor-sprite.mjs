// Draws the cursor sprite the `cursor` tool composites (#170) and writes it to
// assets/cursor/arrow.png. The arrow is an original shape drawn here: a white
// pointer with a dark outline and a soft drop shadow, at a high resolution so
// it scales down cleanly. Run `node scripts/make-cursor-sprite.mjs` after
// changing it, and update CURSOR_SPRITE in src/utils/cursor.ts to the printed
// numbers.
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const S = 6; // pixels per unit
const PAD = 1.5; // units left of / above the tip (room for the outline)
const SHADOW_PAD = 4; // units right of / below the shape (room for the shadow)
// The pointer, tip at (0, 0), in units.
const POLY = [
  [0, 0],
  [0, 19],
  [4.5, 15],
  [7.5, 22.5],
  [10.5, 21.2],
  [7.6, 14.2],
  [13.5, 14.2],
];
const OUTLINE = 1.3; // stroke width, units, centred on the edge
const SHADOW = { dx: 0.9, dy: 1.6, blur: 1.1, alpha: 0.4 };

const maxX = Math.max(...POLY.map((p) => p[0]));
const maxY = Math.max(...POLY.map((p) => p[1]));
const W = Math.ceil((PAD + maxX + SHADOW_PAD) * S);
const H = Math.ceil((PAD + maxY + SHADOW_PAD) * S);

function inside(x, y) {
  let c = false;
  for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
    const [xi, yi] = POLY[i];
    const [xj, yj] = POLY[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function edgeDist(x, y) {
  let d = Infinity;
  for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
    const [ax, ay] = POLY[j];
    const [bx, by] = POLY[i];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    d = Math.min(d, Math.hypot(x - ax - t * vx, y - ay - t * vy));
  }
  return d;
}

// Coverage per pixel (4x4 supersampling): stroke, fill, and the whole shape.
const SS = 4;
const stroke = new Float32Array(W * H);
const fill = new Float32Array(W * H);
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    let s = 0;
    let f = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / S - PAD;
        const y = (py + (sy + 0.5) / SS) / S - PAD;
        if (edgeDist(x, y) <= OUTLINE / 2) s++;
        else if (inside(x, y)) f++;
      }
    }
    stroke[py * W + px] = s / (SS * SS);
    fill[py * W + px] = f / (SS * SS);
  }
}

// Shadow: the shape's coverage, shifted and box-blurred three times.
const shape = stroke.map((v, i) => v + fill[i]);
let shadow = new Float32Array(W * H);
const ox = Math.round(SHADOW.dx * S);
const oy = Math.round(SHADOW.dy * S);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = x - ox;
  const sy = y - oy;
  if (sx >= 0 && sy >= 0) shadow[y * W + x] = shape[sy * W + sx];
}
const r = Math.max(1, Math.round(SHADOW.blur * S));
for (let pass = 0; pass < 3; pass++) {
  for (const horizontal of [true, false]) {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? x + k : x;
        const yy = horizontal ? y : y + k;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) sum += shadow[yy * W + xx];
      }
      out[y * W + x] = sum / (2 * r + 1);
    }
    shadow = out;
  }
}

// Compose: white fill and dark stroke over the shadow.
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const a1 = Math.min(1, stroke[i] + fill[i]);
  const c1 = a1 > 0 ? (fill[i] * 255 + stroke[i] * 24) / (stroke[i] + fill[i]) : 0;
  const a0 = shadow[i] * SHADOW.alpha;
  const a = a1 + a0 * (1 - a1);
  const c = a > 0 ? (c1 * a1) / a : 0; // the shadow is black
  rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = Math.round(c);
  rgba[i * 4 + 3] = Math.round(a * 255);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const rows = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) rgba.copy(rows, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(rows, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "cursor", "arrow.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
const hot = Math.round(PAD * S);
console.log(`${out}: ${W}x${H}, hotspot ${hot},${hot}, arrow height ${Math.round(maxY * S)} px, ${png.length} bytes`);
