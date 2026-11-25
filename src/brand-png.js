'use strict';

const PALETTE = new Uint8Array([
  7, 26, 18,
  13, 47, 31,
  75, 220, 151,
  244, 255, 248
]);

const GLYPHS = {
  A:'01110/10001/10001/11111/10001/10001/10001',
  B:'11110/10001/10001/11110/10001/10001/11110',
  C:'01111/10000/10000/10000/10000/10000/01111',
  D:'11110/10001/10001/10001/10001/10001/11110',
  E:'11111/10000/10000/11110/10000/10000/11111',
  F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01111',
  H:'10001/10001/10001/11111/10001/10001/10001',
  I:'11111/00100/00100/00100/00100/00100/11111',
  J:'00111/00010/00010/00010/10010/10010/01100',
  K:'10001/10010/10100/11000/10100/10010/10001',
  L:'10000/10000/10000/10000/10000/10000/11111',
  M:'10001/11011/10101/10101/10001/10001/10001',
  N:'10001/11001/10101/10011/10001/10001/10001',
  O:'01110/10001/10001/10001/10001/10001/01110',
  P:'11110/10001/10001/11110/10000/10000/10000',
  Q:'01110/10001/10001/10001/10101/10010/01101',
  R:'11110/10001/10001/11110/10100/10010/10001',
  S:'01111/10000/10000/01110/00001/00001/11110',
  T:'11111/00100/00100/00100/00100/00100/00100',
  U:'10001/10001/10001/10001/10001/10001/01110',
  V:'10001/10001/10001/10001/10001/01010/00100',
  W:'10001/10001/10001/10101/10101/10101/01010',
  X:'10001/10001/01010/00100/01010/10001/10001',
  Y:'10001/10001/01010/00100/00100/00100/00100',
  Z:'11111/00001/00010/00100/01000/10000/11111',
  '.':'00000/00000/00000/00000/00000/00110/00110',
  '-':'00000/00000/00000/11111/00000/00000/00000'
};

