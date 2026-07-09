// MyDealer logo/ikon üreteci — saf Node (zlib). Lacivert zemin üzerinde beyaz konum iğnesi + mağaza noktası.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SS = 4; // süper-örnekleme (yumuşak kenar)

// ---- PNG kodlayıcı ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const cd = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd));
  return Buffer.concat([len, cd, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Geometri (512 referans uzayı) ----
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(Math.max(px, x + r), x + w - r), ry = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - rx, dy = py - ry; return dx * dx + dy * dy <= r * r;
}
function inCircle(px, py, cx, cy, r) { const dx = px - cx, dy = py - cy; return dx * dx + dy * dy <= r * r; }
function ring(px, py, cx, cy, r, w) { const d = Math.hypot(px - cx, py - cy); return d <= r && d >= r - w; }
function inRotRect(px, py, cx, cy, len, thick, angDeg) {
  const a = angDeg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  const dx = px - cx, dy = py - cy, lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
  return Math.abs(lx) <= len / 2 && Math.abs(ly) <= thick / 2;
}
// Konum iğnesi: üstte daire (cx,cy,r), alta doğru uç (tip noktası)
function inPin(px, py) {
  const cx = 256, cy = 218, r = 118, tipY = 408;
  if (inCircle(px, py, cx, cy, r)) return true;
  if (py > cy && py <= tipY) {
    // daireden uca daralan kama
    const t = (py - cy) / (tipY - cy);
    const half = r * 0.92 * (1 - t);
    return Math.abs(px - cx) <= half;
  }
  return false;
}

// Navigasyon rotası: başlangıç noktasından iğne ucuna kesik çizgiler
const ROUTE = (() => {
  const x1 = 92, y1 = 452, x2 = 240, y2 = 408; // başlangıç → iğne ucu altı
  const dashes = [];
  const n = 4, ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    dashes.push({ cx: x1 + (x2 - x1) * t, cy: y1 + (y2 - y1) * t, ang });
  }
  return dashes;
})();
function onRoute(ux, uy) {
  return ROUTE.some(d => inRotRect(ux, uy, d.cx, d.cy, 30, 15, d.ang));
}
function onStreet(ux, uy) {
  // hafif sokak ızgarası (harita hissi)
  const H = [126, 268, 410], V = [120, 296, 440];
  return H.some(yy => Math.abs(uy - yy) <= 3.2) || V.some(xx => Math.abs(ux - xx) <= 3.2);
}

function buildIcon(size, maskable) {
  const big = size * SS, S = big / 512;
  const buf = Buffer.alloc(big * big * 4);
  const top = [0x1d, 0x4e, 0x9e], bot = [0x0e, 0x24, 0x48]; // mavi → lacivert
  const corner = maskable ? 0 : 100 * S;
  for (let y = 0; y < big; y++) for (let x = 0; x < big; x++) {
    const ux = x / S, uy = y / S;
    const bg = maskable ? true : inRoundRect(x, y, 0, 0, big - 1, big - 1, corner);
    let r, g, b, a;
    if (!bg) { a = 0; r = g = b = 0; }
    else {
      const c = mix(top, bot, uy / 512); r = c[0]; g = c[1]; b = c[2]; a = 255;
      if (onStreet(ux, uy)) { r = Math.min(255, r + 26); g = Math.min(255, g + 26); b = Math.min(255, b + 30); } // sokaklar
      if (onRoute(ux, uy)) { r = 0x34; g = 0xe0; b = 0x8a; }                     // rota (yeşil kesik çizgi)
      if (ring(ux, uy, 92, 452, 26, 11)) { r = 0xff; g = 0xff; b = 0xff; }      // başlangıç halkası
      if (inPin(ux, uy)) {
        if (inCircle(ux, uy, 256, 218, 58)) { r = 0x0e; g = 0x8f; b = 0x6f; }   // iç nokta (yeşil = bayi)
        else { r = 0xff; g = 0xff; b = 0xff; }                                  // iğne gövdesi (beyaz)
      }
    }
    const o = (y * big + x) * 4;
    buf[o] = r | 0; buf[o + 1] = g | 0; buf[o + 2] = b | 0; buf[o + 3] = a;
  }
  // SS küçültme → antialias
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const o = ((y * SS + sy) * big + (x * SS + sx)) * 4, al = buf[o + 3];
      R += buf[o] * al; G += buf[o + 1] * al; B += buf[o + 2] * al; A += al;
    }
    const n = SS * SS, o = (y * size + x) * 4;
    out[o] = A ? Math.round(R / A) : 0; out[o + 1] = A ? Math.round(G / A) : 0;
    out[o + 2] = A ? Math.round(B / A) : 0; out[o + 3] = Math.round(A / n);
  }
  return encodePNG(size, size, out);
}

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon-192.png'), buildIcon(192, false));
fs.writeFileSync(path.join(dir, 'icon-512.png'), buildIcon(512, false));
fs.writeFileSync(path.join(dir, 'icon-maskable.png'), buildIcon(512, true));
console.log('icons written:', fs.readdirSync(dir).filter(f => f.endsWith('.png')));
