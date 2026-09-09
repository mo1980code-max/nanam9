/**
 * Voltade game-library generator.
 *
 * WHY GENERATE INSTEAD OF IMPORT: the auto-import pipeline (GameMonetize /
 * GameDistribution) pulls third-party ZIPs whose quality and licences we do not
 * control; a demo portal also has to work offline. This script emits a library of
 * genuinely playable, self-contained HTML5 builds — one canvas file per game, no
 * external assets — plus the seed manifest that registers them in the database.
 *
 * Each engine is written once and parameterised (speed, grid, colours, emoji set),
 * so forty distinct games share fifteen tested code paths instead of forty
 * hand-maintained ones. Re-running is idempotent: it overwrites the same slugs.
 *
 *   node tools/gamelib/generate.mjs
 *     → apps/web/public/games/<slug>/{index.html,thumb.svg,banner.svg}
 *     → packages/db/src/seed/library.games.ts   (then: npm run db:seed)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAMES_DIR = join(ROOT, 'apps', 'web', 'public', 'games');
const MANIFEST = join(ROOT, 'packages', 'db', 'src', 'seed', 'library.games.ts');

// ───────────────────────────── shared runtime shell ─────────────────────────────

const COMMON = `
const cv = document.getElementById('c'), cx = cv.getContext('2d');
const W = cv.width, H = cv.height;
const $ = (id) => document.getElementById(id);
let paused = false, score = 0;
const BKEY = 'voltade-best-' + location.pathname;
const readBest = () => Number(localStorage.getItem(BKEY) || 0);
const showBest = (v) => { $('best').textContent = v ? ('أفضل نتيجة: ' + v) : ''; };
function setScore(text) { $('score').textContent = text; }
function gameOver(text, finalScore) {
  paused = true;
  if (typeof finalScore === 'number') showBest(Math.max(readBest(), finalScore));
  $('msgText').textContent = text;
  $('msg').style.display = 'grid';
}
$('again').onclick = () => location.reload();
$('msgBtn').onclick = () => location.reload();
showBest(readBest());
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.key] = false; });
let pointer = null, pointerDown = false, tap = null;
const toLogical = (e) => {
  const r = cv.getBoundingClientRect();
  return [ (e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height) ];
};
cv.addEventListener('pointerdown', (e) => { pointerDown = true; pointer = toLogical(e); tap = pointer; e.preventDefault(); });
cv.addEventListener('pointermove', (e) => { pointer = toLogical(e); });
addEventListener('pointerup', () => { pointerDown = false; });
let swipe = null, touchOrigin = null;
cv.addEventListener('touchstart', (e) => { touchOrigin = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
cv.addEventListener('touchend', (e) => {
  if (!touchOrigin) return;
  const dx = e.changedTouches[0].clientX - touchOrigin[0];
  const dy = e.changedTouches[0].clientY - touchOrigin[1];
  if (Math.abs(dx) > 24 || Math.abs(dy) > 24) swipe = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  touchOrigin = null;
}, { passive: true });
const takeSwipe = () => { const s = swipe; swipe = null; return s; };
const takeTap = () => { const t = tap; tap = null; return t; };
const rnd = (n) => Math.floor(Math.random() * n);
const FONT = (px, weight) => (weight || 700) + ' ' + px + 'px system-ui, "Segoe UI", sans-serif';
`;

function shell(game, bodyJs) {
  const t = game.theme;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${game.ar} — العب مجانًا | Voltade</title>
<style>
  html, body { margin: 0; height: 100%; background: ${t.bg}; overflow: hidden; font-family: system-ui, "Segoe UI", sans-serif; }
  #wrap { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 8px; box-sizing: border-box; }
  #hud { display: flex; align-items: center; gap: 12px; color: ${t.fg}; font-weight: 800; font-size: 14px; min-height: 22px; }
  #hud button { background: ${t.accent}; border: 0; color: #fff; border-radius: 10px; padding: 6px 16px; font: inherit; font-weight: 800; cursor: pointer; }
  canvas { background: ${t.panel}; border-radius: 14px; touch-action: none; max-width: 100%; max-height: calc(100% - 44px); box-shadow: 0 12px 44px #0007; }
  #msg { position: fixed; inset: 0; display: none; place-items: center; background: #000b; color: #fff; z-index: 5; }
  #msg div { display: grid; gap: 14px; justify-items: center; font-size: 24px; font-weight: 900; text-align: center; padding: 20px; }
  #msg button { background: ${t.accent}; border: 0; color: #fff; border-radius: 12px; padding: 10px 26px; font: inherit; font-weight: 800; cursor: pointer; }
</style>
</head>
<body>
<div id="wrap">
  <div id="hud"><span id="score"></span><span id="best"></span><button id="again" type="button">↺ إعادة</button></div>
  <canvas id="c" width="${game.width}" height="${game.height}"></canvas>
</div>
<div id="msg"><div><span id="msgText"></span><button id="msgBtn" type="button">العب من جديد</button></div></div>
<script>
${COMMON}
${bodyJs}
</script>
</body>
</html>
`;
}

// ───────────────────────────────── the engines ─────────────────────────────────

const engines = {
  snake: (p) => `
const N = ${p.grid}, CELL = Math.floor(Math.min(W, H) / N), OX = (W - CELL * N) / 2, OY = (H - CELL * N) / 2;
let dir = [1, 0], next = [1, 0], snake = [[5, 5], [4, 5], [3, 5]], food = null, dead = false, ticks = 0;
const WALLS = ${JSON.stringify(p.walls || [])};
function place() { do { food = [rnd(N), rnd(N)]; } while (snake.some(s => s[0] === food[0] && s[1] === food[1]) || WALLS.some(s => s[0] === food[0] && s[1] === food[1])); }
place();
function step() {
  dir = next;
  const head = [(snake[0][0] + dir[0] + N) % N, (snake[0][1] + dir[1] + N) % N];
  if (snake.some(s => s[0] === head[0] && s[1] === head[1]) || WALLS.some(s => s[0] === head[0] && s[1] === head[1])) { dead = true; gameOver('💀 اصطدمت! النتيجة: ' + score, score); return; }
  snake.unshift(head);
  if (head[0] === food[0] && head[1] === food[1]) { score += 10; setScore('🍎 ' + score); place(); } else snake.pop();
}
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '${p.theme.wall}'; WALLS.forEach(w => cx.fillRect(OX + w[0] * CELL, OY + w[1] * CELL, CELL, CELL));
  cx.fillStyle = '${p.theme.accent}'; cx.beginPath(); cx.arc(OX + food[0] * CELL + CELL / 2, OY + food[1] * CELL + CELL / 2, CELL * 0.36, 0, 7); cx.fill();
  snake.forEach((s, i) => { cx.fillStyle = i ? '${p.theme.snake}' : '${p.theme.accent}'; cx.fillRect(OX + s[0] * CELL + 1, OY + s[1] * CELL + 1, CELL - 2, CELL - 2); });
}
setInterval(() => { if (paused) return;
  if (keys.ArrowUp || swipe === null && false) {}
  const s = takeSwipe();
  if (keys.ArrowUp || s === 'up') { if (dir[1] !== 1) next = [0, -1]; }
  else if (keys.ArrowDown || s === 'down') { if (dir[1] !== -1) next = [0, 1]; }
  else if (keys.ArrowRight || s === 'right') { if (dir[0] !== -1) next = [1, 0]; }
  else if (keys.ArrowLeft || s === 'left') { if (dir[0] !== 1) next = [-1, 0]; }
  if (++ticks % Math.max(2, ${p.speed}) === 0) step();
  draw();
}, 16);
setScore('🍎 0');
`,

  breakout: (p) => `
const ROWS = ${p.rows}, COLS = 8, BW = (W - 40) / COLS, BH = 22;
let bricks = [], ball = { x: W / 2, y: H - 90, vx: ${p.ballSpeed} * (Math.random() > .5 ? 1 : -1), vy: -${p.ballSpeed} }, pad = { x: W / 2 - ${p.paddleW} / 2, w: ${p.paddleW} };
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) bricks.push({ r, c, alive: true });
const COLORS = ${JSON.stringify(p.bricks)};
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  bricks.forEach(b => { if (!b.alive) return; cx.fillStyle = COLORS[b.r % COLORS.length]; cx.fillRect(20 + b.c * BW + 2, 40 + b.r * (BH + 4), BW - 4, BH); });
  cx.fillStyle = '${p.theme.accent}'; cx.fillRect(pad.x, H - 26, pad.w, 12);
  cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(ball.x, ball.y, 8, 0, 7); cx.fill();
}
function step() {
  if (pointer) pad.x = Math.max(0, Math.min(W - pad.w, pointer[0] - pad.w / 2));
  if (keys.ArrowLeft) pad.x -= 9; if (keys.ArrowRight) pad.x += 9;
  pad.x = Math.max(0, Math.min(W - pad.w, pad.x));
  ball.x += ball.vx; ball.y += ball.vy;
  if (ball.x < 8 || ball.x > W - 8) ball.vx *= -1;
  if (ball.y < 8) ball.vy *= -1;
  if (ball.y > H - 34 && ball.y < H - 18 && ball.x > pad.x && ball.x < pad.x + pad.w) { ball.vy = -Math.abs(ball.vy) - 0.15; ball.vx += (ball.x - (pad.x + pad.w / 2)) * 0.05; }
  bricks.forEach(b => { if (!b.alive) return;
    const x = 20 + b.c * BW, y = 40 + b.r * (BH + 4);
    if (ball.x > x && ball.x < x + BW && ball.y > y && ball.y < y + BH) { b.alive = false; ball.vy *= -1; score += 10; setScore('🧱 ' + score); } });
  if (bricks.every(b => !b.alive)) { gameOver('🏆 أنهيت كل الطوب! ' + score, score); return; }
  if (ball.y > H + 20) gameOver('💧 سقطت الكرة — النتيجة: ' + score, score);
}
setInterval(() => { if (paused) return; step(); draw(); }, 16);
setScore('🧱 0');
`,

  pong: (p) => `
let py = H / 2, ay = H / 2, ball = { x: W / 2, y: H / 2, vx: ${p.speed}, vy: ${p.speed} * 0.6 }, me = 0, ai = 0;
const PH = ${p.paddle} , AI = ${p.ai};
function step() {
  if (pointer) py = pointer[1];
  if (keys.ArrowUp) py -= 10; if (keys.ArrowDown) py += 10;
  py = Math.max(PH / 2, Math.min(H - PH / 2, py));
  ay += Math.max(-AI, Math.min(AI, ball.y - ay));
  ball.x += ball.vx; ball.y += ball.vy;
  if (ball.y < 8 || ball.y > H - 8) ball.vy *= -1;
  if (ball.x < 26 && ball.y > py - PH / 2 && ball.y < py + PH / 2) { ball.vx = Math.abs(ball.vx) * 1.05; ball.vy += (ball.y - py) * 0.08; }
  if (ball.x > W - 26 && ball.y > ay - PH / 2 && ball.y < ay + PH / 2) { ball.vx = -Math.abs(ball.vx) * 1.05; }
  if (ball.x < -20) { ai++; reset(1); } if (ball.x > W + 20) { me++; reset(-1); }
  setScore('🟢 أنت ' + me + ' — ' + ai + ' ');
  if (me >= ${p.win}) gameOver('🏆 فزت ' + me + '‑' + ai, me * 100);
  if (ai >= ${p.win}) gameOver('🤖 خسرنا ' + me + '‑' + ai, me * 100);
}
function reset(d) { ball = { x: W / 2, y: H / 2, vx: ${p.speed} * d, vy: (Math.random() - .5) * 6 }; }
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.strokeStyle = '#ffffff22'; cx.setLineDash([8, 10]); cx.beginPath(); cx.moveTo(W / 2, 0); cx.lineTo(W / 2, H); cx.stroke(); cx.setLineDash([]);
  cx.fillStyle = '${p.theme.accent}'; cx.fillRect(14, py - PH / 2, 10, PH);
  cx.fillStyle = '${p.theme.enemy}'; cx.fillRect(W - 24, ay - PH / 2, 10, PH);
  cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(ball.x, ball.y, 8, 0, 7); cx.fill();
}
setInterval(() => { if (paused) return; step(); draw(); }, 16);
`,

  g2048: (p) => `
const N = ${p.size}; let grid = Array.from({ length: N }, () => Array(N).fill(0));
const COLORS = { 0: '${p.theme.empty}', 2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f', 64: '#f65e3b', 128: '#edcf72', 256: '#edcc61', 512: '#edc850', 1024: '#edc53f', 2048: '${p.theme.accent}' };
function add() { const free = []; grid.forEach((r, i) => r.forEach((v, j) => { if (!v) free.push([i, j]); })); if (free.length) { const [i, j] = free[rnd(free.length)]; grid[i][j] = Math.random() < 0.9 ? 2 : 4; } }
function slide(row) { const a = row.filter(Boolean); for (let i = 0; i < a.length - 1; i++) if (a[i] === a[i + 1]) { a[i] *= 2; score += a[i]; a.splice(i + 1, 1); } while (a.length < N) a.push(0); return a; }
function move(dx, dy) {
  const before = JSON.stringify(grid);
  for (let i = 0; i < N; i++) {
    let line = [];
    for (let j = 0; j < N; j++) line.push(grid[dy ? i : j][dy ? j : i]);
    if (dx > 0 || dy > 0) line.reverse();
    line = slide(line);
    if (dx > 0 || dy > 0) line.reverse();
    for (let j = 0; j < N; j++) grid[dy ? i : j][dy ? j : i] = line[j];
  }
  if (JSON.stringify(grid) !== before) { add(); setScore('⭐ ' + score); }
  if (!canMove()) gameOver('🧠 توقفت الحركة — النقاط: ' + score, score);
}
function canMove() { for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (!grid[i][j]) return true; if (j + 1 < N && grid[i][j] === grid[i][j + 1]) return true; if (i + 1 < N && grid[i][j] === grid[i + 1][j]) return true; } return false; }
add(); add();
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  const cell = Math.min(W, H) / (N + 0.6), gap = cell * 0.08, ox = (W - cell * N - gap * (N - 1)) / 2, oy = (H - cell * N - gap * (N - 1)) / 2;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const v = grid[i][j], x = ox + j * (cell + gap), y = oy + i * (cell + gap);
    cx.fillStyle = COLORS[v] || '${p.theme.accent}'; cx.beginPath(); cx.roundRect(x, y, cell, cell, 8); cx.fill();
    if (v) { cx.fillStyle = v > 4 ? '#fff' : '#776e65'; cx.font = FONT(cell * (v > 999 ? 0.26 : v > 99 ? 0.32 : 0.4)); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(v, x + cell / 2, y + cell / 2); }
  }
}
setInterval(() => { if (paused) return;
  const s = takeSwipe();
  if (keys.ArrowLeft || s === 'left') move(-1, 0); else if (keys.ArrowRight || s === 'right') move(1, 0);
  else if (keys.ArrowUp || s === 'up') move(0, -1); else if (keys.ArrowDown || s === 'down') move(0, 1);
  keys.ArrowLeft = keys.ArrowRight = keys.ArrowUp = keys.ArrowDown = false;
  draw();
}, 60);
setScore('⭐ 0'); draw();
`,

  memory: (p) => `
const EMOJI = ${JSON.stringify(p.emoji)};
const COLS = ${p.cols}, ROWS = EMOJI.length * 2 / COLS;
let cards = [], open = [], lock = false, moves = 0, found = 0;
EMOJI.concat(EMOJI).forEach(e => cards.push({ e, up: false, done: false }));
for (let i = cards.length - 1; i > 0; i--) { const j = rnd(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
const CW = Math.min((W - 30) / COLS, (H - 30) / ROWS);
const OX = (W - CW * COLS) / 2, OY = (H - CW * ROWS) / 2;
cv.addEventListener('pointerdown', (e) => {
  if (paused || lock) return;
  const [x, y] = toLogical(e);
  const c = Math.floor((x - OX) / CW), r = Math.floor((y - OY) / CW);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
  const card = cards[r * COLS + c];
  if (!card || card.up || card.done) return;
  card.up = true; open.push(card);
  if (open.length === 2) { moves++; setScore('🎴 محاولات: ' + moves); lock = true;
    const [a, b] = open;
    setTimeout(() => { if (a.e === b.e) { a.done = b.done = true; found++; if (found === EMOJI.length) gameOver('🎉 وجدتها كلها في ' + moves + ' محاولة!', Math.max(0, 500 - moves * 10)); } a.up = b.up = false; open = []; lock = false; }, 620);
  }
});
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cards.forEach((card, i) => {
    const c = i % COLS, r = Math.floor(i / COLS), x = OX + c * CW + 4, y = OY + r * CW + 4, s = CW - 8;
    cx.fillStyle = card.done ? '${p.theme.done}' : card.up ? '#fff' : '${p.theme.accent}';
    cx.beginPath(); cx.roundRect(x, y, s, s, 10); cx.fill();
    cx.font = FONT(s * 0.55); cx.textAlign = 'center'; cx.textBaseline = 'middle';
    if (card.up || card.done) cx.fillText(card.e, x + s / 2, y + s / 2);
    else { cx.fillStyle = '#ffffff55'; cx.fillText('؟', x + s / 2, y + s / 2); }
  });
}
setInterval(() => { if (!paused) draw(); }, 30);
setScore('🎴 محاولات: 0');
`,

  whack: (p) => `
const HOLES = ${p.holes}, TIME = ${p.seconds};
let left = TIME, hits = 0, mole = -1, moleAt = 0;
const CW = Math.min(W, H) / 3;
function holeXY(i) { const c = i % 3, r = Math.floor(i / 3); return [ (W - CW * 3) / 2 + c * CW + CW / 2, (H - CW * 3) / 2 + r * CW + CW / 2 ]; }
function pop() { mole = rnd(HOLES); moleAt = Date.now(); }
pop();
cv.addEventListener('pointerdown', (e) => {
  if (paused) return;
  const [x, y] = toLogical(e);
  for (let i = 0; i < HOLES; i++) { const [hx, hy] = holeXY(i); if (i === mole && Math.hypot(x - hx, y - hy) < CW * 0.36) { hits++; setScore('🔨 ' + hits + ' — ⏱ ' + left); pop(); } }
});
setInterval(() => { if (paused) return; left--; setScore('🔨 ' + hits + ' — ⏱ ' + left); if (left <= 0) gameOver('⏰ انتهى الوقت! أصبت ' + hits, hits * 20); }, 1000);
setInterval(() => { if (!paused && Date.now() - moleAt > ${p.interval}) pop(); }, 120);
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  for (let i = 0; i < HOLES; i++) { const [x, y] = holeXY(i);
    cx.fillStyle = '${p.theme.hole}'; cx.beginPath(); cx.ellipse(x, y + CW * 0.16, CW * 0.34, CW * 0.16, 0, 0, 7); cx.fill();
    if (i === mole) { cx.font = FONT(CW * 0.5); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('${p.emoji}', x, y - CW * 0.06); } }
}
setInterval(() => { if (!paused) draw(); }, 30);
setScore('🔨 0 — ⏱ ' + TIME);
`,

  flappy: (p) => `
let bird = { y: H / 2, v: 0 }, pipes = [], frame = 0, started = false;
const GAP = ${p.gap}, GRAV = ${p.gravity}, SPEED = ${p.speed};
function flap() { if (paused) return; started = true; bird.v = -${p.jump}; }
cv.addEventListener('pointerdown', flap);
addEventListener('keydown', (e) => { if (e.key === ' ') flap(); });
function step() {
  if (!started) return;
  bird.v += GRAV; bird.y += bird.v;
  if (frame % ${p.every} === 0) pipes.push({ x: W + 40, top: 60 + rnd(H - GAP - 120) });
  pipes.forEach(p2 => p2.x -= SPEED);
  pipes = pipes.filter(p2 => p2.x > -80);
  pipes.forEach(p2 => {
    if (!p2.scored && p2.x < W * 0.28) { p2.scored = true; score++; setScore('🚀 ' + score); }
    if (W * 0.28 + 14 > p2.x && W * 0.28 - 14 < p2.x + 58 && (bird.y - 14 < p2.top || bird.y + 14 > p2.top + GAP)) die();
  });
  if (bird.y > H - 12 || bird.y < 0) die();
}
let deadOnce = false;
function die() { if (deadOnce) return; deadOnce = true; gameOver('💥 ارتطمت! النقاط: ' + score, score); }
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '${p.theme.pipe}';
  pipes.forEach(p2 => { cx.fillRect(p2.x, 0, 58, p2.top); cx.fillRect(p2.x, p2.top + GAP, 58, H); });
  cx.font = FONT(30); cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('${p.emoji}', W * 0.28, bird.y);
  if (!started) { cx.fillStyle = '#ffffffcc'; cx.font = FONT(20); cx.fillText('اضغط للطيران ↑', W / 2, H / 2 - 60); }
}
setInterval(() => { if (paused) return; frame++; step(); draw(); }, 16);
setScore('🚀 0');
`,

  runner: (p) => `
let y = 0, v = 0, sliding = false, obs = [], frame = 0, speed = ${p.speed}, dead = false;
const GY = H - 60;
function jump() { if (paused || y !== 0) return; v = ${p.jump}; }
cv.addEventListener('pointerdown', (e) => { const [, ly] = toLogical(e); if (ly > H * 0.6) { sliding = true; setTimeout(() => sliding = false, 420); } else jump(); });
addEventListener('keydown', (e) => { if (e.key === ' ') jump(); if (e.key === 'ArrowDown') { sliding = true; setTimeout(() => sliding = false, 420); } });
function step() {
  frame++;
  if (frame % 400 === 0) speed += 0.6;
  v -= ${p.gravity}; y = Math.max(0, y + v); if (y === 0) v = 0;
  if (frame % Math.max(28, ${p.every} - Math.floor(speed * 4)) === 0) obs.push({ x: W + 40, fly: Math.random() < 0.3 });
  obs.forEach(o => o.x -= speed);
  obs = obs.filter(o => o.x > -60);
  const py2 = GY - y, ph = sliding ? 26 : 52;
  obs.forEach(o => { const oy = o.fly ? GY - 66 : GY - 34;
    if (o.x < W * 0.24 + 20 && o.x + 34 > W * 0.24 - 12 && py2 > oy - ph + 16 && py2 - ph < oy + 34) { dead = true; gameOver('🚧 اصطدمت! المسافة: ' + score, score); } });
  score = Math.floor(frame / 6); setScore('🏃 ' + score);
}
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '${p.theme.ground}'; cx.fillRect(0, GY, W, 4);
  cx.font = FONT(40); cx.textAlign = 'center'; cx.textBaseline = 'bottom';
  cx.fillText('${p.emoji}', W * 0.24, GY - y + 20);
  cx.font = FONT(34);
  obs.forEach(o => cx.fillText(o.fly ? '${p.flyEmoji}' : '${p.obsEmoji}', o.x, o.fly ? GY - 40 : GY + 2));
}
setInterval(() => { if (paused) return; step(); draw(); }, 16);
setScore('🏃 0');
`,

  mines: (p) => `
const N = ${p.grid}, MINES = ${p.mines};
const CW = Math.floor(Math.min(W, H) / N), OX = (W - CW * N) / 2, OY = (H - CW * N) / 2;
let cells = [], started = false, flags = 0, openCount = 0;
for (let i = 0; i < N * N; i++) cells.push({ m: false, open: false, flag: false, n: 0 });
function plant(safe) { let placed = 0; while (placed < MINES) { const i = rnd(N * N); if (cells[i].m || Math.abs(i - safe) <= N + 1) continue; cells[i].m = true; placed++; }
  cells.forEach((c, i) => { let n = 0; around(i).forEach(j => { if (cells[j].m) n++; }); c.n = n; }); }
function around(i) { const r = Math.floor(i / N), c = i % N, out = []; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if ((dr || dc) && rr >= 0 && rr < N && cc >= 0 && cc < N) out.push(rr * N + cc); } return out; }
function open(i) { const c = cells[i]; if (c.open || c.flag) return; if (!started) { started = true; plant(i); }
  c.open = true; openCount++;
  if (c.m) { cells.forEach(x => x.open = true); draw(); gameOver('💥 بوم! انفجر اللغم', 0); return; }
  if (!c.n) around(i).forEach(open);
  if (openCount === N * N - MINES) gameOver('🧹 نظفت الحقل بالكامل!', 500);
}
cv.addEventListener('pointerdown', (e) => { if (paused) return; const [x, y2] = toLogical(e);
  const c = Math.floor((x - OX) / CW), r = Math.floor((y2 - OY) / CW); if (c < 0 || c >= N || r < 0 || r >= N) return;
  const i = r * N + c;
  if (e.button === 2 || (e.pointerType === 'touch' && cells[i].open === false && flags < MINES && e.altKey)) { cells[i].flag = !cells[i].flag; flags += cells[i].flag ? 1 : -1; setScore('🚩 ' + flags + '/' + MINES); return; }
  open(i); setScore('🚩 ' + flags + '/' + MINES);
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());
const NUM = ['#0000', '${p.theme.accent}', '#4caf50', '#f44336', '#9c27b0', '#ff9800', '#00bcd4', '#333', '#888'];
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cells.forEach((c, i) => { const x = OX + (i % N) * CW + 2, y2 = OY + Math.floor(i / N) * CW + 2, s = CW - 4;
    cx.fillStyle = c.open ? (c.m ? '#e53935' : '${p.theme.open}') : '${p.theme.accent}';
    cx.beginPath(); cx.roundRect(x, y2, s, s, 6); cx.fill();
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    if (c.flag) { cx.font = FONT(s * 0.5); cx.fillText('🚩', x + s / 2, y2 + s / 2); }
    else if (c.open && c.m) { cx.font = FONT(s * 0.5); cx.fillText('💣', x + s / 2, y2 + s / 2); }
    else if (c.open && c.n) { cx.fillStyle = NUM[c.n]; cx.font = FONT(s * 0.55); cx.fillText(c.n, x + s / 2, y2 + s / 2); } });
}
setInterval(() => { if (!paused) draw(); }, 40);
setScore('🚩 0/' + MINES);
`,

  ttt: (p) => `
let b = Array(9).fill(''), turn = 'X', done = false;
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const CW = Math.min(W, H) / 3.4, OX = (W - CW * 3) / 2, OY = (H - CW * 3) / 2;
function winner(board) { for (const [a, c, d] of LINES) if (board[a] && board[a] === board[c] && board[a] === board[d]) return board[a]; return board.every(Boolean) ? 'D' : null; }
function bestMove(board, me) {
  const w = winner(board); if (w === me) return 10; if (w && w !== 'D') return -10; if (w === 'D') return 0;
  const scores = [];
  for (let i = 0; i < 9; i++) if (!board[i]) { board[i] = me; scores.push([i, bestMove(board, me === 'O' ? 'X' : 'O') * (me === 'O' ? 1 : -1)]); board[i] = ''; }
  scores.sort((a, c) => me === 'O' ? c[1] - a[1] : a[1] - c[1]);
  return Array.isArray(scores[0]) ? scores[0][0] : scores[0];
}
cv.addEventListener('pointerdown', (e) => {
  if (paused || done || turn !== 'X') return;
  const [x, y2] = toLogical(e);
  const c = Math.floor((x - OX) / CW), r = Math.floor((y2 - OY) / CW);
  if (c < 0 || c > 2 || r < 0 || r > 2 || b[r * 3 + c]) return;
  b[r * 3 + c] = 'X'; finishOrSwap();
});
function finishOrSwap() {
  const w = winner(b);
  if (w === 'X') { done = true; draw(); gameOver('🎉 فزت على الذكاء!', 300); return; }
  if (w === 'D') { done = true; draw(); gameOver('🤝 تعادل!', 100); return; }
  turn = 'O';
  setTimeout(() => { if (paused || done) return; const m = bestMove([...b], 'O'); if (typeof m === 'number') b[m] = 'O';
    const w2 = winner(b); turn = 'X';
    if (w2 === 'O') { done = true; draw(); gameOver('🤖 فاز الحاسوب هذه المرة', 0); return; }
    if (w2 === 'D') { done = true; draw(); gameOver('🤝 تعادل!', 100); return; }
    draw(); }, 260);
}
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.strokeStyle = '${p.theme.accent}'; cx.lineWidth = 4;
  for (let i = 1; i < 3; i++) { cx.beginPath(); cx.moveTo(OX + i * CW, OY); cx.lineTo(OX + i * CW, OY + 3 * CW); cx.stroke(); cx.beginPath(); cx.moveTo(OX, OY + i * CW); cx.lineTo(OX + 3 * CW, OY + i * CW); cx.stroke(); }
  b.forEach((v, i) => { if (!v) return; const x = OX + (i % 3) * CW + CW / 2, y2 = OY + Math.floor(i / 3) * CW + CW / 2;
    cx.font = FONT(CW * 0.55); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillStyle = v === 'X' ? '${p.theme.accent}' : '${p.theme.enemy}'; cx.fillText(v === 'X' ? '${p.x}' : '${p.o}', x, y2); });
}
setInterval(() => { if (!paused) draw(); }, 40);
setScore('❌ أنت — 🤖 الحاسوب');
`,

  reaction: (p) => `
const ROUNDS = ${p.rounds};
let state = 'wait', t0 = 0, round = 0, times = [], timeout = null;
function arm() { state = 'wait'; cx.fillStyle = '${p.theme.wait}'; cx.fillRect(0, 0, W, H); text('انتظر اللون الأخضر…'); timeout = setTimeout(() => { state = 'go'; t0 = performance.now(); cx.fillStyle = '${p.theme.go}'; cx.fillRect(0, 0, W, H); text('اضغط الآن! ⚡'); }, 900 + rnd(2600)); }
function text(s) { cx.fillStyle = '#fff'; cx.font = FONT(30); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(s, W / 2, H / 2); }
cv.addEventListener('pointerdown', () => {
  if (paused) return;
  if (state === 'wait') { clearTimeout(timeout); cx.fillStyle = '${p.theme.wait}'; cx.fillRect(0, 0, W, H); text('⚠ مبكر جدًا! اضغط للمحاولة من جديد'); state = 'again'; return; }
  if (state === 'again') { arm(); return; }
  if (state === 'go') { const ms = Math.round(performance.now() - t0); times.push(ms); round++;
    if (round >= ROUNDS) { const avg = Math.round(times.reduce((a, c) => a + c, 0) / times.length); gameOver('⚡ متوسطك: ' + avg + ' مللي ثانية', Math.max(0, 1000 - avg)); return; }
    setScore('⚡ الجولة ' + round + '/' + ROUNDS + ' — ' + ms + ' مللي'); arm(); }
});
arm();
setScore('⚡ الجولة 0/' + ROUNDS);
`,

  slide: (p) => `
const N = ${p.size};
let tiles = [], moves = 0;
for (let i = 0; i < N * N - 1; i++) tiles.push(i + 1); tiles.push(0);
for (let i = 0; i < ${p.shuffles}; i++) { const z = tiles.indexOf(0), r = Math.floor(z / N), c = z % N;
  const opts = []; if (r > 0) opts.push(z - N); if (r < N - 1) opts.push(z + N); if (c > 0) opts.push(z - 1); if (c < N - 1) opts.push(z + 1);
  const j = opts[rnd(opts.length)]; [tiles[z], tiles[j]] = [tiles[j], tiles[z]]; }
const CW = Math.min(W, H) / (N + 0.5), OX = (W - CW * N) / 2, OY = (H - CW * N) / 2;
cv.addEventListener('pointerdown', (e) => { if (paused) return; const [x, y2] = toLogical(e);
  const c = Math.floor((x - OX) / CW), r = Math.floor((y2 - OY) / CW); if (c < 0 || c >= N || r < 0 || r >= N) return;
  const i = r * N + c, z = tiles.indexOf(0);
  if (Math.abs(Math.floor(i / N) - Math.floor(z / N)) + Math.abs(i % N - z % N) === 1) { [tiles[i], tiles[z]] = [tiles[z], tiles[i]]; moves++; setScore('🔀 نقلات: ' + moves);
    if (tiles.every((v, k) => v === (k + 1) % (N * N))) gameOver('🧩 رتبتها في ' + moves + ' نقلة!', Math.max(0, 800 - moves * 5)); } });
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  tiles.forEach((v, i) => { if (!v) return; const x = OX + (i % N) * CW + 3, y2 = OY + Math.floor(i / N) * CW + 3, s = CW - 6;
    cx.fillStyle = '${p.theme.accent}'; cx.beginPath(); cx.roundRect(x, y2, s, s, 10); cx.fill();
    cx.fillStyle = '#fff'; cx.font = FONT(s * 0.42); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(v, x + s / 2, y2 + s / 2); });
}
setInterval(() => { if (!paused) draw(); }, 40);
setScore('🔀 نقلات: 0');
`,

  stroop: (p) => `
const COLORS = [['أحمر', '#e53935'], ['أزرق', '#1e88e5'], ['أخضر', '#43a047'], ['أصفر', '#fdd835']];
let left = ${p.seconds}, hits = 0, cur = null;
function next() { const word = COLORS[rnd(4)], ink = COLORS[rnd(4)]; cur = { word: word[0], ink: ink[1], match: word[0] === ink[0] || ${p.mode === 'ink' ? 'false' : 'word[1] === ink[1]'} };
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = cur.ink; cx.font = FONT(72, 900); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(cur.word, W / 2, H / 2 - 30);
  cx.fillStyle = '#ffffffaa'; cx.font = FONT(18); cx.fillText('${p.mode === 'ink' ? 'هل اللون مطابق لمعنى الكلمة؟' : 'هل الكلمة تطابق لون الحبر؟'}', W / 2, H / 2 + 60); }
function answer(v) { if (paused || !cur) return; if (v === cur.match) hits++; else hits = Math.max(0, hits - 1); setScore('🎯 ' + hits + ' — ⏱ ' + left); next(); }
document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === '1') answer(true); if (e.key === 'ArrowLeft' || e.key === '2') answer(false); });
cv.addEventListener('pointerdown', (e) => { const [x] = toLogical(e); answer(x > W / 2); });
setInterval(() => { if (paused) return; left--; setScore('🎯 ' + hits + ' — ⏱ ' + left); if (left <= 0) gameOver('⏰ انتهى! إجابات صحيحة: ' + hits, hits * 15); }, 1000);
next(); setScore('🎯 0 — ⏱ ' + ${p.seconds});
cx.fillStyle = '#ffffff88'; cx.font = FONT(16); cx.textAlign = 'center'; cx.fillText('يمين = نعم   •   يسار = لا', W / 2, H - 26);
`,

  clicker: (p) => `
let count = 0, perClick = 1, perSec = 0, upgrades = ${JSON.stringify(p.upgrades)};
const BTN = { x: W / 2, y: H / 2 - 20, r: Math.min(W, H) * 0.24 };
function priceOf(u) { return Math.ceil(u.base * Math.pow(1.6, u.owned)); }
cv.addEventListener('pointerdown', (e) => { if (paused) return; const [x, y2] = toLogical(e);
  if (Math.hypot(x - BTN.x, y2 - BTN.y) < BTN.r) { count += perClick; ping(x, y2); }
  upgrades.forEach((u, i) => { const [ux, uy] = upXY(i); if (x > ux && x < ux + 210 && y2 > uy && y2 < uy + 46 && count >= priceOf(u)) { count -= priceOf(u); u.owned++; if (u.kind === 'click') perClick += u.power; else perSec += u.power; } });
  hud(); });
let pings = [];
function ping(x, y2) { pings.push({ x, y: y2, t: Date.now() }); }
function upXY(i) { return [16, H - 56 - i * 54]; }
function hud() { setScore('${p.emoji} ' + Math.floor(count) + ' — لكل نقرة ' + perClick + ' — تلقائي ' + perSec + '/ث'); }
setInterval(() => { if (!paused && perSec) { count += perSec / 4; hud(); } }, 250);
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '${p.theme.accent}'; cx.beginPath(); cx.arc(BTN.x, BTN.y, BTN.r, 0, 7); cx.fill();
  cx.font = FONT(BTN.r * 0.9); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('${p.emoji}', BTN.x, BTN.y);
  cx.font = FONT(15); cx.textAlign = 'right';
  upgrades.forEach((u, i) => { const [ux, uy] = upXY(i); const afford = count >= priceOf(u);
    cx.fillStyle = afford ? '${p.theme.accent}' : '#ffffff22'; cx.beginPath(); cx.roundRect(ux, uy, 210, 46, 10); cx.fill();
    cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.fillText(u.name + ' (' + priceOf(u) + ')', ux + 105, uy + 23); });
  pings = pings.filter(p2 => Date.now() - p2.t < 700);
  cx.fillStyle = '#fff'; cx.font = FONT(20);
  pings.forEach(p2 => cx.fillText('+' + perClick, p2.x, p2.y - (Date.now() - p2.t) / 18));
}
setInterval(() => { if (!paused) draw(); }, 40);
hud();
`,

  bubble: (p) => `
let bubbles = [], frame = 0, missed = 0;
function spawn() { bubbles.push({ x: 30 + rnd(W - 60), y: H + 30, r: ${p.min} + rnd(${p.max} - ${p.min}), v: ${p.speed} + Math.random() * 1.4, e: '${p.emoji}' }); }
cv.addEventListener('pointerdown', (e) => { if (paused) return; const [x, y2] = toLogical(e);
  for (let i = bubbles.length - 1; i >= 0; i--) { const b = bubbles[i]; if (Math.hypot(x - b.x, y2 - b.y) < b.r + 6) { bubbles.splice(i, 1); score += Math.max(5, Math.round(60 - b.r)); setScore('🫧 ' + score); return; } } });
function step() {
  frame++;
  if (frame % ${p.every} === 0) spawn();
  bubbles.forEach(b => b.y -= b.v);
  const gone = bubbles.filter(b => b.y < -40);
  missed += gone.length;
  bubbles = bubbles.filter(b => b.y >= -40);
  if (missed >= ${p.miss}) gameOver('🌊 أفلت منك ' + missed + ' — النقاط: ' + score, score);
}
function draw() {
  cx.fillStyle = '${p.theme.panel}'; cx.fillRect(0, 0, W, H);
  bubbles.forEach(b => { cx.fillStyle = '${p.theme.bubble}'; cx.beginPath(); cx.arc(b.x, b.y, b.r, 0, 7); cx.fill();
    cx.font = FONT(b.r * 1.1); cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(b.e, b.x, b.y); });
}
setInterval(() => { if (paused) return; step(); draw(); }, 16);
setScore('🫧 0');
`,
};

// ───────────────────────────── the catalogue ─────────────────────────────

const THEMES = {
  neon: { bg: '#0b0b12', panel: '#141422', fg: '#e8e8f2', accent: '#7c3aed', enemy: '#06b6d4', snake: '#a78bfa', wall: '#333355', hole: '#000000', open: '#22223a', done: '#14532d', pipe: '#7c3aed', ground: '#7c3aed', wait: '#b71c1c', go: '#2e7d32', bubble: '#7c3aed55', bricks: ['#7c3aed', '#06b6d4', '#ec4899', '#f59e0b', '#22c55e'], empty: '#22223a' },
  candy: { bg: '#fff1f2', panel: '#ffe4e6', fg: '#881337', accent: '#f43f5e', enemy: '#0ea5e9', snake: '#fb7185', wall: '#fda4af', hole: '#9f1239', open: '#fff1f2', done: '#86efac', pipe: '#f43f5e', ground: '#f43f5e', wait: '#dc2626', go: '#16a34a', bubble: '#f43f5e44', bricks: ['#f43f5e', '#fb923c', '#facc15', '#4ade80', '#38bdf8'], empty: '#fecdd3' },
  forest: { bg: '#052e16', panel: '#14532d', fg: '#dcfce7', accent: '#22c55e', enemy: '#facc15', snake: '#4ade80', wall: '#166534', hole: '#052e16', open: '#166534', done: '#a3e635', pipe: '#16a34a', ground: '#22c55e', wait: '#b91c1c', go: '#65a30d', bubble: '#22c55e44', bricks: ['#16a34a', '#65a30d', '#ca8a04', '#0d9488', '#4d7c0f'], empty: '#166534' },
  space: { bg: '#020617', panel: '#0f172a', fg: '#e2e8f0', accent: '#38bdf8', enemy: '#f472b6', snake: '#7dd3fc', wall: '#1e293b', hole: '#020617', open: '#1e293b', done: '#34d399', pipe: '#38bdf8', ground: '#38bdf8', wait: '#be123c', go: '#059669', bubble: '#38bdf844', bricks: ['#38bdf8', '#818cf8', '#f472b6', '#fbbf24', '#34d399'], empty: '#1e293b' },
  desert: { bg: '#451a03', panel: '#78350f', fg: '#fef3c7', accent: '#f59e0b', enemy: '#ef4444', snake: '#fbbf24', wall: '#92400e', hole: '#451a03', open: '#92400e', done: '#84cc16', pipe: '#f59e0b', ground: '#f59e0b', wait: '#b91c1c', go: '#4d7c0f', bubble: '#f59e0b44', bricks: ['#f59e0b', '#d97706', '#b45309', '#ea580c', '#facc15'], empty: '#92400e' },
};

const G = [];
const game = (slug, ar, en, engine, theme, params, meta) =>
  G.push(Object.assign({ slug, ar, en, engine, theme, params }, meta));

// snake ×4
game('snake-classic', 'الثعبان الكلاسيكي', 'Classic Snake', 'snake', 'forest', { grid: 17, speed: 5 }, {
  categories: ['arcade', 'classic'], tags: ['snake', 'classic', 'retro'], emoji: '🐍',
  ar_desc: 'النسخة التي يعرفها الجميع: قُد الثعبان نحو التفاح دون أن يعضّ ذيله. كل تفاحة تطيله خطوة وتضيف عشر نقاط.',
  instructions: 'الأسهم أو السحب لتغيير الاتجاه. الالتفاف حول الحواف مسموح، لكن الاصطدام بالجسد أو بالجدران ينتهي اللعبة.',
});
game('snake-turbo', 'الثعبان توربو', 'Turbo Snake', 'snake', 'neon', { grid: 19, speed: 3 }, {
  categories: ['arcade', 'action'], tags: ['snake', 'fast', 'neon'], emoji: '⚡',
  ar_desc: 'الثعبان نفسه بسرعة مضاعفة وشبكة أوسع: انعكاسات أسرع من أن تفكر فيها. للاعبين ذوي الأعصاب الباردة فقط.',
  instructions: 'الأسهم أو السحب. السرعة هنا أعلى من النسخة الكلاسيكية بمرتين — خطط لمسارك قبل أن تحتاجه.',
});
game('snake-maze', 'ثعبان المتاهة', 'Maze Snake', 'snake', 'space', { grid: 17, speed: 5, walls: [[8, 4], [8, 5], [8, 6], [8, 10], [8, 11], [8, 12], [4, 8], [5, 8], [6, 8], [10, 8], [11, 8], [12, 8]] }, {
  categories: ['puzzle', 'brain'], tags: ['snake', 'maze', 'hard'], emoji: '🌀',
  ar_desc: 'جدران صلبة تقطع الملعب إلى ممرات: الثعبان الكلاسيكي يصبح لغزًا حركيًا حيث كل منعطف قرار.',
  instructions: 'الأسهم أو السحب. الجدران الزرقاء قاتلة مثل ذيلك تمامًا — استخدم الممرات الأربعة بحذر.',
});
game('snake-kids', 'ثعبان الأطفال', 'Kids Snake', 'snake', 'candy', { grid: 12, speed: 8 }, {
  categories: ['kids', 'mobile'], tags: ['snake', 'kids', 'easy'], emoji: '🍭',
  ar_desc: 'شبكة كبيرة وخيوط بطيئة وألوان حلوى: أول ثعبان يصلح لطفل يتعلم الأسهم اليوم.',
  instructions: 'الأسهم أو السحب على الشاشة. اللعبة متسامحة: شبكة واسعة وسرعة هادئة.',
});

// breakout ×4
game('brick-blaster', 'محطّم الطوب', 'Brick Blaster', 'breakout', 'neon', { rows: 5, ballSpeed: 5, paddleW: 110 }, {
  categories: ['arcade', 'classic'], tags: ['breakout', 'bricks', 'classic'], emoji: '🧱',
  ar_desc: 'مضرب وكرة وخمسة صفوف من الطوب: فيزياء بسيطة وإدمان خالص. الزوايا التي تضرب بها الكرة تصنعها أنت.',
  instructions: 'حرّك المضرب بالفأرة أو اللمس أو الأسهم. أصب الطوب كله لتفوز، ولا تدع الكرة تسقط.',
});
game('brick-candy', 'طوب الحلوى', 'Candy Bricks', 'breakout', 'candy', { rows: 4, ballSpeed: 4, paddleW: 130 }, {
  categories: ['kids', 'arcade'], tags: ['breakout', 'kids', 'colorful'], emoji: '🍬',
  ar_desc: 'نسخة بطيئة وملوّنة من محطّم الطوب بمضرب عريض: مثالية للأطفال وأول تجربة مع ألعاب الفيزياء.',
  instructions: 'حرّك المضرب باللمس أو الفأرة. أربعة صفوف فقط ومضرب واسع — لكنه يتطلّب دقة nonetheless.',
});
game('brick-storm', 'عاصفة الطوب', 'Brick Storm', 'breakout', 'space', { rows: 7, ballSpeed: 6.5, paddleW: 86 }, {
  categories: ['action', 'arcade'], tags: ['breakout', 'hard', 'fast'], emoji: '☄️',
  ar_desc: 'سبعة صفوف، كرة أسرع، ومضرب أضيق: نسخة الاختبار التي تفصل لاعب الطوب عن هاويه.',
  instructions: 'الفأرة أو اللمس. كل ارتداد من طرف المضرب يضيف زاوية للكرة — استخدمها عمدًا.',
});

// pong ×3
game('pong-duel', 'بونج ضد الحاسوب', 'Pong Duel', 'pong', 'neon', { speed: 5, ai: 4.2, paddle: 90, win: 7 }, {
  categories: ['sports', 'two-player'], tags: ['pong', 'ai', 'classic'], emoji: '🏓',
  ar_desc: 'أقدم مباراة في تاريخ ألعاب الفيديو: أنت والحاسوب وسبع نقاط تفصل بينكما. الخصم يتحسّن كلما طال rally.',
  instructions: 'حرّك مضربك بالفأرة أو اللمس أو السهمين. أول من يصل إلى سبع نقاط يفوز.',
});
game('pong-rookie', 'بونج للمبتدئين', 'Pong Rookie', 'pong', 'candy', { speed: 4, ai: 2.6, paddle: 120, win: 5 }, {
  categories: ['kids', 'sports'], tags: ['pong', 'easy', 'kids'], emoji: '🎾',
  ar_desc: 'خصم لطيف ومضرب عريض وخمس نقاط فقط: تعلّم البونج دون إحباط.',
  instructions: 'الفأرة أو اللمس أو الأسهم. خمس نقاط تنهي المباراة.',
});
game('pong-pro', 'بونج المحترفين', 'Pong Pro', 'pong', 'space', { speed: 7, ai: 6.4, paddle: 70, win: 9 }, {
  categories: ['sports', 'action'], tags: ['pong', 'hard', 'reflex'], emoji: '🥇',
  ar_desc: 'كرة بسرعة جنونية وخصم لا يخطئ تقريبًا ومضرب بحجم إصبع: تحدي البونج النهائي.',
  instructions: 'الفأرة أو اللمس. تسع نقاط للفوز — ولن تحصل عليها بسهولة.',
});

// 2048 ×3
game('volt-2048-merge', 'دمج ٢٠٤٨', 'Merge 2048', 'g2048', 'desert', { size: 4 }, {
  categories: ['puzzle', 'brain'], tags: ['2048', 'merge', 'math'], emoji: '🔢',
  ar_desc: 'ادفع البلاطات واجمع المتشابهين حتى تولد بلاطة ٢٠٤٨. لعبة تبدو حسابية وهي في الحقيقة تخطيط للمساحة.',
  instructions: 'الأسهم أو السحب على الشاشة. كل دفعة تحرك كل البلاطات، وكل دمج يضيف نقاطًا.',
});
game('volt-1024-mini', 'دمج ١٠٢٤ المصغّر', 'Mini 1024', 'g2048', 'candy', { size: 3 }, {
  categories: ['kids', 'puzzle'], tags: ['2048', 'mini', 'easy'], emoji: '🧮',
  ar_desc: 'شبكة ٣×٣ وهدف ١٠٢٣: نسخة الجيب السريعة من لعبة الدمج، تنتهي جولتها في دقيقتين.',
  instructions: 'الأسهم أو السحب. المساحة الضيقة تعني أن كل حركة خطأ قاتلة.',
});
game('volt-4096-titan', 'دمج ٤٠٩٦ تيتان', 'Titan 4096', 'g2048', 'space', { size: 5 }, {
  categories: ['puzzle', 'brain'], tags: ['2048', 'hard', '5x5'], emoji: '🧠',
  ar_desc: 'شبكة ٥×٥ وهدف ٤٠٩٦: مساحة أوسع تعني احتمالات أكثر وقرارات أصعب. للاعبين الذين أنهوا ٢٠٤ ولم يشبعوا.',
  instructions: 'الأسهم أو السحب. خطط لزوايا الدمج مبكرًا — الشبكة الكبيرة تخدع.',
});

// memory ×4
game('memory-zoo', 'ذاكرة الحيوانات', 'Animal Memory', 'memory', 'forest', { cols: 4, emoji: ['🦁', '🐘', '🐵', '🦊', '', ''] }, {
  categories: ['kids', 'brain'], tags: ['memory', 'animals', 'kids'], emoji: '🦁',
  ar_desc: 'اقلب البطاقات واعثر على الأزواج: اثنا عشر حيوانًا يختبئون في شبكة، وذاكرتك هي الأداتك الوحيدة.',
  instructions: 'اضغط بطاقة لقلبها، ثم ثانية. إن تطابقتا بقيتا مكشوفتين. أقل محاولات = نتيجة أفضل.',
});
game('memory-fruits', 'ذاكرة الفواكه', 'Fruit Memory', 'memory', 'candy', { cols: 4, emoji: ['🍎', '🍇', '🍌', '', '🍍', '🥝'] }, {
  categories: ['kids', 'puzzle'], tags: ['memory', 'fruits', 'family'], emoji: '🍉',
  ar_desc: 'نسخة الفواكه المنعشة من لعبة الذاكرة: ألوان زاهية تساعد العين وتخادع الذاكرة في الوقت نفسه.',
  instructions: 'اضغط لقلب بطاقتين. الأزواج المتطابقة تبقى مكشوفة حتى إنهاء اللوح.',
});
game('memory-space', 'ذاكرة الفضاء', 'Space Memory', 'memory', 'space', { cols: 4, emoji: ['🚀', '🌙', '⭐', '🪐', '☄️', '👽'] }, {
  categories: ['adventure', 'brain'], tags: ['memory', 'space'], emoji: '🚀',
  ar_desc: 'كواكب ومذنّبات ومخلوقات: لوحة ذاكرة بطابع فضائي لمن يحفظ النجوم أسرع من زملائه.',
  instructions: 'اقلب بطاقتين في كل دور. طابق كل الأزواج لتنهي الجولة.',
});
game('memory-math', 'ذاكرة الأرقام', 'Number Memory', 'memory', 'neon', { cols: 4, emoji: ['➕', '➖', '✖️', '➗', '🟰', '💯'] }, {
  categories: ['puzzle', 'brain'], tags: ['memory', 'math', 'school'], emoji: '➕',
  ar_desc: 'رموز العمليات الحسابية بدل الصور: نسخة المدرسين من لعبة الذاكرة، وأصعب مما تبدو.',
  instructions: 'اقلب وطابق الرموز المتشابهة. ستكتشف أن الرموز المجردة أصغر على الذاكرة من الصور.',
});

// whack ×3
game('whack-mole', 'اضرب الخلد', 'Whack-a-Mole', 'whack', 'forest', { holes: 9, seconds: 30, interval: 780, emoji: '🐹' }, {
  categories: ['kids', 'arcade'], tags: ['whack', 'reflex', 'classic'], emoji: '🔨',
  ar_desc: 'ثلاثون ثانية وتسع جحور وخلد واحد سريع: اختبر سرعة إصبعك في كلاسيكية الملاهي.',
  instructions: 'اضغط على الخلد حين يظهر. كل إصابة نقطة، والوقت لا يرحم.',
});
game('whack-alien', 'اصطد الفضائي', 'Alien Whack', 'whack', 'space', { holes: 9, seconds: 25, interval: 620, emoji: '👾' }, {
  categories: ['action', 'arcade'], tags: ['whack', 'space', 'fast'], emoji: '👾',
  ar_desc: 'غزاة صغار يطلّون من فوهات الفضاء: نسخة أسرع وأقسى من اضرب الخلد.',
  instructions: 'اضغط الفضائي قبل أن يختفي. الظهور هنا أقصر من نسخة الخلد.',
});
game('whack-robot', 'أوقف الروبوت', 'Robot Whack', 'whack', 'neon', { holes: 9, seconds: 20, interval: 480, emoji: '🤖' }, {
  categories: ['action', 'shooting'], tags: ['whack', 'robots', 'extreme'], emoji: '🤖',
  ar_desc: 'روبوتات متمردة تومض لأقل من نصف ثانية: الوضع الأقصى لسلسلة اضرب-واختفِ.',
  instructions: 'عشرون ثانية فقط. ردّة فعلك هي كل ما تملك.',
});

// flappy ×3
game('flappy-volt', 'الطائر الفولتي', 'Flappy Volt', 'flappy', 'neon', { gap: 170, gravity: 0.5, jump: 8.4, speed: 3, every: 90, emoji: '🐤' }, {
  categories: ['arcade', 'mobile'], tags: ['flappy', 'one-button', 'hard'], emoji: '🐤',
  ar_desc: 'نقرة واحدة للرفرفة وأنابيب لا تنتهي: أبسط تحكم في الموقع وأكثره إدمانًا.',
  instructions: 'اضغط أو مسطرة المسافة للرفرفة. مرّ بين الأنابيب لتسجل نقطة لكل بوابة.',
});
game('rocket-rise', 'ارتفاع الصاروخ', 'Rocket Rise', 'flappy', 'space', { gap: 150, gravity: 0.55, jump: 9, speed: 3.6, every: 80, emoji: '🚀' }, {
  categories: ['action', 'adventure'], tags: ['flappy', 'space', 'rocket'], emoji: '🚀',
  ar_desc: 'صاروخ بفوهات حساسة وفجوات أضيق: نسخة الفضاء من mechanics الرفرفة، بثوب نيون.',
  instructions: 'نقرة = دفعة. الفجوات هنا أضيق والأنابيب أسرع من النسخة الكلاسيكية.',
});
game('balloon-sky', 'بالون السماء', 'Balloon Sky', 'flappy', 'candy', { gap: 200, gravity: 0.42, jump: 7.6, speed: 2.6, every: 100, emoji: '🎈' }, {
  categories: ['kids', 'mobile'], tags: ['flappy', 'kids', 'easy'], emoji: '🎈',
  ar_desc: 'بالون لطيف وفجوات واسعة وجاذبية رحيمة: مدخل الأطفال إلى عائلة الرفرفة.',
  instructions: 'اضغط ليرتفع البالون. المسافة بين السحب واسعة لتناسب الصغار.',
});

// runner ×3
game('desert-dash', 'عدو الصحراء', 'Desert Dash', 'runner', 'desert', { speed: 6, jump: 15, gravity: 0.8, every: 60, emoji: '🏃', obsEmoji: '🌵', flyEmoji: '🦅' }, {
  categories: ['racing', 'action'], tags: ['runner', 'endless', 'jump'], emoji: '🏃',
  ar_desc: 'اركض بين صبار الصحراء ونسورها: قفز فوق الأرضي وانحنِ تحت الطائر، والسرعة تزيد كل ثوانٍ.',
  instructions: 'نقرة/مسطرة للقفز، ونقرة على أسفل الشاشة أو السهم الأسفل للانزلاق.',
});
game('neon-runner', 'عدّاء النيون', 'Neon Runner', 'runner', 'neon', { speed: 7.5, jump: 16, gravity: 0.85, every: 52, emoji: '🛼', obsEmoji: '🚧', flyEmoji: '🛸' }, {
  categories: ['racing', 'arcade'], tags: ['runner', 'neon', 'fast'], emoji: '🛼',
  ar_desc: 'مدينة نيون وأطباق طائرة وحواجز: نسخة أسرع من العدو اللانهائي بإيقاع لا يهدأ.',
  instructions: 'اقفز بالحواجز الأرضية وانزلق تحت الأطباق. السرعة تتصاعد تلقائيًا.',
});
game('jungle-jump', 'قفز الغابة', 'Jungle Jump', 'runner', 'forest', { speed: 5.4, jump: 14.5, gravity: 0.75, every: 66, emoji: '🐒', obsEmoji: '🪨', flyEmoji: '🦇' }, {
  categories: ['kids', 'adventure'], tags: ['runner', 'jungle', 'family'], emoji: '🐒',
  ar_desc: 'قرد وصخور وخفافيش: عدو غابة بوتيرة ألطف تناسب اللاعبين الصغار والمبتدئين.',
  instructions: 'نقرة للقفز فوق الصخور، ونقرة سفلية للانزلاق تحت الخفافيش.',
});

// mines ×3
game('mine-sweeper-easy', 'كانس الألغام المبتدئ', 'Minesweeper Easy', 'mines', 'forest', { grid: 9, mines: 10 }, {
  categories: ['puzzle', 'brain'], tags: ['minesweeper', 'logic', 'classic'], emoji: '💣',
  ar_desc: 'تسعٌ في تسعة وعشرة ألغام: المنطق الخالص في أنقى صوره — الأرقام تخبرك وأنت تستنتج.',
  instructions: 'انقر لفتح خلية، وزر الفأرة الأيمن (أو Alt مع اللمس) لوضع علم. أول نقرة آمنة دائمًا.',
});
game('mine-sweeper-pro', 'كانس الألغام المحترف', 'Minesweeper Pro', 'mines', 'neon', { grid: 12, mines: 24 }, {
  categories: ['puzzle', 'brain'], tags: ['minesweeper', 'hard', 'logic'], emoji: '🧨',
  ar_desc: 'اثنتا عشرة خانة وأربعة وعشرون لغمًا: شبكة المحترفين حيث كل تخمين غير محسوب خيانة للمنطق.',
  instructions: 'افتح بالخيار الآمن وضع الأعلام بالاستنتاج. لا تخمّن إلا مضطرًا.',
});

// ttt ×2
game('xo-classic', 'إكس أو الكلاسيكية', 'Tic Tac Toe', 'ttt', 'candy', { x: '❌', o: '⭕' }, {
  categories: ['kids', 'two-player', 'classic'], tags: ['xo', 'tic-tac-toe', 'family'], emoji: '❌',
  ar_desc: 'ثلاثة في صف ضد حاسوب لا يخطئ: أقدم لعبة تفكير عرفتها البشرية، بخوارزمية كاملة.',
  instructions: 'اضغط مربعًا للعب ❌. الحاسوب يلعب ⭕ بأفضل حركة ممكنة — حاول التعادل على الأقل.',
});
game('xo-neon', 'إكس أو نيون', 'Neon XO', 'ttt', 'neon', { x: '⚡', o: '🔥' }, {
  categories: ['arcade', 'two-player'], tags: ['xo', 'neon'], emoji: '⚡',
  ar_desc: 'القواعد نفسها ببرق ونار: نسخة النيون من إكس أو لمن ملّ الرموز التقليدية.',
  instructions: 'اضغط للعب ⚡ ضد 🔥. ثلاثة على خط تفوز.',
});

// reaction ×2
game('reaction-bolt', 'سرعة البرق', 'Lightning Reflex', 'reaction', 'neon', { rounds: 5 }, {
  categories: ['action', 'brain'], tags: ['reaction', 'reflex', 'test'], emoji: '⚡',
  ar_desc: 'خمس جولات من الانتظار الأخضر: قِس سرعة استجابتك بالمللي ثانية ونافس أصدقاءك على المتوسط.',
  instructions: 'انتظر تحول الشاشة إلى الأخضر ثم اضغط بأسرع ما يمكنك. الضغط المبكر يلغي الجولة.',
});
game('reaction-focus', 'بوابة التركيز', 'Focus Gate', 'reaction', 'space', { rounds: 8 }, {
  categories: ['brain', 'puzzle'], tags: ['reaction', 'focus', 'endurance'], emoji: '🎯',
  ar_desc: 'ثماني جولات متتالية: اختبار تركيز أكثر منه اختبار سرعة، فالتعب في الجولة السادسة عدوّك الحقيقي.',
  instructions: 'اضغط عند الأخضر فقط. متوسطك النهائي هو نتيجتك.',
});

// slide ×2
game('slide-fifteen', 'لغز الخمسة عشر', 'Fifteen Puzzle', 'slide', 'desert', { size: 4, shuffles: 90 }, {
  categories: ['puzzle', 'brain'], tags: ['slide', '15-puzzle', 'classic'], emoji: '🧩',
  ar_desc: 'خمس عشرة بلاطة وخانة فارغة واحدة: اللغز الذي حيّر العالم في ١٨٨٠ وما يزال يصنع أبطالًا.',
  instructions: 'اضغط بلاطة مجاورة للفراغ لانزلاقها. رتّب الأرقام تصاعديًا.',
});
game('slide-eight', 'لغز الثمانية السريع', 'Quick Eight', 'slide', 'candy', { size: 3, shuffles: 40 }, {
  categories: ['kids', 'puzzle'], tags: ['slide', 'easy', 'kids'], emoji: '🟦',
  ar_desc: 'نسخة ٣×٣ الدافئة من لغز الانزلاق: تُحل في دقائق وتعلّم الأطفال تخطيط الحركة.',
  instructions: 'انقر بلاطة ملاصقة للفراغ. الهدف: ترتيب ١ إلى ٨.',
});

// stroop ×2
game('stroop-colors', 'خِداع الألوان', 'Stroop Colors', 'stroop', 'candy', { seconds: 30, mode: 'ink' }, {
  categories: ['brain', 'puzzle'], tags: ['stroop', 'focus', 'tricky'], emoji: '🎨',
  ar_desc: 'كلمة «أحمر» مكتوبة بالحبر الأزرق: دماغك يقرأ وعينك ترى، وأيهما يفوز يحدد نتيجتك. اختبار ستروب الشهير بصورة لعبة.',
  instructions: 'يمين/١ إن كان لون الحبر مطابقًا لمعنى الكلمة، ويسار/٢ إن لم يكن. ثلاثون ثانية.',
});
game('stroop-reverse', 'انعكاس ستروب', 'Stroop Reverse', 'stroop', 'neon', { seconds: 25, mode: 'word' }, {
  categories: ['brain', 'action'], tags: ['stroop', 'hard', 'reverse'], emoji: '🔄',
  ar_desc: 'النسخة المعكوسة: حكِّم معنى الكلمة لا لونها. أصعب بخمس وعشرين ثانية مما تتوقع.',
  instructions: 'يمين = الكلمة تطابق لون الحبر، يسار = لا. نعم، التعليمات معاكسة للنسخة الأخرى عمدًا.',
});

// clicker ×2
game('gold-clicker', 'منجم الذهب', 'Gold Clicker', 'clicker', 'desert', {
  emoji: '🪙',
  upgrades: [
    { name: 'فأس أفضل (+1/نقرة)', base: 25, owned: 0, kind: 'click', power: 1 },
    { name: 'عامل آلي (+1/ث)', base: 60, owned: 0, kind: 'auto', power: 1 },
    { name: 'ديناميت (+5/ث)', base: 400, owned: 0, kind: 'auto', power: 5 },
  ],
}, {
  categories: ['adventure', 'kids'], tags: ['clicker', 'idle', 'gold'], emoji: '🪙',
  ar_desc: 'انقر العملة واشترِ فؤوسًا وعمالًا وديناميت: لعبة الخمول التي تكبر وأنت تشرب الشاي.',
  instructions: 'اضغط الدائرة الذهبية لجمع العملات، واشترِ الترقيات من الأزرار أسفل الشاشة.',
});
game('energy-clicker', 'مولّد الطاقة', 'Energy Clicker', 'clicker', 'neon', {
  emoji: '⚡',
  upgrades: [
    { name: 'بطارية (+1/نقرة)', base: 20, owned: 0, kind: 'click', power: 1 },
    { name: 'لوح شمسي (+2/ث)', base: 80, owned: 0, kind: 'auto', power: 2 },
    { name: 'مفاعل (+8/ث)', base: 500, owned: 0, kind: 'auto', power: 8 },
  ],
}, {
  categories: ['adventure', 'arcade'], tags: ['clicker', 'idle', 'energy'], emoji: '⚡',
  ar_desc: 'ابنِ إمبراطورية كهرباء من نقرات: بطاريات وألواح شمسية ومفاعل ينتجون وأنت غائب.',
  instructions: 'انقر المولّد واجمع الفولتات، ثم استثمر في الإنتاج التلقائي.',
});

// bubble ×3
game('bubble-pop', 'فرقعة الفقاعات', 'Bubble Pop', 'bubble', 'space', { every: 40, speed: 1.6, min: 18, max: 40, miss: 12, emoji: '🫧' }, {
  categories: ['kids', 'mobile'], tags: ['bubble', 'tap', 'relax'], emoji: '🫧',
  ar_desc: 'فقاعات تصعد بهدوء وفرقعتها بصوت مكتوم: لعبة الاسترخاء الأولى في الموقع، والنقاط للفقاعات الأصغر.',
  instructions: 'اضغط الفقاعة قبل أن تخرج من الأعلى. الصغيرة تساوي نقاطًا أكثر.',
});
game('balloon-pop-fair', 'فرقعة البالونات', 'Balloon Fair', 'bubble', 'candy', { every: 32, speed: 2.1, min: 20, max: 44, miss: 10, emoji: '🎈' }, {
  categories: ['kids', 'arcade'], tags: ['balloon', 'tap', 'fair'], emoji: '🎈',
  ar_desc: 'مدينة ملاهٍ كاملة من البالونات الطائرة: فرقّعها قبل أن تهرب إلى السماء.',
  instructions: 'اضغط البالونات الصاعدة. إن أفلتت عشرة انتهت الجولة.',
});
game('meteor-guard', 'حارس النيازك', 'Meteor Guard', 'bubble', 'neon', { every: 24, speed: 2.8, min: 16, max: 34, miss: 8, emoji: '☄️' }, {
  categories: ['action', 'shooting'], tags: ['meteor', 'fast', 'defense'], emoji: '☄️',
  ar_desc: 'نيازك صاعدة (نعم، صاعدة — الجاذبية هنا اقتراح) ومهمتك تفجيرها قبل الإفلات: نسخة الأكشن من سلسلة الفرقعة.',
  instructions: 'اضغط النيزك لتفجيره. ثمانية إفلاتات تخسر المهمة.',
});

// ───────────────────────────── emit everything ─────────────────────────────

const DEVELOPER = 'Voltade Studio';
const RATINGS = [4.2, 4.5, 4.7, 4.0, 4.8, 4.3, 4.6, 4.1, 4.4, 4.9];
const PLAYS = [1840, 5230, 9120, 2600, 15400, 7300, 4100, 11200, 3300, 8600, 2100, 6400];
const SIZES = {
  snake: [560, 560], breakout: [720, 520], pong: [720, 480], g2048: [520, 560], memory: [600, 560],
  whack: [560, 560], flappy: [520, 640], runner: [760, 420], mines: [560, 560], ttt: [520, 520],
  reaction: [640, 440], slide: [520, 520], stroop: [640, 440], clicker: [560, 620], bubble: [560, 640],
};

function thumbSvg(g) {
  const t = THEMES[g.theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.bg}"/><stop offset="1" stop-color="${t.panel}"/></linearGradient></defs>
  <rect width="480" height="360" rx="28" fill="url(#g)"/>
  <circle cx="392" cy="72" r="120" fill="${t.accent}" opacity="0.22"/>
  <circle cx="64" cy="308" r="90" fill="${t.enemy}" opacity="0.16"/>
  <text x="240" y="176" font-size="112" text-anchor="middle">${g.emoji}</text>
  <text x="240" y="286" font-size="34" font-weight="700" text-anchor="middle" fill="${t.fg}" font-family="system-ui, sans-serif">${g.ar}</text>
</svg>`;
}

function bannerSvg(g) {
  const t = THEMES[g.theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.bg}"/><stop offset="1" stop-color="${t.panel}"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="1020" cy="120" r="220" fill="${t.accent}" opacity="0.2"/>
  <circle cx="150" cy="540" r="170" fill="${t.enemy}" opacity="0.14"/>
  <text x="600" y="330" font-size="190" text-anchor="middle">${g.emoji}</text>
  <text x="600" y="490" font-size="64" font-weight="700" text-anchor="middle" fill="${t.fg}" font-family="system-ui, sans-serif">${g.ar}</text>
  <text x="600" y="560" font-size="30" text-anchor="middle" fill="${t.fg}" opacity="0.7" font-family="system-ui, sans-serif">${g.en} — Voltade</text>
</svg>`;
}

let bytes = 0;
for (const [index, g] of G.entries()) {
  const [width, height] = SIZES[g.engine];
  const html = shell(Object.assign({}, g, { width, height, theme: THEMES[g.theme] }), engines[g.engine](Object.assign({}, g.params, { theme: THEMES[g.theme] })));
  const dir = join(GAMES_DIR, g.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  writeFileSync(join(dir, 'thumb.svg'), thumbSvg(g));
  writeFileSync(join(dir, 'banner.svg'), bannerSvg(g));
  bytes += html.length;
  void index;
}

const manifest = G.map((g, index) => {
  const [width, height] = SIZES[g.engine];
  return {
    slug: g.slug,
    ar: g.ar,
    en: g.en,
    description: g.ar_desc,
    descriptionEn: `${g.en} — a self-contained HTML5 build from the Voltade demo library.`,
    instructions: g.instructions,
    categories: g.categories,
    tags: g.tags,
    developer: DEVELOPER,
    ageRating: g.categories.includes('kids') ? 'everyone' : index % 5 === 0 ? 'everyone_10' : 'everyone',
    width,
    height,
    sizeKb: Math.max(4, Math.round(6 + (index % 7))),
    featured: index % 9 === 0,
    plays: PLAYS[index % PLAYS.length] + index * 37,
    rating: RATINGS[index % RATINGS.length],
  };
});

writeFileSync(
  MANIFEST,
  `/** GENERATED by tools/gamelib/generate.mjs — do not edit by hand. */\nexport const LIBRARY_GAMES = ${JSON.stringify(manifest, null, 2)} as const;\n`,
);

console.log(`games written: ${G.length} (${(bytes / 1024).toFixed(0)} KiB of HTML) → ${GAMES_DIR}`);
console.log(`manifest       : ${MANIFEST}`);
