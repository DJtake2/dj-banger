// Generates the Banger app icon (a vinyl record with a flame crown) as a 1024px RGBA PNG,
// with pure Node — no external rasteriser. Run: node make-icon.mjs → icon-source.png
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// multi-stop gradient
function grad(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      return mix(c0, c1, (t - p0) / (p1 - p0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

const BG = [[0, [36, 22, 64]], [1, [9, 8, 17]]]; // deep violet → near black
const FLAME = [[0, [255, 45, 40]], [0.45, [255, 130, 24]], [0.78, [255, 210, 62]], [1, [255, 245, 190]]];
const LABEL = [[0, [150, 130, 255]], [1, [90, 73, 224]]];

const cx = 512, cy = 548, R = 300; // record
const margin = 66, rad = 205;      // rounded-square

function inRounded(x, y) {
  const l = margin, r = S - margin, t = margin, b = S - margin;
  const dx = x < l + rad ? l + rad - x : x > r - rad ? x - (r - rad) : 0;
  const dy = y < t + rad ? t + rad - y : y > b - rad ? y - (b - rad) : 0;
  if (x < l || x > r || y < t || y > b) return false;
  return dx * dx + dy * dy <= rad * rad;
}

// Flame length as a function of angle (radians, screen space). Flames crown the TOP arc.
function flameLen(ang) {
  // ang: -PI..PI, top ≈ -PI/2. Map top arc [-170°,-10°] → taper 0..1 (tallest centre).
  let deg = (ang * 180) / Math.PI;
  if (deg > 0) return 0;                 // only upper half
  const lo = -172, hi = -8;
  if (deg < lo || deg > hi) return 0;
  const taper = Math.sin(((deg - lo) / (hi - lo)) * Math.PI); // 0 at ends, 1 mid
  const spikes = Math.pow(0.5 + 0.5 * Math.sin(ang * 9 + 1.2), 3);
  const spikes2 = Math.pow(0.5 + 0.5 * Math.sin(ang * 5 - 0.6), 2);
  return 168 * taper * (0.30 + 0.70 * (0.6 * spikes + 0.4 * spikes2));
}

function px(x, y) {
  if (!inRounded(x, y)) return [0, 0, 0, 0];
  let col = grad(BG, y / S);

  const dx = x - cx, dy = y - cy;
  const rr = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);

  // flame crown (outside the record body)
  if (rr > 282) {
    const L = flameLen(ang);
    if (L > 4 && rr < R + L) {
      const frac = (rr - 282) / (R + L - 282); // 0 at base → 1 at tip
      const fcol = grad(FLAME, 1 - frac * 0.98);
      let a = frac > 0.72 ? clamp((1 - frac) / 0.28, 0, 1) : 1; // fade at tips
      a *= 0.97;
      col = mix(col, fcol, a);
    }
  }

  // vinyl record body
  if (rr <= R) {
    let v = [14, 14, 20];
    // grooves
    const ring = (rr % 30);
    if (ring < 2.4 && rr > 118) v = [32, 32, 42];
    // outer rim highlight
    if (rr > R - 5) v = [42, 42, 54];
    col = v;
    // centre label
    if (rr <= 110) {
      col = grad(LABEL, rr / 110);
      if (rr > 104) col = [230, 226, 255];       // label rim
    }
    if (rr <= 15) col = [11, 9, 19];             // spindle hole
    // top sheen on the record
    if (dy < 0) {
      const sheen = clamp((-dy - 60) / 260, 0, 1) * 0.10;
      col = mix(col, [255, 255, 255], sheen * (1 - rr / R));
    }
  }

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
}

// 2x2 supersampling for smooth edges (flames, record circle, rounded corners).
const OFF = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [ox, oy] of OFF) {
      const p = px(x + ox, y + oy);
      // premultiply so transparent samples don't darken edges
      r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
    }
    const i = (y * S + x) * 4;
    if (a === 0) { buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; continue; }
    buf[i] = Math.round(r / a); buf[i + 1] = Math.round(g / a); buf[i + 2] = Math.round(b / a); buf[i + 3] = Math.round(a / 4);
  }
}

// ---- encode PNG (RGBA) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("./icon-source.png", import.meta.url), png);
console.log("wrote icon-source.png", png.length, "bytes");
