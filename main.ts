import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const W = 1024;
const H = 1024;
const HORIZON = 838;
const SEED = 0x51f7c0de;
const MAX_BYTES = 1048576;

type RGB = readonly [number, number, number];
type Stop = readonly [number, number, number, number];

const R = new Float32Array(W * H);
const G = new Float32Array(W * H);
const B = new Float32Array(W * H);

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);

function between(lo: number, hi: number): number {
  return lo + (hi - lo) * rnd();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function ramp(stops: Stop[], t: number): RGB {
  if (t <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  const last = stops[stops.length - 1];
  if (t >= last[0]) return [last[1], last[2], last[3]];
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i];
    if (t <= hi[0]) {
      const lo = stops[i - 1];
      const k = (t - lo[0]) / (hi[0] - lo[0]);
      return [lerp(lo[1], hi[1], k), lerp(lo[2], hi[2], k), lerp(lo[3], hi[3], k)];
    }
  }
  return [last[1], last[2], last[3]];
}

function scaleRGB(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function clearBuffer(): void {
  R.fill(0);
  G.fill(0);
  B.fill(0);
}

function addPx(x: number, y: number, r: number, g: number, b: number, k: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  R[i] += r * k;
  G[i] += g * k;
  B[i] += b * k;
}

function mulPx(x: number, y: number, k: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  R[i] *= k;
  G[i] *= k;
  B[i] *= k;
}

function tintPx(x: number, y: number, col: RGB, k: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  R[i] = lerp(R[i], col[0], k);
  G[i] = lerp(G[i], col[1], k);
  B[i] = lerp(B[i], col[2], k);
}

function glow(cx: number, cy: number, rad: number, col: RGB, gain: number, power: number): void {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const inv = 1 / rad;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = Math.pow(1 - Math.sqrt(d2), power);
      addPx(x, y, col[0], col[1], col[2], f * gain);
    }
  }
}

function glowE(cx: number, cy: number, rx: number, ry: number, col: RGB, gain: number, power: number): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = Math.pow(1 - Math.sqrt(d2), power);
      addPx(x, y, col[0], col[1], col[2], f * gain);
    }
  }
}

function softDot(cx: number, cy: number, rad: number, col: RGB, gain: number): void {
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  const inv = 1 / rad;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      const f = 1 - d * d;
      addPx(x, y, col[0], col[1], col[2], f * f * gain);
    }
  }
}

function hardDisc(cx: number, cy: number, rad: number, col: RGB, gain: number, feather: number): void {
  const x0 = Math.max(0, Math.floor(cx - rad - feather));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad + feather));
  const y0 = Math.max(0, Math.floor(cy - rad - feather));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad + feather));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const f = 1 - smoothstep(rad - feather, rad + feather, d);
      if (f <= 0) continue;
      addPx(x, y, col[0], col[1], col[2], f * gain);
    }
  }
}

const CRC_TABLE = (function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function paethPredict(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function packScanlines(rgba: Buffer, adaptive: boolean): Buffer {
  const stride = W * 4;
  const out = Buffer.alloc((stride + 1) * H);
  const prev = Buffer.alloc(stride);
  const cand: Buffer[] = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < H; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const o = y * (stride + 1);
    if (!adaptive) {
      out[o] = 0;
      row.copy(out, o + 1);
      row.copy(prev, 0);
      continue;
    }
    let bestType = 0;
    let bestCost = Infinity;
    for (let type = 0; type < 5; type++) {
      const buf = cand[type];
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? row[i - 4] : 0;
        const up = prev[i];
        const upLeft = i >= 4 ? prev[i - 4] : 0;
        let v = row[i];
        if (type === 1) v = (v - left) & 0xff;
        else if (type === 2) v = (v - up) & 0xff;
        else if (type === 3) v = (v - ((left + up) >> 1)) & 0xff;
        else if (type === 4) v = (v - paethPredict(left, up, upLeft)) & 0xff;
        buf[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
      }
    }
    out[o] = bestType;
    cand[bestType].copy(out, o + 1);
    row.copy(prev, 0);
  }
  return out;
}

function encodePNG(rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const first = zlib.deflateSync(packScanlines(rgba, false), { level: 9 });
  let idat = first;
  if (first.length + 128 > MAX_BYTES) {
    const adaptive = zlib.deflateSync(packScanlines(rgba, true), { level: 9 });
    if (adaptive.length < first.length) idat = adaptive;
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

const SKY_STOPS: Stop[] = [
  [0.0, 5, 3, 22],
  [0.12, 10, 6, 42],
  [0.26, 24, 9, 64],
  [0.4, 48, 13, 78],
  [0.52, 76, 17, 86],
  [0.62, 112, 22, 84],
  [0.7, 156, 34, 74],
  [0.78, 208, 62, 56],
  [0.84, 244, 108, 44],
  [0.89, 255, 158, 54],
  [0.94, 255, 202, 104],
  [1.0, 255, 232, 168],
];

const SUN_X = 512;
const SUN_Y = 786;
const SUN_R = 104;

function drawSky(): void {
  for (let y = 0; y < H; y++) {
    const t = y / (HORIZON - 1);
    const c = ramp(SKY_STOPS, clamp01(t));
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const i = rowBase + x;
      const vx = (x - SUN_X) / W;
      const vy = (y - SUN_Y) / H;
      const d = Math.sqrt(vx * vx + vy * vy);
      const halo = 0.34 * Math.pow(clamp01(1 - d * 1.85), 2.6);
      const band = 0.05 * Math.sin((y * 0.031 + x * 0.004) * 1.7 + y * 0.011);
      const grain = 1 + band;
      R[i] = c[0] * grain + 255 * halo;
      G[i] = c[1] * grain + 122 * halo;
      B[i] = c[2] * grain + 44 * halo;
    }
  }
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const deep = mixRGB([12, 8, 30], [4, 5, 20], clamp01(t * 1.4));
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const i = rowBase + x;
      R[i] = deep[0];
      G[i] = deep[1];
      B[i] = deep[2];
    }
  }
}

