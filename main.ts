// Phoenix Rising — a neon phoenix bursting over a city at dusk.
// Drawn entirely in code: Node 22 stdlib only (node:fs, node:path, node:zlib).
// Writes one 1024x1024 PNG to $MAKEFUN_OUTPUT_DIR/entry.png (default /output).
// Deterministic: fixed-seed RNG, no clock, no randomness in output paths.
// Run twice -> byte-identical file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;

// ---------- deterministic RNG (mulberry32, fixed seed) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---------- PNG encoder (signature + IHDR + IDAT + IEND, CRC32 inline) ----------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Filter a row: 0=None, 1=Sub, 2=Up, 4=Paeth. bpp = 4 (RGBA).
function filterRow(filter: number, row: Uint8Array, prev: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(row.length + 1);
  out[0] = filter;
  if (filter === 0) {
    out.set(row, 1);
    return out;
  }
  for (let i = 0; i < row.length; i++) {
    const x = row[i];
    const a = i >= 4 ? row[i - 4] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= 4 ? prev[i - 4] : 0;
    let pred = 0;
    if (filter === 1) pred = a;
    else if (filter === 2) pred = b;
    else {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i + 1] = (x - pred) & 0xff;
  }
  return out;
}

function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // Try filter 0 first; if the result is over 1 MiB, try Up and Paeth and keep the smallest.
  const stride = width * 4;
  let best: Uint8Array | null = null;
  for (const filter of [0, 2, 4, 1]) {
    const rows: Uint8Array[] = [];
    let prev: Uint8Array | null = null;
    for (let y = 0; y < height; y++) {
      const row = rgba.subarray(y * stride, (y + 1) * stride);
      rows.push(filterRow(filter, row, prev));
      prev = row;
    }
    const raw = concat(rows);
    const idat = deflateSync(raw, { level: 9 });
    const png = concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
    if (best === null || png.length < best.length) best = png;
    if (filter === 0 && png.length <= 1048576) break; // filter 0 already fits
  }
  return best!;
}

// ---------- canvas: 1024x1024 RGBA buffer, plain-math drawing ----------
const px = new Uint8Array(W * H * 4);

function setPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  const sa = a / 255;
  const da = 1 - sa;
  px[i] = Math.round(r * sa + px[i] * da);
  px[i + 1] = Math.round(g * sa + px[i + 1] * da);
  px[i + 2] = Math.round(b * sa + px[i + 2] * da);
  px[i + 3] = 255;
}

// Additive glow: light adds to what is already there (clamped).
function addPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  const s = a / 255;
  px[i] = Math.min(255, px[i] + r * s);
  px[i + 1] = Math.min(255, px[i + 1] + g * s);
  px[i + 2] = Math.min(255, px[i + 2] + b * s);
  px[i + 3] = 255;
}

// Soft filled ellipse. mode "add" glows, "set" paints opaque-ish.
function ellipse(cx: number, cy: number, rx: number, ry: number, r: number, g: number, b: number, a: number, mode: "add" | "set"): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / ry;
    const dxMax = Math.sqrt(Math.max(0, 1 - dy * dy)) * rx;
    for (let x = Math.max(x0, Math.ceil(cx - dxMax)); x <= Math.min(x1, Math.floor(cx + dxMax)); x++) {
      const dx = (x - cx) / rx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const fall = Math.max(0, 1 - d);
      const alpha = a * fall * fall;
      if (mode === "add") addPixel(x, y, r, g, b, alpha);
      else setPixel(x, y, r, g, b, alpha);
    }
  }
}

// Rotated soft ellipse (feather / plume segment): rotate point into ellipse space.
function ellipseRot(cx: number, cy: number, rx: number, ry: number, angle: number, r: number, g: number, b: number, a: number, mode: "add" | "set"): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rad = Math.max(rx, ry) + 2;
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const fall = 1 - Math.sqrt(d2);
      const alpha = a * fall * fall;
      if (mode === "add") addPixel(x, y, r, g, b, alpha);
      else setPixel(x, y, r, g, b, alpha);
    }
  }
}

