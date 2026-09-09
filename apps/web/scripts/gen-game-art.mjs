#!/usr/bin/env node
/**
 * Generates the SVG artwork (thumbnail 640×360 + banner 1200×400) for the demo
 * game builds that ship with Voltade.
 *
 * WHY SVG, WHY GENERATED: the catalogue needs a thumbnail per game, and a
 * checked-in binary blob nobody can reproduce is a liability. These are vector,
 * ~3 KB each, crisp at every DPR, and re-generating them is one command. Real
 * imports get their artwork from the provider (then optimised to AVIF/WebP by the
 * `media` queue); uploads get theirs from the ZIP.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const GAMES = [
  { slug: 'neon-pong',    ar: 'بونج نيون',        en: 'Neon Pong',    glyph: '🏓', c1: '#4f7cff', c2: '#9a5cff', bg: '#070b18' },
  { slug: 'snake-volt',   ar: 'الثعبان الكهربائي', en: 'Snake Volt',   glyph: '🐍', c1: '#25e39a', c2: '#8ef7c1', bg: '#06120f' },
  { slug: 'brick-blitz',  ar: 'تحطيم الطوب',       en: 'Brick Blitz',  glyph: '🧱', c1: '#ffb03a', c2: '#ff5ea8', bg: '#0b0716' },
  { slug: 'volt-2048',    ar: '٢٠٤٨',              en: 'Volt 2048',    glyph: '🔢', c1: '#7aa2ff', c2: '#c98bff', bg: '#0d1020' },
  { slug: 'memory-cards', ar: 'بطاقات الذاكرة',     en: 'Memory Cards', glyph: '🃏', c1: '#5ee7ff', c2: '#7aa2ff', bg: '#0a0f1e' },
  { slug: 'tic-tac-volt', ar: 'إكس أو',            en: 'Tic Tac Volt', glyph: '⭕', c1: '#ff8fb1', c2: '#7aa2ff', bg: '#090d1a' },
];

const grid = (w, h, step, color) => {
  let out = '';
  for (let x = step; x < w; x += step) out += `<path d="M${x} 0V${h}" stroke="${color}" stroke-width="1"/>`;
  for (let y = step; y < h; y += step) out += `<path d="M0 ${y}H${w}" stroke="${color}" stroke-width="1"/>`;
  return out;
};

const art = (g, w, h, { banner = false } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${g.en}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${g.bg}"/>
      <stop offset="55%" stop-color="${g.c1}" stop-opacity=".28"/>
      <stop offset="100%" stop-color="${g.c2}" stop-opacity=".42"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="${g.c1}" stop-opacity=".55"/>
      <stop offset="100%" stop-color="${g.c1}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${banner ? 10 : 7}"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="${g.bg}"/>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <g opacity=".18">${grid(w, h, banner ? 50 : 40, '#ffffff')}</g>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <g opacity=".55" filter="url(#soft)">
    <circle cx="${w * 0.5}" cy="${h * 0.44}" r="${h * (banner ? 0.3 : 0.26)}" fill="${g.c2}" opacity=".35"/>
  </g>
  <text x="${w / 2}" y="${h * (banner ? 0.52 : 0.5)}" font-size="${h * (banner ? 0.42 : 0.4)}" text-anchor="middle" dominant-baseline="middle">${g.glyph}</text>
  <g font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
    <text x="${w / 2}" y="${h - (banner ? h * 0.16 : h * 0.1)}" font-size="${h * (banner ? 0.13 : 0.115)}" font-weight="800"
      fill="#ffffff" text-anchor="middle" letter-spacing="${banner ? 2 : 1}">${g.en}</text>
    <text x="${w / 2}" y="${h - (banner ? h * 0.055 : h * 0.025)}" font-size="${h * (banner ? 0.075 : 0.068)}"
      fill="#ffffff" opacity=".72" text-anchor="middle">${g.ar}</text>
  </g>
  <g opacity=".5" font-family="system-ui, sans-serif" font-size="${h * 0.045}" font-weight="800" fill="#ffffff">
    <text x="${w - 14}" y="${h * 0.1}" text-anchor="end" letter-spacing="3">VOLT</text>
  </g>
</svg>
`;

for (const g of GAMES) {
  const dir = join(root, 'public/games', g.slug);
  await writeFile(join(dir, 'thumb.svg'), art(g, 640, 360), 'utf8');
  await writeFile(join(dir, 'banner.svg'), art(g, 1200, 400, { banner: true }), 'utf8');
}
console.log(`✓ artwork generated for ${GAMES.length} games (thumb 640×360 + banner 1200×400)`);