function drawSun(): void {
  glow(SUN_X, SUN_Y, 620, [255, 120, 32], 0.5, 2.1);
  glow(SUN_X, SUN_Y, 340, [255, 176, 60], 0.5, 1.9);
  glow(SUN_X, SUN_Y, 210, [255, 226, 150], 0.55, 2.4);
  hardDisc(SUN_X, SUN_Y, SUN_R, [255, 238, 186], 0.9, 26);
  hardDisc(SUN_X, SUN_Y, SUN_R * 0.8, [255, 250, 226], 0.8, 18);
  glow(SUN_X, SUN_Y, SUN_R * 1.6, [255, 208, 120], 0.28, 3.2);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.13;
    const len = 380 + (i % 5) * 46;
    const xx = SUN_X + Math.cos(a) * len;
    const yy = SUN_Y + Math.sin(a) * len * 0.34;
    if (yy > HORIZON) continue;
    glowE(xx, yy, len * 0.5, 7, [255, 154, 58], 0.055, 1.5);
  }
}

function drawStars(): void {
  for (let i = 0; i < 420; i++) {
    const x = between(0, W);
    const y = Math.pow(rnd(), 1.35) * (HORIZON - 120);
    const fade = 1 - smoothstep(HORIZON - 300, HORIZON - 40, y);
    if (fade <= 0.02) continue;
    const mag = Math.pow(rnd(), 2.6);
    const rad = 0.55 + mag * 2.2;
    const warm = rnd();
    const col: RGB = warm > 0.82 ? [255, 214, 178] : warm > 0.55 ? [196, 214, 255] : [236, 240, 255];
    softDot(x, y, rad * 1.9, col, (0.22 + mag * 0.85) * fade);
    if (mag > 0.62) {
      const spike = rad * (4 + mag * 7);
      glowE(x, y, spike, rad * 0.7, col, 0.16 * fade, 2.0);
      glowE(x, y, rad * 0.7, spike, col, 0.16 * fade, 2.0);
    }
  }
  for (let i = 0; i < 5; i++) {
    const x = between(60, W - 60);
    const y = between(40, 300);
    const len = between(26, 74);
    const a = between(-0.9, -0.35);
    for (let s = 0; s < 22; s++) {
      const t = s / 21;
      softDot(x + Math.cos(a) * len * t, y + Math.sin(a) * len * t, 1.5, [255, 248, 226], 0.5 * (1 - t));
    }
  }
}

type Building = { x: number; w: number; top: number; shade: number; windowSeed: number };

function buildSkyline(): Building[] {
  const list: Building[] = [];
  let x = -30;
  while (x < W + 30) {
    const w = between(26, 92);
    const tower = rnd() < 0.22;
    const h = tower ? between(150, 300) : between(40, 165);
    list.push({ x, w, top: HORIZON - h, shade: between(0.65, 1), windowSeed: between(0, 1000) });
    x += w + between(-6, 10);
  }
  return list;
}

function drawSkyline(list: Building[]): void {
  const bodyTop: RGB = [10, 8, 26];
  for (const b of list) {
    const x0 = Math.max(0, Math.floor(b.x));
    const x1 = Math.min(W - 1, Math.ceil(b.x + b.w));
    const base = Math.round(b.shade * 255);
    for (let y = Math.floor(b.top); y < HORIZON; y++) {
      if (y < 0) continue;
      const depth = clamp01((y - b.top) / 220);
      const rim = 1 - smoothstep(0, 3.2, y - b.top);
      const warm = 0.55 + 0.45 * (1 - depth);
      for (let x = x0; x <= x1; x++) {
        const edge = Math.min(x - b.x, b.x + b.w - x);
        if (edge < 0) continue;
        const dark = 0.5 + 0.5 * clamp01(edge / 2.4);
        const k = (base / 255) * dark;
        tintPx(x, y, bodyTop, 0.92 * k + 0.06);
        addPx(x, y, 120, 42, 26, rim * 0.5 * warm);
      }
    }
  }
  for (const b of list) {
    if (b.top > HORIZON - 190) continue;
    const mastX = b.x + b.w * 0.5;
    for (let y = Math.floor(b.top) - 1; y > b.top - 34; y--) {
      const k = 0.5 * (1 - (b.top - y) / 34);
      addPx(Math.round(mastX), y, 60, 30, 46, k);
    }
    softDot(mastX, b.top - 34, 2.4, [255, 92, 68], 0.8);
    glow(mastX, b.top - 34, 9, [255, 70, 60], 0.16, 2.2);
  }
}