function fillRect(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const i = (y * W + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix3(c1: number[], c2: number[], t: number): number[] {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------- scene ----------
function drawSky(): void {
  // Dusk gradient: deep indigo -> violet -> magenta -> burning orange at the horizon.
  const stops: [number, number[]][] = [
    [0.0, [16, 10, 54]],
    [0.35, [58, 24, 110]],
    [0.55, [128, 34, 120]],
    [0.68, [214, 62, 92]],
    [0.78, [255, 122, 48]],
    [1.0, [255, 176, 66]],
  ];
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    let s = stops[0];
    let e = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) {
        s = stops[k];
        e = stops[k + 1];
        break;
      }
    }
    const f = (t - s[0]) / Math.max(1e-6, e[0] - s[0]);
    const c = mix3(s[1], e[1], Math.max(0, Math.min(1, f)));
    const i = y * W * 4;
    for (let x = 0; x < W; x++) {
      px[i + x * 4] = c[0];
      px[i + x * 4 + 1] = c[1];
      px[i + x * 4 + 2] = c[2];
      px[i + x * 4 + 3] = 255;
    }
  }
}

function drawSun(): void {
  // Huge low sun on the horizon + wide halo, peeking above the skyline.
  const sx = 512;
  const sy = 640;
  ellipse(sx, sy, 420, 300, 255, 120, 40, 26, "add");
  ellipse(sx, sy, 260, 190, 255, 150, 50, 48, "add");
  ellipse(sx, sy, 150, 110, 255, 196, 80, 120, "add");
  ellipse(sx, sy, 92, 70, 255, 232, 150, 210, "add");
  ellipse(sx, sy, 58, 46, 255, 250, 215, 235, "add");
}

function drawStars(): void {
  // 240 stars, only in the dark upper sky, brighter near the top.
  for (let n = 0; n < 240; n++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * rand() * 430);
    const bright = 120 + Math.floor(rand() * 135);
    const size = rand() < 0.12 ? 2 : 1;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        addPixel(x + dx, y + dy, bright, bright, Math.min(255, bright + 40), 200);
      }
    }
    if (rand() < 0.18) {
      // cross sparkle on a few bright stars
      addPixel(x - 1, y, 255, 255, 255, 90);
      addPixel(x + 1, y, 255, 255, 255, 90);
      addPixel(x, y - 1, 255, 255, 255, 90);
      addPixel(x, y + 1, 255, 255, 255, 90);
    }
  }
}

function drawCity(): void {
  // Dark skyline silhouette with hundreds of lit windows, back and front rows.
  const horizon = 860;
  // Back row (taller, hazier, deep purple).
  let x = -20;
  while (x < W + 20) {
    const w = 46 + Math.floor(rand() * 70);
    const h = 70 + Math.floor(rand() * 90);
    const top = horizon - h;
    fillRect(x, top, x + w, horizon, 34, 18, 62);
    // faint rooftop antenna on some towers
    if (rand() < 0.3) fillRect(x + Math.floor(w / 2), top - 22, x + Math.floor(w / 2) + 2, top, 34, 18, 62);
    x += w + 4 + Math.floor(rand() * 14);
  }
  // Front row (near-black) with lit windows.
  x = -10;
  while (x < W + 10) {
    const w = 60 + Math.floor(rand() * 90);
    const h = 110 + Math.floor(rand() * 110);
    const top = horizon - h;
    fillRect(x, top, x + w, horizon, 12, 8, 28);
    if (rand() < 0.35) fillRect(x + Math.floor(w / 2) - 1, top - 30, x + Math.floor(w / 2) + 1, top, 12, 8, 28);
    // windows: warm gold, some cool white
    for (let wy = top + 12; wy < horizon - 10; wy += 16) {
      for (let wx = x + 8; wx < x + w - 8; wx += 13) {
        if (rand() < 0.42) {
          const warm = rand() < 0.8;
          const r = warm ? 255 : 200;
          const g = warm ? 190 + Math.floor(rand() * 50) : 220;
          const b = warm ? 90 : 255;
          const a = 150 + Math.floor(rand() * 105);
          for (let dy = 0; dy < 6; dy++) {
            for (let dx = 0; dx < 5; dx++) {
              setPixel(wx + dx, wy + dy, r, g, b, a);
            }
          }
        }
      }
    }
    x += w + 6 + Math.floor(rand() * 18);
  }
  // Ground band below the skyline.
  fillRect(0, horizon, W, H, 10, 6, 24);
}

