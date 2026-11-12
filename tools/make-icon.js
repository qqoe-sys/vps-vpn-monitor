'use strict';
// Рисует иконку приложения без графических библиотек: считаем цвет каждого пикселя,
// кодируем в PNG и складываем несколько размеров в один .ico.
// Запуск: node tools/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BACKGROUND = [26, 26, 25];
const BAR = [57, 135, 229];
const LED = [76, 175, 125];

// Вернёт true, если точка внутри прямоугольника со скруглёнными углами.
function inRounded(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const dx = Math.max(left + radius - x, 0, x - (right - radius));
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
  return dx * dx + dy * dy <= radius * radius;
}

// x и y от 0 до 1. Возвращает цвет или null (прозрачно).
function colorAt(x, y) {
  if (!inRounded(x, y, 0.02, 0.02, 0.98, 0.98, 0.2)) return null;
  for (const top of [0.17, 0.41, 0.65]) {
    const bottom = top + 0.18;
    const ledY = (top + bottom) / 2;
    if ((x - 0.74) ** 2 + (y - ledY) ** 2 <= 0.05 ** 2) return LED;
    if (inRounded(x, y, 0.16, top, 0.84, bottom, 0.04)) return BAR;
  }
  return BACKGROUND;
}

function chunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(typed), out.length - 4);
  return out;
}

function renderPng(size) {
  const SAMPLES = 4; // сглаживание краёв: усредняем несколько точек внутри пикселя
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let py = 0; py < size; py += 1) {
    raw[o++] = 0; // тип фильтра строки PNG
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const c = colorAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits += 1; }
        }
      }
      raw[o++] = hits ? Math.round(r / hits) : 0;
      raw[o++] = hits ? Math.round(g / hits) : 0;
      raw[o++] = hits ? Math.round(b / hits) : 0;
      raw[o++] = Math.round((255 * hits) / SAMPLES ** 2);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 бит на канал
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(sizes) {
  const images = sizes.map(renderPng);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // тип файла: иконка
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    head[e] = size === 256 ? 0 : size; // 0 в этом поле означает 256
    head[e + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 256]));
fs.writeFileSync(path.join(dir, 'icon.png'), renderPng(256));