function drawWindows(list: Building[]): void {
  for (const b of list) {
    const wr = mulberry32((b.windowSeed * 7919 + 13) | 0);
    const stepX = 7;
    const stepY = 11;
    const cols = Math.max(1, Math.floor((b.w - 9) / stepX));
    const rows = Math.max(1, Math.floor((HORIZON - b.top - 14) / stepY));
    const ox = b.x + 5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (wr() > 0.42) {
          wr();
          continue;
        }
        const lit = wr();
        const x = Math.round(ox + c * stepX);
        const y = Math.round(b.top + 8 + r * stepY);
        if (y >= HORIZON - 2 || x < 0 || x >= W) continue;
        const side = Math.abs(x - W * 0.5) / (W * 0.5);
        const cool = lit > 0.86;
        const col: RGB = cool ? [128, 206, 255] : lit > 0.36 ? [255, 196, 96] : [255, 224, 158];
        const gain = 0.3 + lit * 0.9 * (1 - side * 0.45);
        addPx(x, y, col[0], col[1], col[2], gain);
        if (gain > 0.7) addPx(x + 1, y, col[0], col[1], col[2], gain * 0.35);
      }
    }
  }
}

function firework(cx: number, cy: number, rad: number, spokes: number, tint: RGB, salt: number): void {
  const fr = mulberry32(salt);
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2 + fr() * 0.08;
    const len = rad * (0.72 + fr() * 0.4);
    const drop = 0.16 + fr() * 0.2;
    let px = cx;
    let py = cy;
    for (let k = 1; k <= 18; k++) {
      const t = k / 18;
      const x = cx + Math.cos(a) * len * t;
      const y = cy + Math.sin(a) * len * t + drop * len * t * t;
      const kk = Math.pow(1 - t, 1.7);
      addPx(Math.round(x), Math.round(y), tint[0], tint[1], tint[2], kk * 0.9);
      addPx(Math.round(x + 1), Math.round(y), tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7, kk * 0.3);
      if (k % 3 === 0) {
        addPx(Math.round((x + px) * 0.5), Math.round((y + py) * 0.5), tint[0], tint[1], tint[2], kk * 0.22);
      }
      px = x;
      py = y;
    }
  }
  glow(cx, cy, rad * 0.62, tint, 0.3, 2.4);
  hardDisc(cx, cy, 3.2, [255, 250, 240], 0.95, 2);
}

function drawFireworks(): void {
  firework(214, 196, 122, 46, [255, 208, 128], 0x2f1a);
  firework(818, 158, 150, 54, [255, 126, 168], 0x77c3);
  firework(662, 288, 84, 34, [176, 226, 255], 0x1d0b);
}

const BODY = { x: 512, y: 470 };

