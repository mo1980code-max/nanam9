import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../public/icons', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// A brand mark drawn at the target size (not upscaled) so every icon is crisp.
const mark = (size, padding = 0) => {
  const inner = size - padding * 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#g)"/>
  <g transform="translate(${padding} ${padding})">
    <path d="M ${inner * 0.22} ${inner * 0.26} L ${inner * 0.5} ${inner * 0.78} L ${inner * 0.78} ${inner * 0.26}"
      fill="none" stroke="#ffffff" stroke-width="${Math.max(2, Math.round(inner * 0.11))}"
      stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`);
};

const targets = [
  { file: 'icon-192.png', size: 192, padding: 34 },
  { file: 'icon-512.png', size: 512, padding: 92 },
  { file: 'maskable-192.png', size: 192, padding: 48 },
  { file: 'maskable-512.png', size: 512, padding: 130 },
  { file: 'apple-touch-icon.png', size: 180, padding: 30 },
  { file: 'favicon-32.png', size: 32, padding: 4 },
  { file: 'og-1200x630.png', size: 0, padding: 0 },
];

for (const target of targets) {
  if (target.file === 'og-1200x630.png') {
    const og = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0b0b12"/><stop offset="1" stop-color="#1b1030"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <g transform="translate(120 210)">
    <rect width="210" height="210" rx="46" fill="#7c3aed"/>
    <path d="M 46 55 L 105 165 L 164 55" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="380" y="300" font-family="DejaVu Sans, Arial, sans-serif" font-size="96" font-weight="700" fill="#ffffff">Voltade</text>
  <text x="380" y="370" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="#a3a3b5">HTML5 games portal — play instantly</text>
</svg>`);
    await sharp(og).png().toFile(`${OUT}/${target.file}`);
    continue;
  }
  await sharp(mark(target.size, target.padding)).png().toFile(`${OUT}/${target.file}`);
}
console.log('icons written');