function put32(out, offset, value) {
  out[offset] = (value >>> 24) & 255;
  out[offset + 1] = (value >>> 16) & 255;
  out[offset + 2] = (value >>> 8) & 255;
  out[offset + 3] = value & 255;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function chunk(name, data) {
  const type = new Uint8Array(4);
  for (let i = 0; i < 4; i++) type[i] = name.charCodeAt(i);
  const crcData = concat([type, data]);
  const out = new Uint8Array(12 + data.length);
  put32(out, 0, data.length);
  out.set(type, 4);
  out.set(data, 8);
  put32(out, 8 + data.length, crc32(crcData));
  return out;
}

function zlibStored(data) {
  const blocks = Math.ceil(data.length / 65535);
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let p = 2;
  for (let start = 0; start < data.length; start += 65535) {
    const length = Math.min(65535, data.length - start);
    out[p++] = start + length >= data.length ? 1 : 0;
    out[p++] = length & 255; out[p++] = (length >>> 8) & 255;
    const inverse = (~length) & 0xffff;
    out[p++] = inverse & 255; out[p++] = (inverse >>> 8) & 255;
    out.set(data.subarray(start, start + length), p);
    p += length;
  }
  const sum = adler32(data);
  out[p++] = sum >>> 24; out[p++] = (sum >>> 16) & 255;
  out[p++] = (sum >>> 8) & 255; out[p++] = sum & 255;
  return out.subarray(0, p);
}

function encodePng(width, height, pixels) {
  const stride = Math.ceil(width / 4);
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + (x >> 2)] |= (pixels[y * width + x] & 3) << (6 - ((x & 3) * 2));
    }
  }
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, width); put32(ihdr, 4, height);
  ihdr[8] = 2; ihdr[9] = 3;
  return concat([
    new Uint8Array([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', PALETTE),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0))
  ]);
}

function canvas(width, height) {
  const pixels = new Uint8Array(width * height);
  const set = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[y * width + x] = color;
  };
  const rect = (x, y, w, h, color) => {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w)), y1 = Math.min(height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) pixels.fill(color, yy * width + x0, yy * width + x1);
  };
  const line = (x0, y0, x1, y1, color, thickness = 1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const radius = Math.max(0, Math.floor((thickness - 1) / 2));
    let guard = 0;
    while (true) {
      for (let oy = -radius; oy <= radius; oy++)
        for (let ox = -radius; ox <= radius; ox++) set(x0 + ox, y0 + oy, color);
      if (x0 === x1 && y0 === y1) break;
      if (++guard > width + height + 10) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const ring = (cx, cy, radius, color) => {
    for (let degree = 0; degree < 360; degree += 0.5) {
      const angle = degree * Math.PI / 180;
      set(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, color);
    }
  };
  const disc = (cx, cy, radius, color) => {
    for (let y = -radius; y <= radius; y++)
      for (let x = -radius; x <= radius; x++)
        if (x * x + y * y <= radius * radius) set(cx + x, cy + y, color);
  };
  const text = (value, x, y, scale, color) => {
    let cursor = x;
    for (const ch of value) {
      const glyph = GLYPHS[ch];
      if (glyph) {
        const rows = glyph.split('/');
        for (let yy = 0; yy < 7; yy++)
          for (let xx = 0; xx < 5; xx++)
            if (rows[yy][xx] === '1') rect(cursor + xx * scale, y + yy * scale, scale, scale, color);
      }
      cursor += 6 * scale;
    }
  };
  return { pixels, set, rect, line, ring, disc, text };
}

function makeOgImagePng() {
  const width = 1200, height = 630;
  const c = canvas(width, height);
  const { rect, line, ring, disc, text } = c;
  // Deep forest-green background and restrained network/orbital detailing.
  for (let x = 0; x < width; x += 3) line(x, 0, x, height - 1, x < 470 ? 1 : 0, 1);
  ring(285, 315, 218, 1); ring(285, 315, 252, 1); ring(285, 315, 286, 1);
  line(0, 145, 500, 500, 1, 2);
  line(12, 530, 450, 72, 1, 2);
  line(830, 0, 1190, 350, 1, 2);
  line(900, 625, 1195, 330, 1, 2);
  // Brand tile and geometric ZentraChain Z emblem.
  rect(135, 160, 310, 310, 1);
  line(290, 180, 400, 242, 2, 5);
  line(400, 242, 400, 368, 2, 5);
  line(400, 368, 290, 430, 2, 5);
  line(290, 430, 180, 368, 2, 5);
  line(180, 368, 180, 242, 2, 5);
  line(180, 242, 290, 180, 2, 5);
  line(225, 245, 355, 245, 3, 11);
  line(355, 245, 245, 355, 3, 11);
  line(245, 355, 355, 355, 3, 11);
  disc(355, 245, 8, 3); disc(225, 355, 8, 2);
  // Wordmark and descriptor.
  rect(520, 105, 220, 32, 1);
  text('OFFICIAL WEBSITE', 536, 115, 2, 2);
  text('ZENTRACHAIN', 520, 205, 9, 3);
  rect(520, 292, 530, 5, 2);
  text('DIGITAL ASSET PLATFORM', 520, 338, 4, 2);
  text('DIGITAL ASSET ACCOUNT PORTAL', 520, 410, 3, 3);
  text('MARKET INFORMATION AND', 520, 449, 3, 3);
  text('TRANSACTION MANAGEMENT', 520, 488, 3, 3);
  rect(520, 535, 520, 2, 1);
  text('ZENTRACHAIN.JAMEIWOK.WORKERS.DEV', 520, 554, 2, 2);
  disc(1110, 100, 5, 2); disc(1145, 290, 5, 2); disc(1080, 515, 5, 2);
  return encodePng(width, height, c.pixels);
}

function makeFaviconPng(size = 192) {
  size = Math.max(16, Math.min(512, Math.round(size)));
  const c = canvas(size, size);
  const { rect, line, disc } = c;
  const scale = size / 40;
  rect(0, 0, size, size, 0);
  const point = (x, y) => [Math.round(x * scale), Math.round(y * scale)];
  const hex = [[20,2.8],[35.2,11.4],[35.2,28.6],[20,37.2],[4.8,28.6],[4.8,11.4],[20,2.8]];
  for (let i = 0; i < hex.length - 1; i++) {
    const a = point(hex[i][0], hex[i][1]), b = point(hex[i+1][0], hex[i+1][1]);
    line(a[0], a[1], b[0], b[1], 2, Math.max(1, Math.round(2.2 * scale)));
  }
  const z = [[12,13.1],[28,13.1],[15.4,26.9],[28,26.9]];
  for (let i = 0; i < z.length - 1; i++) {
    const a = point(z[i][0], z[i][1]), b = point(z[i+1][0], z[i+1][1]);
    line(a[0], a[1], b[0], b[1], 3, Math.max(1, Math.round(4.1 * scale)));
  }
  const d1 = point(28.1,13.1), d2 = point(12,26.9);
  disc(d1[0], d1[1], Math.max(1, Math.round(2.1 * scale)), 3);
  disc(d2[0], d2[1], Math.max(1, Math.round(2.1 * scale)), 2);
  return encodePng(size, size, c.pixels);
}

module.exports = { makeOgImagePng, makeFaviconPng };