function bez(t: number, p0: number, p1: number, p2: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

type Spine = { xs: Float32Array; ys: Float32Array; ws: Float32Array; x0: number; y0: number; x1: number; y1: number; maxW: number };

function makeSpine(
  ax: number, ay: number, cx: number, cy: number, bx: number, by: number,
  w0: number, w1: number, steps: number,
): Spine {
  const n = steps + 1;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const ws = new Float32Array(n);
  let maxW = 0.8;
  for (let i = 0; i < n; i++) {
    const t = i / steps;
    const u = 1 - t;
    xs[i] = u * u * ax + 2 * u * t * cx + t * t * bx;
    ys[i] = u * u * ay + 2 * u * t * cy + t * t * by;
    const bulge = 0.42 + 0.58 * smoothstep(0, 0.16, t);
    const taper = Math.pow(1 - t, 0.62);
    ws[i] = Math.max(0.6, (w0 + (w1 - w0) * t) * bulge * taper);
    if (ws[i] > maxW) maxW = ws[i];
  }
  ws[steps] = 0.7;
  return {
    xs, ys, ws, maxW,
    x0: Math.min(ax, bx, cx) - maxW - 2,
    x1: Math.max(ax, bx, cx) + maxW + 2,
    y0: Math.min(ay, by, cy) - maxW - 2,
    y1: Math.max(ay, by, cy) + maxW + 2,
  };
}

function drawFeather(sp: Spine, edge: RGB, body: RGB, core: RGB, opac: number, lift: number): void {
  const n = sp.xs.length;
  const bx0 = Math.max(0, Math.floor(sp.x0));
  const bx1 = Math.min(W - 1, Math.ceil(sp.x1));
  const by0 = Math.max(0, Math.floor(sp.y0));
  const by1 = Math.min(H - 1, Math.ceil(sp.y1));
  for (let y = by0; y <= by1; y++) {
    const py = y + 0.5;
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5;
      let best = 1e9;
      let bestT = 0;
      for (let s = 0; s < n - 1; s++) {
        const ax = sp.xs[s];
        const ay = sp.ys[s];
        const vx = sp.xs[s + 1] - ax;
        const vy = sp.ys[s + 1] - ay;
        const wx = px - ax;
        const wy = py - ay;
        const dd = vx * vx + vy * vy;
        let t = dd > 1e-6 ? (wx * vx + wy * vy) / dd : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = wx - vx * t;
        const ey = wy - vy * t;
        const d = ex * ex + ey * ey;
        if (d < best) {
          best = d;
          bestT = s + t;
        }
      }
      const t = bestT / (n - 1);
      const idx = Math.min(n - 1, Math.round(bestT));
      const w = sp.ws[idx];
      const dist = Math.sqrt(best);
      const u = dist / (w * 1.16 + 0.7);
      if (u > 1) continue;
      const a = 1 - smoothstep(0.7, 1, u);
      if (a <= 0.004) continue;
      const k = a * opac;
      const m = 1 - smoothstep(0.06, 0.9, u);
      const warm = clamp01(t * 1.22);
      const cr = lerp(lerp(edge[0], body[0], m), core[0], warm * 0.42);
      const cg = lerp(lerp(edge[1], body[1], m), core[1], warm * 0.42);
      const cb = lerp(lerp(edge[2], body[2], m), core[2], warm * 0.42);
      const i = y * W + x;
      const keep = 1 - k * 0.94;
      R[i] = R[i] * keep + cr * k;
      G[i] = G[i] * keep + cg * k;
      B[i] = B[i] * keep + cb * k;
      const spike = Math.pow(1 - u, 3.2) * a;
      R[i] += core[0] * spike * lift;
      G[i] += core[1] * spike * lift;
      B[i] += core[2] * spike * lift;
      const rim = smoothstep(0.55, 0.95, u) * smoothstep(1, 0.88, u);
      R[i] += edge[0] * rim * 0.3;
      G[i] += edge[1] * rim * 0.26;
      B[i] += edge[2] * rim * 0.2;
      if (t > 0.9 && a > 0.5) {
        const tipGlow = (t - 0.9) * 6 * a;
        R[i] += core[0] * tipGlow * 0.45;
        G[i] += core[1] * tipGlow * 0.4;
        B[i] += core[2] * tipGlow * 0.3;
      }
    }
  }
}

const GOLD: RGB = [255, 210, 108];
const AMBER: RGB = [255, 156, 54];
const CRIMSON: RGB = [250, 62, 62];
const DEEP_RED: RGB = [166, 26, 58];
const ROSE: RGB = [255, 118, 148];
const WHITE_HOT: RGB = [255, 250, 226];

function shadeFeather(sp: Spine, k: number): void {
  const n = sp.xs.length;
  const bx0 = Math.max(0, Math.floor(sp.x0));
  const bx1 = Math.min(W - 1, Math.ceil(sp.x1));
  const by0 = Math.max(0, Math.floor(sp.y0));
  const by1 = Math.min(H - 1, Math.ceil(sp.y1));
  for (let y = by0; y <= by1; y++) {
    const py = y + 0.5;
    for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5;
      let best = 1e9;
      let bestIdx = 0;
      for (let s = 0; s < n - 1; s++) {
        const ax = sp.xs[s];
        const ay = sp.ys[s];
        const vx = sp.xs[s + 1] - ax;
        const vy = sp.ys[s + 1] - ay;
        const wx = px - ax;
        const wy = py - ay;
        const dd = vx * vx + vy * vy;
        let t = dd > 1e-6 ? (wx * vx + wy * vy) / dd : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = wx - vx * t;
        const ey = wy - vy * t;
        const d = ex * ex + ey * ey;
        if (d < best) {
          best = d;
          bestIdx = s + t;
        }
      }
      const idx = Math.min(n - 1, Math.round(bestIdx));
      const u = Math.sqrt(best) / (sp.ws[idx] * 1.16 + 0.8);
      if (u > 1) continue;
      const f = (1 - smoothstep(0.72, 1, u)) * k;
      const i = y * W + x;
      R[i] = lerp(R[i], 34, f * 0.55);
      G[i] = lerp(G[i], 10, f * 0.62);
      B[i] = lerp(B[i], 26, f * 0.55);
    }
  }
}

function paletteAt(list: RGB[], f: number): RGB {
  if (list.length === 1) return list[0];
  const g = clamp01(f) * (list.length - 1);
  const i0 = Math.min(list.length - 1, Math.floor(g));
  const i1 = Math.min(list.length - 1, i0 + 1);
  return mixRGB(list[i0], list[i1], g - i0);
}

function reachLimit(wx: number, wy: number, dx: number, dy: number, want: number): number {
  let r = want;
  const margin = 18;
  const loX = margin;
  const hiX = W - margin;
  const loY = 26;
  const hiY = HORIZON - 26;
  if (dx > 1e-6) r = Math.min(r, (hiX - wx) / dx);
  if (dx < -1e-6) r = Math.min(r, (loX - wx) / dx);
  if (dy > 1e-6) r = Math.min(r, (hiY - wy) / dy);
  if (dy < -1e-6) r = Math.min(r, (loY - wy) / dy);
  return Math.max(24, r);
}