// One feather: a long glowing rotated ellipse with a brighter shaft tip.
function feather(cx: number, cy: number, len: number, wid: number, angle: number, r: number, g: number, b: number, a: number): void {
  ellipseRot(cx, cy, len, wid, angle, r, g, b, a, "add");
  const tipX = cx + Math.cos(angle) * len * 0.7;
  const tipY = cy + Math.sin(angle) * len * 0.7;
  ellipse(tipX, tipY, wid * 1.6, wid * 1.1, 255, 230, 150, Math.floor(a * 0.5), "add");
}

function drawPhoenix(): void {
  const cx = 512;
  const cy = 400;
  // Wide aura behind the bird.
  ellipse(cx, cy, 330, 260, 255, 110, 30, 30, "add");
  ellipse(cx, cy, 220, 180, 255, 160, 60, 46, "add");

  // Tail plumes: three long curling ribbons flowing down toward the skyline.
  const plumeCols: number[][] = [
    [255, 120, 30],
    [255, 170, 50],
    [230, 60, 90],
  ];
  for (let p = 0; p < 3; p++) {
    const dir = p - 1; // -1, 0, 1
    const col = plumeCols[p];
    for (let s = 0; s < 12; s++) {
      const t = s / 11;
      const px2 = cx + dir * (26 + t * 120) + Math.sin(t * 5 + p) * 22;
      const py2 = cy + 60 + t * 210;
      const w = 30 * (1 - t * 0.5);
      ellipse(px2, py2, w * 1.9, w, col[0], col[1], col[2], 170 - t * 60, "add");
    }
  }

  // Wings: broad layered arcs of feathers, sweeping up-out on both sides.
  // Each wing gets a soft mass underneath, then 3 rows of short wide feathers.
  for (const side of [-1, 1]) {
    const shoulderX = cx + side * 46;
    const shoulderY = cy + 10;
    // Wing mass: a big soft fan so the wing reads as a wing, not streaks.
    ellipseRot(shoulderX + side * 150, shoulderY - 70, 190, 95, side * -0.55, 255, 130, 40, 90, "add");
    ellipseRot(shoulderX + side * 130, shoulderY - 30, 170, 80, side * -0.25, 255, 90, 50, 80, "add");
    const rows: [number, number[]][] = [
      [0, [255, 210, 90]], // gold top row
      [1, [255, 140, 40]], // orange middle
      [2, [235, 60, 70]], // crimson lower
    ];
    for (const [row, col] of rows) {
      const n = 12 - row;
      for (let f = 0; f < n; f++) {
        const t = f / (n - 1);
        // Fan: feathers arc from near-vertical at the body to near-horizontal at the tip.
        const spread = side * (60 + t * 240);
        const fx = shoulderX + spread - side * row * 20;
        const fy = shoulderY - 20 - t * 130 + row * 44 + t * t * 40;
        const len = 58 - t * 16 - row * 5;
        const wid = 21 - row * 2;
        // Angle: feathers point outward-up; mirror by side.
        const a = side > 0 ? -1.1 + t * 1.0 : Math.PI + 1.1 - t * 1.0;
        feather(fx, fy, len, wid, a, col[0], col[1], col[2], 215 - row * 20);
      }
    }
  }

  // Body: defined silhouette first (paints a flame-shaped body over the sky),
  // then layered additive glow inside it so it reads as a bird, not a disc.
  ellipse(cx, cy + 30, 82, 108, 205, 62, 18, 215, "set");
  ellipse(cx, cy + 30, 78, 96, 255, 120, 30, 160, "add");
  ellipse(cx, cy + 30, 54, 74, 255, 180, 60, 200, "add");
  ellipse(cx, cy + 30, 32, 52, 255, 225, 140, 230, "add");
  // Chest highlight.
  ellipse(cx - 6, cy + 44, 16, 28, 255, 250, 210, 210, "add");

  // Neck + head rising above the body, beak pointing up-right.
  // Thick neck joins the head straight onto the body — no floating head.
  ellipse(cx + 12, cy - 62, 30, 56, 235, 90, 30, 220, "set");
  ellipse(cx + 12, cy - 62, 24, 48, 255, 180, 60, 210, "add");
  ellipse(cx + 22, cy - 102, 32, 25, 255, 210, 110, 235, "add");
  // Beak: bright gold wedge.
  ellipseRot(cx + 52, cy - 110, 24, 8, -0.5, 255, 230, 120, 240, "add");
  // Eye: white-hot dot with dark rim.
  ellipse(cx + 30, cy - 106, 7, 7, 255, 255, 255, 255, "add");
  ellipse(cx + 31, cy - 106, 3, 3, 30, 10, 20, 255, "set");
  // Small crest tuft on the back of the head, kept tight to the head.
  ellipse(cx - 6, cy - 122, 14, 8, 255, 180, 60, 200, "add");
}