function blade(
  ax: number, ay: number, bx: number, by: number,
  bow: number, w: number, pal: RGB[], fr: number, tipGlow: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = ax + dx * 0.5 + nx * bow * len;
  const my = ay + dy * 0.5 + ny * bow * len;
  const sp = makeSpine(ax, ay, mx, my, bx, by, w, w * 0.14, 20);
  shadeFeather(sp, 0.9);
  const c0 = paletteAt(pal, clamp01(fr * 0.55));
  const c1 = paletteAt(pal, clamp01(0.4 + fr * 0.5));
  drawFeather(sp, c0, c1, WHITE_HOT, 0.985, 0.32);
  const n = sp.xs.length;
  glow(sp.xs[n - 1], sp.ys[n - 1], w * 1.5, GOLD, 0.18 + tipGlow, 2.4);
}

type Pt = { x: number; y: number };

function fillPolygon(pts: Pt[], tint: (x: number, y: number) => RGB, alpha: number): void {
  let loY = Infinity;
  let hiY = -Infinity;
  for (const p of pts) {
    if (p.y < loY) loY = p.y;
    if (p.y > hiY) hiY = p.y;
  }
  const y0 = Math.max(0, Math.floor(loY));
  const y1 = Math.min(H - 1, Math.ceil(hiY));
  const cov = new Float32Array(W);
  const xs: number[] = [];
  const n = pts.length;
  for (let y = y0; y <= y1; y++) {
    cov.fill(0);
    let touched = false;
    for (let s = 0; s < 4; s++) {
      const sy = y + (s + 0.5) * 0.25;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = pts[j];
        const b = pts[i];
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
          xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let xa = xs[k] < 0 ? 0 : xs[k];
        let xb = xs[k + 1] > W ? W : xs[k + 1];
        if (xb <= 0 || xa >= W || xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        touched = true;
        if (ia === ib) {
          cov[ia] += (xb - xa) * 0.25;
          continue;
        }
        cov[ia] += (ia + 1 - xa) * 0.25;
        for (let x = ia + 1; x < ib; x++) cov[x] += 0.25;
        if (ib < W) cov[ib] += (xb - ib) * 0.25;
      }
    }
    if (!touched) continue;
    const base = y * W;
    for (let x = 0; x < W; x++) {
      const c = cov[x];
      if (c <= 0.004) continue;
      const col = tint(x + 0.5, y + 0.5);
      const k = (c > 1 ? 1 : c) * alpha;
      const i = base + x;
      R[i] = R[i] * (1 - k) + col[0] * k;
      G[i] = G[i] * (1 - k) + col[1] * k;
      B[i] = B[i] * (1 - k) + col[2] * k;
    }
  }
}

type WingGeom = {
  side: number;
  wrist: Pt;
  phi0: number;
  phi1: number;
  count: number;
  reach: (u: number) => number;
  hotNear: RGB;
  midCol: RGB;
  farCol: RGB;
  tipCol: RGB;
};

function wingSilhouette(g: WingGeom, cx: number, cy: number, scale: number): Pt[] {
  const pts: Pt[] = [];
  const rootA: Pt = { x: cx + g.side * 26 * scale, y: cy - 104 * scale };
  const ctl: Pt = { x: cx + g.side * 132 * scale, y: cy - 216 * scale };
  const wrist: Pt = { x: g.wrist.x, y: g.wrist.y };
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push({ x: bez(t, rootA.x, ctl.x, wrist.x), y: bez(t, rootA.y, ctl.y, wrist.y) });
  }
  const N = 13;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const phi = g.phi0 + u * (g.phi1 - g.phi0);
    const dx = g.side * Math.sin(phi);
    const dy = -Math.cos(phi);
    const r = reachLimit(wrist.x, wrist.y, dx, dy, g.reach(u) * scale);
    pts.push({ x: wrist.x + dx * r, y: wrist.y + dy * r });
    if (i < N) {
      const phi2 = g.phi0 + (u + 0.5 / N) * (g.phi1 - g.phi0);
      const dx2 = g.side * Math.sin(phi2);
      const dy2 = -Math.cos(phi2);
      const r2 = reachLimit(wrist.x, wrist.y, dx2, dy2, g.reach(u + 0.5 / N) * scale * 0.74);
      pts.push({ x: wrist.x + dx2 * r2, y: wrist.y + dy2 * r2 });
    }
  }
  const tailEnd = pts[pts.length - 1];
  const ctl2: Pt = { x: cx + g.side * 168 * scale, y: cy + 54 * scale };
  const rootB: Pt = { x: cx + g.side * 32 * scale, y: cy + 104 * scale };
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    pts.push({ x: bez(t, tailEnd.x, ctl2.x, rootB.x), y: bez(t, tailEnd.y, ctl2.y, rootB.y) });
  }
  return pts;
}

function wingTint(g: WingGeom): (x: number, y: number) => RGB {
  const wx = g.wrist.x;
  const wy = g.wrist.y;
  return (x: number, y: number): RGB => {
    const vx = (x - wx) * g.side;
    const vy = y - wy;
    const r = Math.sqrt(vx * vx + vy * vy) || 1;
    const phi = Math.atan2(vx, -vy);
    const u = clamp01((phi - g.phi0) / (g.phi1 - g.phi0));
    const L = g.reach(u);
    const t = clamp01(r / Math.max(1, L));
    let base: RGB;
    if (t < 0.24) base = mixRGB(g.hotNear, g.midCol, t / 0.24);
    else if (t < 0.56) base = mixRGB(g.midCol, g.midCol, 0);
    else if (t < 0.82) base = mixRGB(g.midCol, g.farCol, (t - 0.56) / 0.26);
    else base = mixRGB(g.farCol, g.tipCol, (t - 0.82) / 0.18);
    if (t >= 0.24 && t < 0.56) base = mixRGB(g.midCol, g.farCol, ((t - 0.24) / 0.32) * 0.55);
    const gf = u * (g.count - 1);
    const frac = gf - Math.floor(gf);
    const edgeDist = Math.min(frac, 1 - frac);
    const crease = 1 - smoothstep(0.0, 0.17, edgeDist);
    const rachis = 1 - smoothstep(0.0, 0.08, Math.abs(frac - 0.5));
    const creaseK = crease * smoothstep(0.1, 0.3, t) * 0.62;
    let cr = base[0] * (1 - creaseK);
    let cg = base[1] * (1 - creaseK);
    let cb = base[2] * (1 - creaseK);
    const rk = rachis * (1 - t) * 0.3;
    cr += 255 * rk;
    cg += 208 * rk;
    cb += 132 * rk;
    const rim = smoothstep(0.9, 1, t);
    cr += 255 * rim * 0.5;
    cg += 196 * rim * 0.36;
    cb += 104 * rim * 0.18;
    return [cr, cg, cb];
  };
}

function wing(side: number): void {
  const cx = BODY.x;
  const cy = BODY.y;
  const reach = (u: number) => 176 + 208 * Math.sin(Math.PI * (0.14 + 0.76 * u));

  const back: WingGeom = {
    side,
    wrist: { x: cx + side * 250, y: cy - 268 },
    phi0: -0.12, phi1: 1.26, count: 13,
    reach: (u) => reach(u) * 1.1,
    hotNear: [214, 58, 44], midCol: [226, 62, 46], farCol: [150, 26, 52], tipCol: [96, 16, 44],
  };
  fillPolygon(wingSilhouette(back, cx, cy, 1), wingTint(back), 0.97);

  const main: WingGeom = {
    side,
    wrist: { x: cx + side * 236, y: cy - 262 },
    phi0: -0.14, phi1: 1.2, count: 13,
    reach,
    hotNear: [255, 244, 196], midCol: [255, 178, 64], farCol: [252, 92, 52], tipCol: [176, 26, 58],
  };
  fillPolygon(wingSilhouette(main, cx, cy, 0.9), wingTint(main), 0.98);

  const covert: WingGeom = {
    side,
    wrist: { x: cx + side * 150, y: cy - 190 },
    phi0: -0.2, phi1: 1.02, count: 9,
    reach: (u) => 118 + 102 * Math.sin(Math.PI * (0.2 + 0.7 * u)),
    hotNear: [255, 252, 226], midCol: [255, 226, 140], farCol: [255, 162, 62], tipCol: [224, 74, 48],
  };
  fillPolygon(wingSilhouette(covert, cx, cy, 0.62), wingTint(covert), 0.97);

  const arm = makeSpine(cx + side * 40, cy - 26, cx + side * 190, cy - 190, cx + side * 250, cy - 268, 46, 15, 26);
  shadeFeather(arm, 0.4);
  drawFeather(arm, [150, 20, 48], [255, 118, 48], AMBER, 0.95, 0.24);

  glowE(cx + side * 236, cy - 250, 120, 90, [255, 148, 62], 0.22, 1.9);
  glowE(cx + side * 150, cy - 160, 110, 86, [255, 176, 78], 0.2, 1.9);
  glowE(cx + side * 60, cy - 40, 96, 84, [255, 196, 110], 0.2, 2.0);
  for (let i = 0; i < 9; i++) {
    const u = i / 8;
    const phi = main.phi0 + u * (main.phi1 - main.phi0);
    const dx = side * Math.sin(phi);
    const dy = -Math.cos(phi);
    const r = reachLimit(main.wrist.x, main.wrist.y, dx, dy, reach(u) * 0.9);
    glow(main.wrist.x + dx * r, main.wrist.y + dy * r, 30, GOLD, 0.22, 2.3);
  }
}