function drawEmbers(): void {
  // 320 sparks streaming upward around the phoenix, fading as they rise.
  for (let n = 0; n < 320; n++) {
    const x = 180 + rand() * 664;
    const y = 180 + rand() * 640;
    const rise = (y - 180) / 640; // 0 top, 1 bottom
    const size = rand() < 0.25 ? 3 : rand() < 0.6 ? 2 : 1;
    const heat = rand();
    const r = 255;
    const g = heat < 0.5 ? 120 + Math.floor(heat * 160) : 200;
    const b = 40 + Math.floor(rand() * 60);
    const a = Math.floor(90 + (1 - rise) * 140);
    ellipse(x, y, size, size, r, g, b, a, "add");
    if (rand() < 0.12) ellipse(x, y, size * 3, size * 3, r, g, b, 40, "add");
  }
}

function drawFireworks(): void {
  // 3 starbursts: radial streaks of sparks.
  const bursts: [number, number, number, number[]][] = [
    [170, 210, 95, [255, 90, 160]],
    [856, 170, 110, [90, 200, 255]],
    [800, 350, 70, [255, 210, 90]],
  ];
  for (const [bx, by, rad, col] of bursts) {
    ellipse(bx, by, rad * 0.9, rad * 0.9, col[0], col[1], col[2], 26, "add");
    const rays = 26;
    for (let k = 0; k < rays; k++) {
      const ang = (k / rays) * Math.PI * 2 + rand() * 0.2;
      const len = rad * (0.55 + rand() * 0.45);
      for (let s = 0; s < 9; s++) {
        const t = s / 8;
        const x = bx + Math.cos(ang) * len * t;
        const y = by + Math.sin(ang) * len * t;
        const a = Math.floor(230 * (1 - t));
        ellipse(x, y, 4 - t * 2, 4 - t * 2, 255, 240, 200, a, "add");
      }
    }
    ellipse(bx, by, 10, 10, 255, 255, 255, 240, "add");
  }
}

function drawReflection(): void {
  // Mirrored glow on the ground/water below the skyline: vertical streaks + shimmer.
  for (let n = 0; n < 260; n++) {
    const x = rand() * W;
    const y = 866 + rand() * 150;
    const t = (y - 866) / 150;
    const len = 12 + rand() * 46;
    const warm = rand() < 0.75;
    const r = warm ? 255 : 120;
    const g = warm ? 130 + Math.floor(rand() * 60) : 80;
    const b = warm ? 50 : 160;
    const a = Math.floor(70 * (1 - t) + 12);
    ellipse(x, y, 3 + rand() * 3, len, r, g, b, a, "add");
  }
  // Horizontal shimmer lines catching the sun.
  for (let n = 0; n < 60; n++) {
    const y = 870 + Math.floor(rand() * 140);
    const x = Math.floor(rand() * W);
    const len = 20 + Math.floor(rand() * 90);
    for (let dx = 0; dx < len; dx++) {
      addPixel(x + dx, y, 255, 170, 80, 26);
    }
  }
}

function drawVignette(): void {
  // Darken the corners a touch so the centre bursts forward.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - 512) / 512;
      const dy = (y - 512) / 512;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.92) {
        const dark = Math.min(0.28, (d - 0.92) * 1.4);
        const i = (y * W + x) * 4;
        px[i] = Math.round(px[i] * (1 - dark));
        px[i + 1] = Math.round(px[i + 1] * (1 - dark));
        px[i + 2] = Math.round(px[i + 2] * (1 - dark));
      }
    }
  }
}

function main(): void {
  drawSky();
  drawSun();
  drawStars();
  drawCity();
  drawPhoenix();
  drawEmbers();
  drawFireworks();
  drawReflection();
  drawVignette();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outDir, { recursive: true });
  const png = encodePng(px, W, H);
  writeFileSync(join(outDir, "entry.png"), png);
}

main();