function tail(): void {
  for (let i = 0; i < 7; i++) {
    const f = (i - 3) / 3;
    const sx = BODY.x + f * 15;
    const sy = BODY.y + 116;
    const spread = f * 168 + 16 * Math.sin(i * 1.9);
    const drop = 300 - Math.abs(f) * 74;
    const tipX = BODY.x + spread + 34 * Math.sin(i * 1.3);
    const tipY = sy + drop;
    const cx = BODY.x + spread * 0.55 + 44 * Math.sin(i * 2.2);
    const cy = sy + drop * 0.56;
    const edge: RGB = i % 3 === 0 ? DEEP_RED : i % 3 === 1 ? CRIMSON : AMBER;
    const midc: RGB = i % 3 === 0 ? CRIMSON : i % 3 === 1 ? AMBER : GOLD;
    const sp = makeSpine(sx, sy, cx, cy, tipX, tipY, 17 - Math.abs(f) * 4, 4, 20);
    drawFeather(sp, edge, midc, WHITE_HOT, 0.97, 0.55);
    for (let b = 0; b < 7; b++) {
      const t = 0.24 + (b / 6) * 0.72;
      const bx = bez(t, sx, cx, tipX);
      const by = bez(t, sy, cy, tipY);
      const dirn = f >= 0 ? 1 : -1;
      const bl = 26 + 30 * Math.sin(Math.PI * t);
      const bsp = makeSpine(
        bx, by, bx + dirn * bl * 0.55, by + 14, bx + dirn * bl, by + bl * 0.42,
        7 * (1 - t * 0.3), 2, 8,
      );
      drawFeather(bsp, edge, midc, GOLD, 0.8, 0.34);
    }
    for (let s = 0; s < 10; s++) {
      const t = s / 9;
      softDot(bez(t, sx, cx, tipX) + 9, bez(t, sy, cy, tipY), 2.8, GOLD, 0.3 * (1 - t * 0.5));
    }
  }
}

function body(): void {
  glowE(BODY.x, BODY.y + 20, 250, 330, [255, 104, 38], 0.26, 2.2);
  glowE(BODY.x, BODY.y - 20, 130, 210, [255, 176, 74], 0.26, 2.3);

  const torso = makeSpine(BODY.x, BODY.y - 96, BODY.x - 6, BODY.y - 4, BODY.x + 4, BODY.y + 108, 62, 30, 24);
  shadeFeather(torso, 0.55);
  drawFeather(torso, [128, 16, 44], [255, 120, 48], AMBER, 1, 0.16);

  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const y = BODY.y - 74 + t * 176;
    const prof = Math.sin(Math.PI * Math.pow(clamp01(t * 0.85 + 0.12), 0.6));
    const w = 42 * prof * (1 - t * 0.24) + 3;
    const h = 9 - t * 3.4;
    const col: RGB = t < 0.3 ? WHITE_HOT : t < 0.62 ? GOLD : AMBER;
    glowE(BODY.x - w * 0.18, y, w * 0.62, h, col, 0.5 - t * 0.22, 1.5);
    glowE(BODY.x - w * 0.52, y + 2, w * 0.3, h * 0.62, CRIMSON, 0.3 - t * 0.12, 1.8);
  }
  for (let i = 0; i < 5; i++) {
    const y = BODY.y + 16 + i * 24;
    const w = 62 - i * 8;
    const sp = makeSpine(BODY.x - w * 0.5, y, BODY.x, y + 18, BODY.x + w * 0.5, y - 6, 9, 4, 10);
    drawFeather(sp, [140, 18, 46], AMBER, GOLD, 0.9, 0.3);
  }

  const hx = BODY.x + 2;
  const hy = BODY.y - 112;
  glow(hx, hy, 132, [255, 208, 124], 0.34, 2.2);
  const neck = makeSpine(BODY.x, BODY.y - 58, BODY.x + 2, BODY.y - 86, hx, hy + 16, 40, 24, 8);
  shadeFeather(neck, 0.4);
  drawFeather(neck, [132, 18, 46], AMBER, WHITE_HOT, 0.98, 0.24);
  hardDisc(hx, hy, 28, [226, 84, 40], 1, 4);
  hardDisc(hx - 1, hy - 2, 23, [255, 186, 82], 0.96, 6);
  hardDisc(hx - 2, hy - 4, 15, [255, 244, 198], 0.95, 5);

  const beak: RGB = [255, 188, 66];
  for (let i = 0; i < 22; i++) {
    const t = i / 21;
    const bx = Math.round(hx + 18 + t * 30);
    const by = Math.round(hy + 2 + t * 10);
    addPx(bx, by, beak[0], beak[1], beak[2], 0.95);
    addPx(bx, by - 1, 255, 226, 148, 0.4);
    addPx(bx, by + 1, 132, 36, 22, 0.5);
  }
  addPx(hx + 6, hy - 6, 28, 8, 20, 0.96);
  addPx(hx + 7, hy - 5, 255, 250, 232, 0.95);
  addPx(hx + 9, hy - 5, 120, 20, 30, 0.6);

  const crestA: RGB[] = [[255, 96, 54], GOLD, WHITE_HOT];
  for (let i = 0; i < 12; i++) {
    const f = i / 11;
    const a = -1.24 - f * 0.9;
    const ridge = i % 2 === 0 ? crestA : [[255, 120, 52], AMBER, GOLD];
    const ax2 = hx - 4;
    const ay2 = hy - 20;
    const len = 76 + 46 * Math.sin(Math.PI * (0.2 + f * 0.7));
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    blade(ax2, ay2, ax2 + dx * len, ay2 + dy * len * 0.86, 0.06, 8 - f * 2, ridge, f, 0.34);
  }
  for (let i = 0; i < 7; i++) {
    const f = i / 6;
    const a = 1.62 + f * 1.1;
    const len = 48 + 34 * Math.sin(Math.PI * (0.25 + f * 0.6));
    const ax2 = hx - 6;
    const ay2 = hy + 14;
    blade(ax2, ay2, ax2 + Math.cos(a - 0.4) * len, ay2 + Math.sin(a - 0.4) * len, -0.05, 7 - f * 2, [[255, 116, 50], AMBER, GOLD], f, 0.26);
  }
}

function halo(): void {
  const cx = BODY.x;
  const cy = BODY.y + 8;
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + 0.09;
    const len = i % 2 === 0 ? 470 : 330;
    const col: RGB = i % 3 === 0 ? GOLD : AMBER;
    glowE(cx + Math.cos(a) * len * 0.55, cy + Math.sin(a) * len * 0.5, len * 0.42, 5, col, 0.03, 1.4);
  }
  glow(cx, cy, 430, [255, 140, 60], 0.14, 2.6);
}

function embers(): void {
  for (let i = 0; i < 300; i++) {
    const a = between(0, Math.PI * 2);
    const rr = Math.pow(rnd(), 0.55);
    const x = BODY.x + Math.cos(a) * rr * 300;
    const y = BODY.y + 120 + Math.sin(a) * rr * 220 - Math.pow(rnd(), 0.7) * 620;
    if (y < 8 || y > HORIZON + 20) continue;
    const mag = rnd();
    const col: RGB = mag > 0.7 ? WHITE_HOT : mag > 0.35 ? GOLD : AMBER;
    const rad = 0.7 + mag * 2.3;
    for (let s = 0; s < 5; s++) {
      const t = s / 4;
      softDot(x + Math.sin(t * 2.4 + i) * 5, y + t * (6 + mag * 22), rad * (1 - t * 0.4), col, 0.3 * (1 - t * 0.75));
    }
    if (mag > 0.8) glow(x, y, 11, col, 0.1, 2.2);
  }
}

function reflect(): void {
  for (let y = HORIZON; y < H; y++) {
    const d = y - HORIZON;
    const k = 0.62 * Math.pow(1 - d / (H - HORIZON), 1.25);
    for (let x = 0; x < W; x++) {
      const wob = Math.sin(d * 0.085 + x * 0.017) * (2 + d * 0.02) + Math.sin(x * 0.043 + d * 0.021) * 1.6;
      const sx = Math.min(W - 1, Math.max(0, Math.round(x + wob)));
      const sy = Math.max(0, HORIZON - 1 - Math.round(d * 0.92 + wob * 0.4));
      const si = sy * W + sx;
      const i = y * W + x;
      const w = k * (0.72 + 0.28 * Math.sin(x * 0.011 + d * 0.06));
      R[i] = lerp(R[i], R[si] * 0.86, w);
      G[i] = lerp(G[i], G[si] * 0.82, w);
      B[i] = lerp(B[i], B[si] * 0.9, w);
    }
  }
  for (let y = HORIZON; y < H - 4; y++) {
    const d = y - HORIZON;
    if (d % 7 !== 0) continue;
    const f = Math.pow(1 - d / (H - HORIZON), 1.1);
    for (let x = 0; x < W; x++) {
      const s = Math.sin(x * 0.21 + y * 0.71 + Math.floor(x / 46) * 2.3);
      if (s < 0.86) continue;
      const nearSun = 1 - Math.min(1, Math.abs(x - SUN_X) / 300);
      addPx(x, y, 255, 190, 110, 0.14 * f * (0.3 + nearSun));
    }
  }
}

function tonemap(): Buffer {
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, o = 0; i < W * H; i++, o += 4) {
    const x = i % W;
    const y = (i / W) | 0;
    const vign = 1 - 0.28 * Math.pow(Math.max(Math.abs(x - W / 2) / (W / 2), Math.abs(y - H / 2) / (H / 2)), 2.4);
    for (let c = 0; c < 3; c++) {
      let v = (c === 0 ? R[i] : c === 1 ? G[i] : B[i]) * vign;
      if (v < 0) v = 0;
      const knee = 214;
      if (v > knee) v = knee + (v - knee) * 0.62;
      rgba[o + c] = v > 255 ? 255 : v < 0 ? 0 : Math.round(v);
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}

function compose(): Buffer {
  clearBuffer();
  drawSky();
  drawSun();
  drawStars();
  drawFireworks();
  const skyline = buildSkyline();
  drawSkyline(skyline);
  drawWindows(skyline);
  halo();
  for (const side of [-1, 1]) wing(side);
  tail();
  body();
  embers();
  reflect();
  return tonemap();
}

function main(): void {
  const dir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(dir, { recursive: true });
  const png = encodePNG(compose());
  fs.writeFileSync(path.join(dir, "entry.png"), png);
  process.stdout.write(`wrote ${path.join(dir, "entry.png")} (${png.length} bytes)\n`);
}

main();
