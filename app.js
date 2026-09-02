const { useState, useEffect, useCallback, useRef } = React;

// ─── Storage helpers ──────────────────────────────────────────────────────────
const MEALS_KEY = 'macro-tracker-meals';
const GOALS_KEY = 'macro-tracker-goals';
const PROFILE_KEY = 'macro-tracker-profile';
const SPRITES_KEY = 'macro-tracker-sprites';
// profile = { units:'metric'|'imperial', heightCm, weightKg, age, sex:'male'|'female',
//             activity:'sedentary'|'light'|'moderate'|'active'|'veryActive',
//             goalDir:'lose'|'maintain'|'gain' }  — null until onboarding (A3) completes

function storageGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Shared sprite store (base64 keyed by id) — provided by App, consumed by MealCard/MealForm.
const SpriteCtx = React.createContext({ resolve: () => null, add: () => {} });

// ─── Firebase helpers ─────────────────────────────────────────────────────────
function isFirebaseConfigured() {
  const c = window.FIREBASE_CONFIG;
  return !!(c && c.apiKey && c.projectId);
}

function initFirebase() {
  if (!isFirebaseConfigured()) return false;
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    return true;
  } catch(e) { console.error('[Firebase] init failed:', e); return false; }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function toDateKey(date) {
  return date.toISOString().split('T')[0];
}

function today() { return new Date(); }

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a, b) { return toDateKey(a) === toDateKey(b); }

function dateLabel(date) {
  const now = today();
  if (isSameDay(date, now)) return 'Today';
  const yest = addDays(now, -1);
  if (isSameDay(date, yest)) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDay(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Calorie calc ─────────────────────────────────────────────────────────────
function calcCals(protein, carbs, fat) {
  return Math.round((Number(protein) || 0) * 4 + (Number(carbs) || 0) * 4 + (Number(fat) || 0) * 9);
}

// ─── Default goals ────────────────────────────────────────────────────────────
const DEFAULT_GOALS = { protein: 150, carbs: 200, fat: 65, calories: 2000 };

// ─── Goal derivation — Mifflin-St Jeor → TDEE → macro split ───────────────────
// Turns a body profile into { calories, protein, carbs, fat } targets.
// Returns null if the profile is incomplete — caller keeps DEFAULT_GOALS / manual.
const ACTIVITY_MULT = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9 };
const GOAL_DELTA    = { lose: 0.80, maintain: 1.0, gain: 1.15 };  // multiplier on TDEE

function bmrMifflin({ weightKg, heightCm, age, sex }) {
  // 10·kg + 6.25·cm − 5·age + (male ? +5 : −161)
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

function deriveGoals(profile) {
  if (!profile) return null;
  const { weightKg, heightCm, age, sex, activity, goalDir } = profile;
  if (!(weightKg > 0 && heightCm > 0 && age > 0) || !sex || !activity || !goalDir) return null;

  const bmr  = bmrMifflin(profile);
  const tdee = bmr * (ACTIVITY_MULT[activity] || 1.2);
  const calories = tdee * (GOAL_DELTA[goalDir] ?? 1.0);

  // Protein: 1.8 g/kg (2.0 when cutting, to preserve lean mass).
  const proteinG = Math.round((goalDir === 'lose' ? 2.0 : 1.8) * weightKg);
  // Fat: 25% of calories, with a 0.8 g/kg floor so aggressive cuts stay healthy.
  const fatG = Math.max(Math.round((0.25 * calories) / 9), Math.round(0.8 * weightKg));
  // Carbs: whatever calories remain (clamped at 0 for extreme low-cal + high-protein cases).
  const carbsG = Math.max(0, Math.round((calories - proteinG * 4 - fatG * 9) / 4));

  return { calories: Math.round(calories / 10) * 10, protein: proteinG, carbs: carbsG, fat: fatG };
}

// ─── Gamification — XP / level / coins ────────────────────────────────────────
const GAME_KEY = 'macro-tracker-game';
const XP_PER_MEAL   = 25;
const COINS_PER_MEAL = 10;
const GOAL_XP_BONUS   = 100;   // awarded when the day's calorie goal is reached
const GOAL_COIN_BONUS = 50;

// Level curve: level N → N+1 costs N·125 XP (so LV.12 → 1,500 to next, matching the design mock).
function xpToNext(level) { return level * 125; }

function applyRewards(game, addXp, addCoins) {
  let { level, xp, coins } = game || { level: 1, xp: 0, coins: 0 };
  xp += addXp; coins += addCoins;
  while (xp >= xpToNext(level)) { xp -= xpToNext(level); level++; }
  return { level, xp, coins };
}

// Seed a starting level/coins from meals already logged, so returning users don't restart at zero.
function seedGame(meals) {
  const total = Object.values(meals || {}).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  return applyRewards({ level: 1, xp: 0, coins: 0 }, total * XP_PER_MEAL, total * COINS_PER_MEAL);
}

// Did the user log ≥1 meal on the day `offset` days before today?
function loggedOnDayOffset(meals, offset) {
  return ((meals[toDateKey(addDays(today(), -offset))]) || []).length > 0;
}

// Pet mood for the home scene (see § Character system mapping).
function petMood(meals, justFed) {
  if (justFed) return 'eat';
  const last3Empty = !loggedOnDayOffset(meals, 0) && !loggedOnDayOffset(meals, 1) && !loggedOnDayOffset(meals, 2);
  if (last3Empty) return 'angry';
  const past2Logged = loggedOnDayOffset(meals, 0) && loggedOnDayOffset(meals, 1);
  return past2Logged ? 'happy' : 'idle';
}

// ─── Character system — sprite sheet ─────────────────────────────────────────
// Sheet: public/assets/character-sprite.png  →  1536×1024, 31 frames.
// Background-keyed to transparency and frame-sliced offline (see canary session log).
// Frame index layout:
//   0-2   idle (3)        7-10  walk-up (4)      15-18 walk-right (4)   25-30 angry (6)
//   3-6   walk-down (4)   11-14 walk-left (4)    19-24 eating (6)
// Pet-state mapping (home): idle/happy → idle loop · eat → just-fed · angry → 3-day meal gap.

const SPRITE_PATH = '/assets/character-sprite.png';

const ANIMATIONS = {
  // Hold each eyes-open pose ~2s, then a single-frame blink — reads as natural idle, not fluttering.
  idle:  { frames: [...Array(20).fill(0), 1, ...Array(20).fill(2), 1], fps: 10, loop: true },
  happy: { frames: [...Array(14).fill(0), 1, ...Array(14).fill(2), 1], fps: 10, loop: true },  // livelier blink cadence
  eat:   { frames: [19,20,21,22,23,24],    fps: 4.2, loop: true },
  angry: { frames: [25,26,27,28,29,30],    fps: 3.6, loop: true },
  walkDown:  { frames: [3,4,5,6],          fps: 6.0, loop: true },
  walkUp:    { frames: [7,8,9,10],         fps: 6.0, loop: true },
  walkLeft:  { frames: [11,12,13,14],      fps: 6.0, loop: true },
  walkRight: { frames: [15,16,17,18],      fps: 6.0, loop: true },
};

// Per-frame source rects [sx, sy, sw, sh] in the 1536×1024 sheet (tight bbox per figure).
const FRAME_BBOXES = [
  [51,65,104,209],[188,64,102,210],[320,64,103,210],                                 // 0-2   idle
  [542,90,85,164],[640,90,85,165],[738,90,85,166],[832,90,88,166],                   // 3-6   walk-down
  [1011,85,85,169],[1117,83,83,173],[1216,83,86,173],[1324,85,84,171],               // 7-10  walk-up
  [506,330,74,155],[622,330,82,154],[745,330,80,155],[867,330,81,155],               // 11-14 walk-left
  [1008,330,81,155],[1133,328,80,160],[1248,329,80,159],[1366,330,80,155],           // 15-18 walk-right
  [306,551,93,170],[464,551,99,170],[626,551,100,170],[800,551,94,170],[968,552,93,169],[1124,572,93,149], // 19-24 eating
  [140,787,100,192],[320,786,102,193],[512,789,107,190],[702,789,107,190],[891,789,109,190],[1164,777,124,202], // 25-30 angry
];

// MAX accommodates the tallest frame (idle, h=210) and widest (angry c6, w=124).
const MAX_FRAME_W = 124;
const MAX_FRAME_H = 210;

// Per-frame draw-scale multiplier (default 1). Angry frame 30's character is drawn ~6% larger
// in the source art; shrink it so its height matches the rest of the set (feet stay anchored).
const FRAME_SCALE = { 30: 0.944 };

// Alpha-weighted centroid x within each bbox (for horizontal centering on the baseline).
const FRAME_CENT_X = [
  52.2,50.2,51.7,                          // idle
  42.4,42.8,43.1,46.7,                      // walk-down
  41.2,39.9,43.4,41.1,                      // walk-up
  36.4,39.1,40.2,38.9,                      // walk-left
  42.2,40.2,41.2,40.6,                      // walk-right
  47.8,52.7,53.6,49.4,48.2,48.2,            // eating
  49.5,51.4,53.7,54.0,56.1,63.9,            // angry
];

// Sprite sets — the default (hijabi) plus per-account overrides. Both sheets share the same
// 31-frame index layout (ANIMATIONS); only the sheet image and per-frame geometry differ.
const DEFAULT_SET = { path: SPRITE_PATH, bboxes: FRAME_BBOXES, centX: FRAME_CENT_X, scale: FRAME_SCALE, maxW: MAX_FRAME_W, maxH: MAX_FRAME_H };
const SPRITE_SETS = {
  'alexavonc@gmail.com': {
    path: '/assets/character-sprite-alexa.png',
    bboxes: [[50,58,87,235],[192,58,86,235],[332,58,87,235],[559,80,74,182],[676,80,74,182],[784,80,77,184],[896,80,77,182],[1080,81,74,182],[1193,81,72,181],[1308,81,74,182],[1421,81,73,182],[522,331,75,176],[644,331,78,176],[775,331,76,177],[902,331,78,177],[1058,331,79,179],[1179,332,77,177],[1309,332,78,176],[1429,333,77,176],[114,562,92,181],[310,561,94,182],[493,561,98,182],[681,560,95,183],[869,560,90,183],[1051,560,89,183],[126,784,82,199],[318,782,83,201],[515,781,84,203],[727,779,126,205],[965,776,136,207],[1232,768,128,216]],
    centX: [43.7,42.4,43.3,36.5,36.6,40.2,38.9,36.4,36,36.5,36.1,36,37.8,38,39.2,38.2,37.2,39,38.4,49.8,50.7,54.1,51.9,47.5,47.2,40.8,41.3,41.6,65,69.7,62.7],
    scale: {}, maxW: 136, maxH: 235,
    // The three idle frames redraw the curly hair differently, so alternating 0↔2 reads as a
    // jarring hair "pop". Hold the stable base pose (0) and flash only a quick, occasional blink
    // (1) at the ping-pong turnaround — never switch to the mismatched third pose.
    anims: {
      idle:  { frames: [...Array(20).fill(0), 1], fps: 10, loop: true },
      happy: { frames: [...Array(12).fill(0), 1], fps: 10, loop: true },
    },
  },
  'sashahidanur@gmail.com': {
    path: '/assets/character-sprite-sasha.png',
    bboxes: [[68,68,92,198],[211,68,93,197],[349,71,90,194],[570,83,79,160],[680,83,79,160],[789,83,77,159],[896,83,79,159],[1068,82,78,165],[1185,82,79,166],[1301,83,76,166],[1415,83,75,162],[522,323,78,160],[638,323,81,159],[752,323,85,159],[875,323,82,159],[1048,323,80,160],[1174,323,80,160],[1295,323,80,160],[1410,323,83,160],[126,548,98,174],[304,548,102,174],[472,548,100,174],[638,548,100,174],[804,548,98,174],[980,548,96,174],[131,781,93,196],[320,779,95,198],[512,777,94,200],[718,768,119,209],[944,767,129,210],[1233,766,125,211]],
    centX: [45,44.7,43.7,37.8,38.2,37,37.7,39.3,39.5,38.6,37.5,40.1,42.6,45.3,43.3,36.7,37.2,41.5,43.5,50.1,52.8,52,51.3,50.3,48,44.3,45.4,44.4,65.5,67.8,63.2],
    scale: {}, maxW: 129, maxH: 211,
    // Same AI-sheet caveat as alexa: the idle frames redraw the hair differently, so hold the
    // base pose and flash only a quick blink rather than alternating the mismatched third frame.
    anims: {
      idle:  { frames: [...Array(20).fill(0), 1], fps: 10, loop: true },
      happy: { frames: [...Array(12).fill(0), 1], fps: 10, loop: true },
    },
  },
};
function resolveSpriteSet(email) { return (email && SPRITE_SETS[email.toLowerCase()]) || DEFAULT_SET; }

// Per-path sprite cache — load each sheet once, resolve all its pending callbacks.
const _spriteCache = {};
function loadSprite(path, cb) {
  const e = _spriteCache[path] || (_spriteCache[path] = { img: null, queue: [], loading: false });
  if (e.img) { cb(e.img); return; }
  e.queue.push(cb);
  if (e.loading) return;
  e.loading = true;
  const img = new Image();
  img.src = path;
  img.onload  = () => { e.img = img; e.queue.forEach(fn => fn(img)); e.queue.length = 0; };
  img.onerror = () => console.error('[PetCat] sprite failed:', path);
}

function PetCat({ state = 'idle', size = 160, set = DEFAULT_SET }) {
  const canvasRef   = useRef(null);
  const timerRef    = useRef(null);
  const frameIdxRef = useRef(0);
  const [sprite, setSprite] = useState(null);

  const scale = Math.min(size / set.maxW, size / set.maxH);

  useEffect(() => {
    setSprite(null);
    loadSprite(set.path, img => setSprite(img));
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [set.path]);

  useEffect(() => {
    if (!sprite) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const anim = (set.anims && set.anims[state]) || ANIMATIONS[state] || ANIMATIONS.idle;
    frameIdxRef.current = 0;
    let dir = 1;

    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);

      const fi = anim.frames[frameIdxRef.current];
      const [sx, sy, sw, sh] = set.bboxes[fi];
      const fscale = scale * (set.scale[fi] || 1);
      const dw = Math.round(sw * fscale);
      const dh = Math.round(sh * fscale);
      const dx = Math.round(size / 2 - set.centX[fi] * fscale);
      const dy = size - dh;
      ctx.drawImage(sprite, sx, sy, sw, sh, dx, dy, dw, dh);

      if (anim.loop) {
        frameIdxRef.current += dir;
        if (frameIdxRef.current >= anim.frames.length - 1) dir = -1;
        if (frameIdxRef.current <= 0)                      dir =  1;
      } else {
        frameIdxRef.current++;
        if (frameIdxRef.current >= anim.frames.length) {
          clearInterval(timerRef.current);
          frameIdxRef.current = anim.frames.length - 1;
        }
      }
    };

    tick();
    timerRef.current = setInterval(tick, 1000 / anim.fps);
    return () => clearInterval(timerRef.current);
  }, [state, sprite, size, scale]);

  return React.createElement('canvas', {
    ref:   canvasRef,
    width: size,
    height: size,
    style: { imageRendering: 'pixelated', display: 'block' }
  });
}

function PetHearts({ calPct }) {
  const filled = calPct <= 0 ? 0 : calPct < 0.25 ? 1 : calPct < 0.5 ? 2 : calPct < 0.75 ? 3 : 4;
  return React.createElement('div', { style: { display: 'flex', gap: 5, marginTop: 8 } },
    [0,1,2,3].map(i =>
      React.createElement('svg', {
        key: i, width: 20, height: 20, viewBox: '0 0 24 24',
        style: { display: 'block', opacity: i < filled ? 1 : 0.35 }
      },
        React.createElement('path', {
          d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
          fill: 'white'
        })
      )
    )
  );
}

// ─── Icons (lucide) ──────────────────────────────────────────────────────────
function Icon({ name, size = 20, color = 'currentColor', strokeWidth = 2 }) {
  const el = useRef(null);
  useEffect(() => {
    if (el.current && lucide && lucide[name]) {
      el.current.innerHTML = '';
      const svg = lucide.createElement(lucide[name]);
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
      svg.setAttribute('stroke', color);
      svg.setAttribute('stroke-width', strokeWidth);
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      el.current.appendChild(svg);
    }
  }, [name, size, color, strokeWidth]);
  return React.createElement('span', { ref: el, style: { display: 'inline-flex', alignItems: 'center' } });
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function MacroBar({ label, value, goal, color }) {
  const pct = goal > 0 ? Math.min((value / goal) * 100, 100) : 0;
  const over = goal > 0 && value > goal;
  const barColor = over ? '#ef4444' : pct >= 80 ? '#22c55e' : '#eab308';
  return (
    React.createElement('div', { className: 'flex-1 min-w-0' },
      React.createElement('div', { className: 'text-xs text-gray-500 mb-1' }, label),
      React.createElement('div', { className: 'h-1.5 rounded-full bg-gray-100 overflow-hidden mb-1' },
        React.createElement('div', {
          style: { width: `${pct}%`, backgroundColor: barColor, height: '100%', borderRadius: '9999px', transition: 'width 0.3s' }
        })
      ),
      React.createElement('div', { className: 'text-xs text-gray-400' },
        React.createElement('span', { className: 'text-gray-700 font-medium' }, Math.round(value)),
        `/${goal}g`
      )
    )
  );
}

// ─── Meal Card ────────────────────────────────────────────────────────────────
function MealCard({ meal, onDelete }) {
  const { resolve } = React.useContext(SpriteCtx);
  const spr = resolve(meal);
  const cals = meal.calories || calcCals(meal.protein, meal.carbs, meal.fat);
  return (
    React.createElement('div', { className: 'flex items-center justify-between py-3 border-b border-gray-50 last:border-0' },
      React.createElement('div', { className: 'flex items-center gap-3 flex-1 min-w-0' },
        spr && React.createElement('img', { src: spr, alt: '', style: { width: 40, height: 40, borderRadius: 8, imageRendering: 'pixelated', flexShrink: 0, background: '#f9fafb', objectFit: 'contain' } }),
        React.createElement('div', { className: 'min-w-0' },
        React.createElement('div', { className: 'font-medium text-gray-800 text-sm truncate' }, meal.name),
        meal.serving && React.createElement('div', { className: 'text-xs text-gray-400 mt-0.5' }, meal.serving),
        React.createElement('div', { className: 'flex gap-3 mt-1 text-xs text-gray-500' },
          React.createElement('span', null, `P: ${meal.protein}g`),
          React.createElement('span', null, `C: ${meal.carbs}g`),
          React.createElement('span', null, `F: ${meal.fat}g`)
        )
      )),
      React.createElement('div', { className: 'flex items-center gap-3 ml-2' },
        React.createElement('span', { className: 'text-sm font-semibold text-gray-700' }, `${cals} kcal`),
        React.createElement('button', {
          onClick: () => onDelete(meal.id),
          className: 'text-gray-300 hover:text-red-400 transition-colors'
        }, React.createElement(Icon, { name: 'Trash2', size: 16 }))
      )
    )
  );
}

// ─── Meal Entry Form ──────────────────────────────────────────────────────────
// ─── Pixel-art "digest" sprite ────────────────────────────────────────────────
// Proven gpt-image-1 style prompt; the identified food name is appended per call.
const PIXEL_SPRITE_PROMPT = `Convert this food item into a low-fidelity pixel art game icon.
STYLE RULES:
32x32 or 64x64 pixel art style
Very limited color palette (max 12 colors)
Flat shading (1-2 shades per color)
No gradients
No texture noise
Clean chunky pixels
Strong simple silhouette
Centered composition
Transparent background
DO NOT:
Add realism or fine detail
Add text or labels
Add lighting effects or soft shadows
REFERENCE STYLE:
Retro game item icon (Stardew Valley / Pokemon)
Similar fidelity to simple pixel food icons
OUTPUT:
Clean, minimal, readable pixel icon`;

// Downscale a PNG data URL to size×size with nearest-neighbor — gives the crisp pixel look
// and keeps the stored sprite tiny (a 64px PNG is a few KB, safe to persist with the meal).
function downscaleToSprite(pngDataUrl, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Smoothing ON for downscaling — area-averaging avoids the aliasing that
      // nearest-neighbor produces when shrinking a 1024px source.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = pngDataUrl;
  });
}

// Generate a pixel-art sprite from the captured food photo via the server-side gpt-image-1 proxy.
// Returns a small (64px) PNG data URL, or null on failure — callers save the meal either way.
// Attach the signed-in user's Firebase ID token to a request, for the gated /api proxies.
async function authedFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  try {
    const u = window.firebase && firebase.auth().currentUser;
    if (u) headers['Authorization'] = 'Bearer ' + (await u.getIdToken());
  } catch (e) { /* unauthenticated — the server will answer 401 */ }
  return fetch(url, { ...opts, headers });
}

// Fast deterministic 64-bit hash of a string (an image's base64) — lets us recognize a
// re-uploaded identical photo and reuse its saved macros + sprite instead of re-analysing.
function hashImage(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// The image call takes ~15-20s. On a phone that whole window is fragile — a screen
// lock, an app switch, or a brief network drop aborts the in-flight request. So each
// attempt gets a generous timeout (an AbortController, since fetch has none of its own)
// and we retry once before giving up. Returns {full, thumb}, or null after both attempts
// fail — callers save the meal either way (and stash a photo so it can be regenerated).
// Re-encode any browser-decodable photo into a clean RGBA PNG the OpenAI edits endpoint
// will accept. A phone *gallery* upload ships the raw file — often iOS HEIC or a JPEG with
// a color profile/mode the editor rejects ("Invalid image file or mode") — whereas a camera
// capture is already canvas-encoded JPEG, which is why camera scans worked and uploads didn't.
// Drawing to a canvas normalizes format *and* color mode, and capping the longest side keeps
// the upload small and fast on mobile. Returns {blob, ext}; falls back to the raw file if the
// image can't be decoded (e.g. desktop HEIC), preserving prior behavior.
function normalizeForEdit(dataUrl, maxSide = 1024) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';           // flatten any alpha (photos have none) so JPEG is safe
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => resolve(b ? { blob: b, ext: 'jpg' } : null), 'image/jpeg', 0.9);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function generatePixelSprite(photoDataUrl, foodName) {
  const normalized = await normalizeForEdit(photoDataUrl);
  const { blob, ext } = normalized || await (async () => { const b = await (await fetch(photoDataUrl)).blob(); return { blob: b, ext: b.type === 'image/png' ? 'png' : 'jpg' }; })();
  const buildForm = () => {
    const form = new FormData();
    form.append('model', 'gpt-image-1-mini');
    form.append('image', blob, `food.${ext}`);
    form.append('prompt', `${PIXEL_SPRITE_PROMPT}\nThe food item is: ${foodName || 'a meal'}.`);
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append('background', 'transparent');
    form.append('output_format', 'png');
    form.append('n', '1');
    return form;
  };
  const ATTEMPTS = 2, TIMEOUT_MS = 45000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await authedFetch('/api/openai-image', { method: 'POST', body: buildForm(), signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image in response');
      const full = `data:image/png;base64,${b64}`;          // high-res, shown on the digest flip
      const thumb = await downscaleToSprite(full, 256);      // crisp, deduped in the sprite store
      return { full, thumb };
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e.name === 'AbortError';
      const msg = timedOut ? `Timed out after ${TIMEOUT_MS / 1000}s — the connection may be slow.` : (e.message || String(e));
      console.error(`[pixel sprite] attempt ${attempt}/${ATTEMPTS} failed:`, msg);
      if (attempt === ATTEMPTS) throw new Error(msg);
    }
  }
  throw new Error('Image generation failed.');
}

// A small JPEG of the source photo, stashed on a meal whose sprite failed so the pixel
// art can be regenerated later without re-scanning. Kept tiny and local-only (stripped
// from the Firestore payload) to stay well clear of the 1 MiB document limit.
function compactPhoto(dataUrl, size = 320) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, size / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      try { resolve(canvas.toDataURL('image/jpeg', 0.6)); } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ─── Digest overlay — full-screen "digesting" sequence for a scanned meal ──────
// progress ring (clockwise from 12, fills while the sprite generates) -> coin-flip
// from photo to pixel sprite -> bites taken out -> "Digested!" -> auto-close.
// onDone(sprite|null) fires at the end; the caller adds the meal there.
function DigestOverlay({ photo, foodName, makeSprite, onDone }) {
  const [pct, setPct]       = useState(0);
  const [phase, setPhase]   = useState('progress');  // progress | flip | done | failed
  const [sprite, setSprite] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const spriteRef   = useRef(null);
  const resolvedRef = useRef(false);
  const runIdRef    = useRef(0);

  // (Re)start generation. A run-id guards against a stale attempt resolving after a retry.
  const runGen = useCallback(() => {
    const runId = ++runIdRef.current;
    resolvedRef.current = false;
    spriteRef.current = null;
    setSprite(null);
    setErrMsg('');
    setPct(0);
    setPhase('progress');
    Promise.resolve().then(makeSprite)
      .then(s => { if (runId === runIdRef.current) { spriteRef.current = s || null; setSprite(s || null); } })
      .catch(e => { if (runId === runIdRef.current) { spriteRef.current = null; setSprite(null); setErrMsg(e?.message || 'Something went wrong.'); } })
      .finally(() => { if (runId === runIdRef.current) resolvedRef.current = true; });
  }, [makeSprite]);

  // Kick off generation (or cached reuse) once on mount.
  useEffect(() => { runGen(); }, []);

  // Ring fill: ease toward 0.9 while the sprite is pending, then snap to 1 once resolved.
  useEffect(() => {
    if (phase !== 'progress') return;
    let raf;
    const loop = () => {
      setPct(prev => {
        const ceiling = resolvedRef.current ? 1 : 0.9;
        const next = prev + (ceiling - prev) * 0.045;
        return next > 0.999 ? 1 : next;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Advance out of progress once the ring is full and generation resolved.
  // Success flips to the sprite; failure stops on a card that waits for the user.
  useEffect(() => {
    if (phase === 'progress' && resolvedRef.current && pct >= 1) {
      setPhase(spriteRef.current ? 'flip' : 'failed');
    }
  }, [pct, phase]);

  // Timed phase transitions — success path only. 'failed' holds until the user chooses.
  useEffect(() => {
    if (phase === 'flip') { const t = setTimeout(() => setPhase('done'), 1500); return () => clearTimeout(t); }
    if (phase === 'done') { const t = setTimeout(() => onDone(spriteRef.current ? spriteRef.current.thumb : null), 950); return () => clearTimeout(t); }
  }, [phase]);

  const BOX = 260, R = 122, SW = 3, CX = 130, CY = 130, C = 2 * Math.PI * R;
  const flipped = phase !== 'progress' && !!sprite;  // only flip when there's a sprite to reveal

  const ticks = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * 30 - 90) * Math.PI / 180;
    ticks.push(React.createElement('line', {
      key: k,
      x1: CX + (R - 7) * Math.cos(a), y1: CY + (R - 7) * Math.sin(a),
      x2: CX + (R + 1) * Math.cos(a), y2: CY + (R + 1) * Math.sin(a),
      stroke: pct >= (k / 12) ? '#22c55e' : '#e5e7eb', strokeWidth: 2, strokeLinecap: 'round'
    }));
  }
  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 80, background: '#ffffff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26 }
  },
    React.createElement('div', { style: { position: 'relative', width: BOX, height: BOX, perspective: 900 } },
      React.createElement('svg', { width: BOX, height: BOX, style: { position: 'absolute', inset: 0, transform: 'rotate(-90deg)' } },
        React.createElement('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: '#eef2f4', strokeWidth: SW }),
        React.createElement('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: '#22c55e', strokeWidth: SW, strokeLinecap: 'round', strokeDasharray: C, strokeDashoffset: C * (1 - Math.min(pct, 1)) })
      ),
      React.createElement('svg', { width: BOX, height: BOX, style: { position: 'absolute', inset: 0 } }, ticks),
      React.createElement('div', {
        style: { position: 'absolute', inset: 26, borderRadius: '50%', transformStyle: 'preserve-3d', WebkitTransformStyle: 'preserve-3d', transition: 'transform 0.85s cubic-bezier(.4,.1,.2,1)', transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }
      },
        React.createElement('div', { style: { position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', border: '3px solid #f3f4f6' } },
          React.createElement('img', { src: photo, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })
        ),
        React.createElement('div', { style: { position: 'absolute', inset: 0, borderRadius: '50%', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', transform: 'rotateY(180deg)', background: '#ffffff', border: '3px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } },
          sprite && React.createElement('img', { src: sprite.full, alt: '', style: { width: '80%', height: '80%', objectFit: 'contain' } })
        )
      )
    ),
    React.createElement('div', { style: { textAlign: 'center', maxWidth: 340, padding: '0 16px' } },
      React.createElement('div', { style: { fontSize: 22, fontWeight: 900, color: phase === 'failed' ? '#dc2626' : (phase === 'done' ? '#16a34a' : '#111') } },
        phase === 'failed' ? 'Couldn’t draw this one' : (phase === 'done' ? 'Digested!' : 'Digesting…')),
      React.createElement('div', { style: { fontSize: 13, color: '#9ca3af', marginTop: 4 } },
        phase === 'failed' ? 'The art didn’t generate — your meal is still saved.' : (foodName || '')),
      phase === 'failed' && errMsg && React.createElement('div', { style: { fontSize: 11, color: '#c1c5cb', marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-word', lineHeight: 1.4 } }, errMsg)
    ),
    phase === 'failed' && React.createElement('div', { style: { display: 'flex', gap: 12 } },
      React.createElement('button', {
        onClick: runGen,
        style: { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 12, padding: '11px 24px', fontSize: 15, fontWeight: 800, cursor: 'pointer' }
      }, 'Try again'),
      React.createElement('button', {
        onClick: () => onDone(null),
        style: { background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 12, padding: '11px 24px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }
      }, 'Save without art')
    )
  );
}

function MealForm({ allMeals, onAdd, onCancel, prefill = null, capturedImage = null, initError = '' }) {
  const { resolve: resolveSprite, add: addSprite } = React.useContext(SpriteCtx);
  const [name, setName] = useState(prefill?.name || '');
  const [protein, setProtein] = useState(prefill?.protein || '');
  const [carbs, setCarbs] = useState(prefill?.carbs || '');
  const [fat, setFat] = useState(prefill?.fat || '');
  const [calories, setCalories] = useState(prefill?.calories || '');
  const [serving, setServing] = useState(prefill?.serving || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initError);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [digest, setDigest] = useState(null);

  // Build a deduplicated history of past meals for search
  const mealHistory = useCallback(() => {
    const seen = new Map();
    Object.values(allMeals).flat().forEach(m => {
      const key = m.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, m);
    });
    return Array.from(seen.values());
  }, [allMeals]);

  function handleNameChange(v) {
    setName(v);
    setError('');
    if (v.trim().length > 0) {
      const hist = mealHistory();
      const hits = hist.filter(m => m.name.toLowerCase().includes(v.toLowerCase())).slice(0, 5);
      setSuggestions(hits);
      setShowSuggestions(hits.length > 0);
    } else {
      setShowSuggestions(false);
    }
  }

  function pickSuggestion(m) {
    setName(m.name);
    setProtein(String(m.protein));
    setCarbs(String(m.carbs));
    setFat(String(m.fat));
    setCalories(String(m.calories || calcCals(m.protein, m.carbs, m.fat)));
    setServing(m.serving || '');
    setShowSuggestions(false);
  }

  function autoCalc(p, c, f) {
    const cals = calcCals(p, c, f);
    setCalories(cals > 0 ? String(cals) : '');
  }

  async function findMacros() {
    if (!name.trim()) { setError('Enter a meal name first.'); return; }
    setLoading(true); setError('');
    try {
      const res = await authedFetch('/api/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Estimate the nutritional information for: "${name.trim()}". Reply with ONLY a JSON object (no markdown) with these keys: protein (g), carbs (g), fat (g), calories, serving (description string). Use typical restaurant/home portion sizes.`
          }]
        })
      });
      if (!res.ok) { const t = await res.text(); throw new Error(t); }
      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Could not parse response.');
      const j = JSON.parse(match[0]);
      setProtein(String(Math.round(j.protein || 0)));
      setCarbs(String(Math.round(j.carbs || 0)));
      setFat(String(Math.round(j.fat || 0)));
      setCalories(String(Math.round(j.calories || calcCals(j.protein, j.carbs, j.fat))));
      setServing(j.serving || '');
    } catch (e) {
      setError('Couldn’t fetch macros. Try again, or enter them manually.');
      console.error(e);
    } finally { setLoading(false); }
  }

  function handleSubmit() {
    if (!name.trim()) { setError('Enter a meal name.'); return; }
    const p = Number(protein) || 0, c = Number(carbs) || 0, f = Number(fat) || 0;
    const cals = Number(calories) || calcCals(p, c, f);
    const nm = name.trim();
    const base = { id: Date.now(), name: nm, protein: p, carbs: c, fat: f, calories: cals, serving };

    // Manual entry (no photo) — nothing to digest, add straight away.
    if (!capturedImage) { onAdd(base); return; }

    // Tag the meal with its image hash + canonical dish so a repeat (same photo, the same dish shot
    // differently, or the same typed name) can reuse the sprite instead of re-generating.
    const h = hashImage(capturedImage.split(',')[1] || capturedImage);
    base.imageHash = h;
    const dishKey = (prefill?.dish || nm).toLowerCase();
    base.dish = dishKey;

    // Reuse a cached sprite: same image (exact) → same dish (vision) → same typed name.
    const prior = mealHistory().find(m => resolveSprite(m) && (
      m.imageHash === h || (m.dish && m.dish === dishKey) || m.name.toLowerCase() === nm.toLowerCase()
    ));
    const cachedSprite = prior ? resolveSprite(prior) : null;
    const spriteId = (prior && prior.spriteId) || h;
    // Hand off to the full-screen digest animation; it generates (or reuses) then adds the meal via onDone.
    setDigest({ base, photo: capturedImage, foodName: nm, cachedSprite, spriteId });
  }

  return React.createElement(React.Fragment, null,
    digest && React.createElement(DigestOverlay, {
      photo: digest.photo,
      foodName: digest.foodName,
      makeSprite: () => digest.cachedSprite ? Promise.resolve({ full: digest.cachedSprite, thumb: digest.cachedSprite }) : generatePixelSprite(digest.photo, digest.foodName),
      onDone: async sprite => {
        if (sprite) { addSprite(digest.spriteId, sprite); onAdd({ ...digest.base, spriteId: digest.spriteId }); return; }
        // No art — keep a small photo on the meal so it can be regenerated later without re-scanning.
        const pendingPhoto = await compactPhoto(digest.photo);
        onAdd(pendingPhoto ? { ...digest.base, pendingPhoto } : digest.base);
      }
    }),
    React.createElement('div', { className: 'fixed inset-0 z-50 flex items-end justify-center' },
      React.createElement('div', { className: 'absolute inset-0 bg-black/40', onClick: onCancel }),
      React.createElement('div', { className: 'relative bg-white rounded-t-3xl w-full max-w-lg p-6 pb-10 shadow-2xl' },
        React.createElement('div', { className: 'flex items-center justify-between mb-5' },
          React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, capturedImage ? 'Confirm meal' : 'Add Meal'),
          React.createElement('button', { onClick: onCancel, className: 'text-gray-400 hover:text-gray-600' },
            React.createElement(Icon, { name: 'X', size: 22 }))
        ),

        capturedImage && React.createElement('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 16 } },
          React.createElement('img', { src: capturedImage, style: { width: 96, height: 96, borderRadius: 16, objectFit: 'cover', border: '2px solid #f3f4f6' } })
        ),

        // Name + AI button
        React.createElement('div', { className: 'relative mb-1' },
          React.createElement('div', { className: 'flex gap-2' },
            React.createElement('div', { className: 'relative flex-1' },
              React.createElement('input', {
                className: 'w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-green-400',
                placeholder: 'Meal name (e.g. Chicken Rice Bowl)',
                value: name,
                onChange: e => handleNameChange(e.target.value),
                onFocus: () => name && setSuggestions(mealHistory().filter(m => m.name.toLowerCase().includes(name.toLowerCase())).slice(0, 5))
              }),
              showSuggestions && React.createElement('div', { className: 'absolute top-full left-0 right-0 bg-white border border-gray-100 rounded-xl shadow-lg z-50 mt-1 overflow-hidden' },
                suggestions.map(s =>
                  React.createElement('button', {
                    key: s.id,
                    className: 'w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 border-b border-gray-50 last:border-0',
                    onMouseDown: e => { e.preventDefault(); pickSuggestion(s); }
                  },
                    React.createElement('div', { className: 'font-medium text-gray-700' }, s.name),
                    React.createElement('div', { className: 'text-xs text-gray-400' }, `P:${s.protein}g C:${s.carbs}g F:${s.fat}g · ${s.calories || calcCals(s.protein, s.carbs, s.fat)} kcal`)
                  )
                )
              )
            ),
            React.createElement('button', {
              onClick: findMacros,
              disabled: loading,
              className: 'flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:bg-green-300 text-white px-3 py-2 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap'
            },
              loading
                ? React.createElement('span', { className: 'animate-spin' }, React.createElement(Icon, { name: 'Loader', size: 14, color: 'white' }))
                : React.createElement(Icon, { name: 'Search', size: 14, color: 'white' }),
              loading ? 'Finding…' : 'Find Macros'
            )
          )
        ),

        error && React.createElement('p', { className: 'text-red-500 text-xs mb-3 mt-1' }, error),

        serving && React.createElement('p', { className: 'text-xs text-gray-400 mb-3 mt-1' }, `Serving: ${serving}`),

        // Macro fields
        React.createElement('div', { className: 'grid grid-cols-2 gap-3 mb-4 mt-3' },
          [
            { label: 'Protein (g)', key: 'protein', val: protein, set: v => { setProtein(v); autoCalc(v, carbs, fat); } },
            { label: 'Carbs (g)', key: 'carbs', val: carbs, set: v => { setCarbs(v); autoCalc(protein, v, fat); } },
            { label: 'Fat (g)', key: 'fat', val: fat, set: v => { setFat(v); autoCalc(protein, carbs, v); } },
            { label: 'Calories', key: 'cals', val: calories, set: setCalories },
          ].map(f =>
            React.createElement('div', { key: f.key },
              React.createElement('label', { className: 'text-xs text-gray-500 mb-1 block' }, f.label),
              React.createElement('input', {
                type: 'number',
                className: 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-400',
                placeholder: '0',
                value: f.val,
                onChange: e => f.set(e.target.value)
              })
            )
          )
        ),

        // Buttons
        React.createElement('div', { className: 'flex gap-3' },
          React.createElement('button', {
            onClick: onCancel,
            className: 'flex-1 border border-gray-200 rounded-xl py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors'
          }, 'Cancel'),
          React.createElement('button', {
            onClick: handleSubmit,
            className: 'flex-1 bg-green-500 hover:bg-green-600 text-white rounded-xl py-3 text-sm font-semibold transition-colors'
          }, 'Add Meal')
        )
      )
    )
  );
}

// ─── Camera Capture ───────────────────────────────────────────────────────────
function CameraCapture({ allMeals, onAdd, onCancel }) {
  const [tab, setTab]             = useState('meal');
  const [mode, setMode]           = useState('camera');
  const [flash, setFlash]         = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const [prefill, setPrefill]     = useState(null);
  const [initError, setInitError] = useState('');
  const videoRef  = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    if (mode !== 'camera') return;
    if (!navigator.mediaDevices?.getUserMedia) { setMode('type'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
      })
      .catch(() => setMode('type'));
    return () => stopStream();
  }, [mode]);

  function stopStream() {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  }

  async function analyzeBase64(base64, mimeType) {
    setMode('analyzing');
    // Seen this exact photo before? Reuse its saved macros — no re-analysis, identical every time.
    const cached = Object.values(allMeals).flat().find(m => m.imageHash && m.imageHash === hashImage(base64));
    if (cached) {
      setPrefill({ name: cached.name, dish: cached.dish || (cached.name || '').toLowerCase(), protein: String(cached.protein), carbs: String(cached.carbs), fat: String(cached.fat), calories: String(cached.calories || calcCals(cached.protein, cached.carbs, cached.fat)), serving: cached.serving || '' });
      setMode('confirm');
      return;
    }
    try {
      const prompt = tab === 'label'
        ? 'This is a nutrition facts label. Use OCR to read all text on the label precisely. Find and extract these exact values per serving: Calories, Total Fat (g), Total Carbohydrate (g), Protein (g), and the serving size description. Reply ONLY with compact JSON, no other text: {"name":"product name","dish":"canonical lowercase product name","protein":0,"carbs":0,"fat":0,"calories":0,"serving":"serving size from label"}'
        : 'Identify this food and estimate macros for the portion shown. Include local/Asian dishes accurately (laksa, nasi lemak, char kway teow, bak chor mee, roti prata, etc). Reply ONLY with compact JSON: {"name":"food name","dish":"canonical lowercase dish name, no portion or qualifier words","protein":0,"carbs":0,"fat":0,"calories":0,"serving":"portion description"}';
      const res = await authedFetch('/api/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 256,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: prompt }
          ]}]
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const match = (data.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in response');
      const j = JSON.parse(match[0]);
      setPrefill({ name: j.name || '', dish: (j.dish || j.name || '').toLowerCase(), protein: String(Math.round(j.protein || 0)), carbs: String(Math.round(j.carbs || 0)), fat: String(Math.round(j.fat || 0)), calories: String(Math.round(j.calories || calcCals(j.protein, j.carbs, j.fat))), serving: j.serving || '' });
      setMode('confirm');
    } catch(e) {
      console.error(e);
      setInitError('Could not analyse image. You can edit the details below.');
      setMode('type');
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setCapturedImage(dataUrl);
    stopStream();
    analyzeBase64(dataUrl.split(',')[1], 'image/jpeg');
  }

  function pickGallery() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = e => {
      const file = e.target.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = ev.target.result;
        setCapturedImage(dataUrl);
        stopStream();
        analyzeBase64(dataUrl.split(',')[1], file.type || 'image/jpeg');
      };
      reader.readAsDataURL(file);
    };
    inp.click();
  }

  if (mode === 'confirm' || mode === 'type') {
    return React.createElement(MealForm, { allMeals, onAdd, onCancel, prefill: mode === 'confirm' ? prefill : null, capturedImage: mode === 'confirm' ? capturedImage : null, initError });
  }

  const isAnalyzing = mode === 'analyzing';

  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 50, background: '#0d0d0d', display: 'flex', flexDirection: 'column' }
  },
    // Top bar
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '52px 20px 16px' } },
      React.createElement('button', { onClick: onCancel, style: { width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.18)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        React.createElement(Icon, { name: 'X', size: 20, color: 'white' })
      ),
      React.createElement('div', { style: { display: 'flex', background: 'rgba(255,255,255,0.14)', borderRadius: 24, padding: 3, gap: 2 } },
        ['Meal', 'Label'].map(t =>
          React.createElement('button', { key: t, onClick: () => setTab(t.toLowerCase()), style: { background: tab === t.toLowerCase() ? 'white' : 'transparent', border: 'none', borderRadius: 21, padding: '6px 20px', color: tab === t.toLowerCase() ? '#111' : 'rgba(255,255,255,0.75)', fontWeight: 700, fontSize: 14, cursor: 'pointer' } }, t)
        )
      ),
      React.createElement('button', { onClick: () => setFlash(f => !f), style: { width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.18)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: flash ? 1 : 0.45 } },
        React.createElement(Icon, { name: 'Zap', size: 20, color: 'white' })
      )
    ),

    // Circular camera viewport
    React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      React.createElement('div', { style: tab === 'label'
        ? { width: '88vw', height: '56vh', maxWidth: 480, borderRadius: 16, overflow: 'hidden', border: '3px solid rgba(255,255,255,0.22)', position: 'relative', background: '#1a1a1a' }
        : { width: '92vw', height: '92vw', maxWidth: 420, maxHeight: 420, borderRadius: '50%', overflow: 'hidden', border: '3px solid rgba(255,255,255,0.22)', position: 'relative', background: '#1a1a1a' }
      },
        isAnalyzing
          ? React.createElement('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 } },
              capturedImage && React.createElement('img', { src: capturedImage, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3 } }),
              React.createElement('div', { style: { width: 44, height: 44, borderRadius: '50%', border: '3px solid white', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', position: 'relative', zIndex: 1 } }),
              React.createElement('span', { style: { color: 'white', fontSize: 13, fontWeight: 600, position: 'relative', zIndex: 1 } }, 'Analysing…')
            )
          : React.createElement('video', { ref: videoRef, autoPlay: true, playsInline: true, muted: true, style: { width: '100%', height: '100%', objectFit: 'cover' } })
      )
    ),

    // Type manually pill
    React.createElement('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 20 } },
      React.createElement('button', { onClick: () => { stopStream(); setMode('type'); }, style: { background: 'rgba(255,255,255,0.13)', border: 'none', borderRadius: 30, padding: '10px 24px', color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement(Icon, { name: 'ChevronUp', size: 15, color: 'white' }),
        'Type manually'
      )
    ),

    // Bottom bar: Gallery | Capture | Type
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 48px 52px' } },
      React.createElement('button', { onClick: pickGallery, style: { background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 } },
        React.createElement(Icon, { name: 'Image', size: 26, color: 'white' }),
        React.createElement('span', { style: { fontSize: 11, color: 'rgba(255,255,255,0.6)' } }, 'Gallery')
      ),
      React.createElement('button', { onClick: capture, disabled: isAnalyzing, style: { width: 72, height: 72, borderRadius: '50%', background: 'white', border: '4px solid rgba(255,255,255,0.3)', cursor: isAnalyzing ? 'default' : 'pointer', boxShadow: '0 0 0 8px rgba(255,255,255,0.08)', outline: 'none', padding: 0 } }),
      React.createElement('button', { onClick: () => { stopStream(); setMode('type'); }, style: { background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 } },
        React.createElement(Icon, { name: 'Keyboard', size: 26, color: 'white' }),
        React.createElement('span', { style: { fontSize: 11, color: 'rgba(255,255,255,0.6)' } }, 'Type')
      )
    )
  );
}

// ─── Goals Editor ─────────────────────────────────────────────────────────────
function GoalsEditor({ goals, onChange }) {
  const fields = [
    { key: 'calories', label: 'Calories', unit: 'kcal' },
    { key: 'protein',  label: 'Protein',  unit: 'g' },
    { key: 'carbs',    label: 'Carbs',    unit: 'g' },
    { key: 'fat',      label: 'Fat',      unit: 'g' },
  ];
  return (
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, marginTop: 4 } },
      fields.map(f =>
        React.createElement('div', { key: f.key, style: { minWidth: 0 } },
          React.createElement('label', { style: { fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 5 } }, f.label),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', border: '1.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: 'white' } },
            React.createElement('input', {
              type: 'number',
              style: { flex: 1, minWidth: 0, padding: '9px 8px', fontSize: 14, textAlign: 'center', border: 'none', outline: 'none', background: 'transparent' },
              value: goals[f.key] || '',
              placeholder: '0',
              onChange: e => onChange({ ...goals, [f.key]: Number(e.target.value) || 0 })
            }),
            React.createElement('span', { style: { fontSize: 11, color: '#9ca3af', paddingRight: 8, whiteSpace: 'nowrap' } }, f.unit)
          )
        )
      )
    )
  );
}

// ─── Google icon SVG ──────────────────────────────────────────────────────────
function GoogleIcon({ size = 18 }) {
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { flexShrink: 0 } },
    React.createElement('path', { d: 'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z', fill: '#4285F4' }),
    React.createElement('path', { d: 'M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z', fill: '#34A853' }),
    React.createElement('path', { d: 'M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z', fill: '#FBBC05' }),
    React.createElement('path', { d: 'M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z', fill: '#EA4335' })
  );
}

// ─── Settings Sheet ───────────────────────────────────────────────────────────
function SettingsSheet({ user, goals, onGoalsChange, profile, onEditProfile, onSignIn, onSignOut, onClose }) {
  const avatar = user?.photoURL
    ? React.createElement('img', { src: user.photoURL, alt: '', style: { width: 44, height: 44, borderRadius: '50%', border: '2px solid white', boxShadow: '0 1px 4px rgba(0,0,0,.12)', flexShrink: 0 } })
    : React.createElement('div', { style: { width: 44, height: 44, borderRadius: '50%', background: '#d1fae5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#16a34a', flexShrink: 0 } },
        (user?.displayName || user?.email || 'U')[0].toUpperCase()
      );

  return React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'flex-end' } },
    React.createElement('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }, onClick: onClose }),
    React.createElement('div', { style: { position: 'relative', background: 'white', borderTopLeftRadius: 28, borderTopRightRadius: 28, width: '100%', padding: '20px 20px 48px' } },
      React.createElement('div', { style: { width: 36, height: 4, background: '#e5e7eb', borderRadius: 2, margin: '0 auto 18px' } }),

      // Header
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 } },
        React.createElement('h2', { style: { fontSize: 18, fontWeight: 800, color: '#111', margin: 0 } }, 'Settings'),
        React.createElement('button', { onClick: onClose, style: { background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          React.createElement(Icon, { name: 'X', size: 16 })
        )
      ),

      // Account section
      React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 } }, 'Account'),
      user
        ? React.createElement('div', { style: { background: '#f9fafb', borderRadius: 16, padding: 14, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 } },
            avatar,
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
              React.createElement('div', { style: { fontWeight: 700, fontSize: 14, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, user.displayName || 'User'),
              React.createElement('div', { style: { fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, user.email),
              React.createElement('div', { style: { fontSize: 11, color: '#22c55e', marginTop: 3, fontWeight: 600 } }, '✓ Syncing to cloud')
            ),
            React.createElement('button', {
              onClick: onSignOut,
              style: { background: '#fee2e2', border: 'none', borderRadius: 10, padding: '7px 14px', fontSize: 12, fontWeight: 600, color: '#ef4444', cursor: 'pointer', flexShrink: 0 }
            }, 'Sign out')
          )
        : isFirebaseConfigured()
          ? React.createElement('button', {
              onClick: onSignIn,
              style: { width: '100%', background: 'white', border: '1.5px solid #e5e7eb', borderRadius: 14, padding: '13px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', marginBottom: 20, fontSize: 14, fontWeight: 600, color: '#374151', boxShadow: '0 1px 3px rgba(0,0,0,.08)' }
            },
              React.createElement(GoogleIcon),
              'Continue with Google'
            )
          : React.createElement('div', { style: { background: '#f9fafb', borderRadius: 14, padding: '12px 14px', marginBottom: 20 } },
              React.createElement('p', { style: { fontSize: 12, color: '#9ca3af', margin: 0, lineHeight: 1.5 } }, 'Cloud sync not configured. Fill in firebase-config.js to enable Google sign-in.')
            ),

      // Body Metrics section — opens the onboarding sheet in edit mode to re-derive goals
      React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 } }, 'Body Metrics'),
      React.createElement('button', {
        onClick: onEditProfile,
        style: { width: '100%', background: '#f9fafb', border: '1.5px solid #e5e7eb', borderRadius: 16, padding: 14, marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', textAlign: 'left' }
      },
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: '#111' } }, profile ? 'Edit body metrics' : 'Set up your metrics'),
          React.createElement('div', { style: { fontSize: 12, color: '#9ca3af', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            profile
              ? `${Math.round(profile.weightKg)} kg · ${Math.round(profile.heightCm)} cm · ${profile.goalDir === 'lose' ? 'Losing' : profile.goalDir === 'gain' ? 'Gaining' : 'Maintaining'} — recalculates goals`
              : 'Calculate your targets from height, weight & activity'
          )
        ),
        React.createElement(Icon, { name: 'ChevronRight', size: 18, color: '#9ca3af' })
      ),

      // Daily Goals section
      React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 } }, 'Daily Goals'),
      React.createElement('div', { style: { background: '#f9fafb', borderRadius: 16, padding: 16 } },
        React.createElement('p', { style: { fontSize: 11, color: '#9ca3af', margin: '0 0 12px', lineHeight: 1.4 } }, 'Manual override — only changes your targets, existing meal history is never affected.'),
        React.createElement(GoalsEditor, { goals, onChange: onGoalsChange })
      )
    )
  );
}

// ─── MacroWorld theme (pixel-game home) ───────────────────────────────────────
const PIXEL = "'Pixelify Sans', 'Silkscreen', ui-monospace, monospace";
const THEME = {
  cream:   '#F4EEE1',   // card fill
  creamHi: '#FBF7EE',   // lighter card fill
  ink:     '#2E2A24',   // dark text
  sub:     '#8C8375',   // muted text
  line:    'rgba(46,42,36,0.10)',
  track:   '#E4DBC9',   // progress track
  green:   '#4B6B3E',   // primary accent
  greenDk: '#2E3B26',   // nav bar
  gold:    '#E7B23E',   // xp / active
  protein: '#3E7CB1',
  carbs:   '#CF4B3E',
  fat:     '#E7A83A',
  proteinTint: '#DCE9F3',
  carbsTint:   '#F6DCD8',
  fatTint:     '#F6E7C9',
};
const pixelCard = (extra = {}) => ({
  background: THEME.cream, borderRadius: 18, border: '1px solid ' + THEME.line,
  boxShadow: '0 2px 0 rgba(46,42,36,0.06), 0 6px 16px rgba(46,42,36,0.06)', ...extra,
});
const pixelLabel = (extra = {}) => ({
  fontFamily: PIXEL, fontWeight: 700, letterSpacing: '0.04em', color: THEME.ink, ...extra,
});

// A cropped head-and-shoulders portrait of the idle character, for the LV badge.
function CharacterFace({ size = 42, set = DEFAULT_SET }) {
  const ref = useRef(null);
  useEffect(() => {
    loadSprite(set.path, img => {
      const cv = ref.current; if (!cv) return;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      const [sx, sy, sw, fh] = set.bboxes[0];
      const sh = Math.round(fh * 0.52);                 // head + shoulders slice of the idle frame
      const scale = Math.max(size / sw, size / sh);
      const dw = sw * scale, dh = sh * scale;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, 2, dw, dh);
    });
  }, [size, set.path]);
  return React.createElement('canvas', { ref, width: size, height: size, style: { display: 'block' } });
}

// Cumulative calories-over-day line chart (stepped), 6AM → midnight.
function CalorieChart({ dayMeals, goalCals }) {
  const W = 200, H = 92, padL = 24, padR = 6, padT = 8, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const startH = 6, endH = 24;

  const timed = dayMeals.map((m, i) => {
    let h;
    if (m.loggedAt) { const d = new Date(m.loggedAt); h = d.getHours() + d.getMinutes() / 60; }
    else h = startH + 2 + (i + 1) * (endH - startH - 4) / (dayMeals.length + 1);  // spread untimed meals
    return { h: Math.min(endH, Math.max(startH, h)), cals: Number(m.calories) || 0 };
  }).sort((a, b) => a.h - b.h);

  let cum = 0;
  const pts = timed.map(t => { cum += t.cals; return { h: t.h, y: cum }; });
  const yMax = Math.max(goalCals || 2000, cum, 2000);
  const xOf = h => padL + ((h - startH) / (endH - startH)) * plotW;
  const yOf = v => padT + plotH - (Math.min(v, yMax) / yMax) * plotH;

  let d = `M ${xOf(startH)} ${yOf(0)}`;
  pts.forEach(p => { d += ` H ${xOf(p.h).toFixed(1)} V ${yOf(p.y).toFixed(1)}`; });

  const gridVals = [0, yMax / 2, yMax];
  const gridLabel = v => v >= 1000 ? (v / 1000) + 'k' : String(Math.round(v));
  const xTicks = [ [6,'6AM'], [12,'12PM'], [18,'6PM'], [24,'12AM'] ];
  const last = pts[pts.length - 1];

  return React.createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: { display: 'block', maxWidth: 240 } },
    ...gridVals.map((v, i) => React.createElement('line', {
      key: 'g' + i, x1: padL, y1: yOf(v), x2: W - padR, y2: yOf(v),
      stroke: THEME.line, strokeWidth: 1, strokeDasharray: i === 0 ? '0' : '3 3'
    })),
    ...gridVals.map((v, i) => React.createElement('text', {
      key: 't' + i, x: padL - 4, y: yOf(v) + 3, textAnchor: 'end',
      style: { fontFamily: PIXEL, fontSize: 8, fill: THEME.sub }
    }, gridLabel(v))),
    ...xTicks.map(([h, lab], i) => React.createElement('text', {
      key: 'x' + i, x: xOf(h), y: H - 3, textAnchor: h === 24 ? 'end' : h === 6 ? 'start' : 'middle',
      style: { fontFamily: PIXEL, fontSize: 8, fill: THEME.sub }
    }, lab)),
    React.createElement('path', { d, fill: 'none', stroke: THEME.green, strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round' }),
    last && React.createElement('circle', { cx: xOf(last.h), cy: yOf(last.y), r: 3.5, fill: THEME.creamHi, stroke: THEME.green, strokeWidth: 2 })
  );
}

// One macro row: colored icon tile · label · grams · progress bar · % pill.
function MacroRow({ icon, label, value, goal, color, tint }) {
  const pct  = goal > 0 ? Math.round((value / goal) * 100) : 0;
  const fill = Math.max(0, Math.min(100, pct));
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 11, padding: '7px 0' } },
    React.createElement('div', { style: { width: 38, height: 38, borderRadius: 10, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.12)' } },
      React.createElement(Icon, { name: icon, size: 19, color: 'white' })),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 } },
        React.createElement('span', { style: pixelLabel({ fontSize: 12 }) }, label.toUpperCase()),
        React.createElement('span', { style: { fontSize: 12, color: THEME.sub, fontWeight: 600 } }, `${Math.round(value)}g / ${goal}g`)),
      React.createElement('div', { style: { height: 8, borderRadius: 6, background: THEME.track, overflow: 'hidden' } },
        React.createElement('div', { style: { width: fill + '%', height: '100%', background: color, borderRadius: 6, transition: 'width .4s' } }))),
    React.createElement('div', { style: { background: tint, borderRadius: 9, padding: '6px 4px', minWidth: 48, textAlign: 'center', flexShrink: 0 } },
      React.createElement('span', { style: pixelLabel({ fontSize: 13, color }) }, pct + '%'))
  );
}

// Small pixel-sprite (or emoji fallback) thumbnail for a meal.
function MealThumb({ meal, size = 44, radius = 12 }) {
  const { resolve } = React.useContext(SpriteCtx);
  const src = resolve(meal);
  return React.createElement('div', {
    style: { width: size, height: size, borderRadius: radius, background: THEME.creamHi, border: '1px solid ' + THEME.line, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }
  }, src
    ? React.createElement('img', { src, alt: '', style: { width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' } })
    : React.createElement('span', { style: { fontSize: size * 0.5 } }, '🍽️'));
}

// A tappable meal line for the "Today's Meals" card.
function MealListRow({ meal, onOpen, divider }) {
  const cals = meal.calories || calcCals(meal.protein, meal.carbs, meal.fat);
  return React.createElement('button', {
    onClick: () => onOpen && onOpen(meal),
    style: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 0', textAlign: 'left', borderTop: divider ? '1px solid ' + THEME.line : 'none' }
  },
    React.createElement(MealThumb, { meal }),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { fontWeight: 700, fontSize: 15, color: THEME.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meal.name || 'Meal'),
      meal.serving && React.createElement('div', { style: { fontSize: 12, color: THEME.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meal.serving)),
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
      React.createElement('span', { style: { fontWeight: 700, fontSize: 14, color: THEME.ink } }, `${cals} kcal`),
      React.createElement(Icon, { name: 'ChevronRight', size: 16, color: THEME.sub }))
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ meals, goals, game, justFed, spriteSet = DEFAULT_SET, onOpenMeal, onOpenSettings, onGoProgress, onGoMeals }) {
  const dayMeals = meals[toDateKey(today())] || [];

  const totals = dayMeals.reduce((acc, m) => ({
    protein: acc.protein + (Number(m.protein) || 0),
    carbs:   acc.carbs   + (Number(m.carbs)   || 0),
    fat:     acc.fat     + (Number(m.fat)     || 0),
    calories:acc.calories+ (Number(m.calories)|| 0),
  }), { protein: 0, carbs: 0, fat: 0, calories: 0 });

  const goalCals = goals.calories || (goals.protein * 4 + goals.carbs * 4 + goals.fat * 9);
  const calPct   = goalCals > 0 ? Math.min(1, totals.calories / goalCals) : 0;
  const calsLeft = Math.round(goalCals - totals.calories);
  const calsOver = calsLeft < 0;

  const petState = petMood(meals, justFed);
  const { level, xp } = game || { level: 1, xp: 0 };
  const xpNeed = xpToNext(level);
  const coins  = (game && game.coins) || 0;

  // Every meal logged today, newest first — the latest thing you logged is at the top. Card grows to fit all.
  const shownMeals = dayMeals.slice().sort((a, b) => (b.loggedAt || 0) - (a.loggedAt || 0));

  const sectionHead = (title, action, onAction) => React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }
  },
    React.createElement('span', { style: pixelLabel({ fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }) }, title),
    action && React.createElement('button', {
      onClick: onAction,
      style: { background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, ...pixelLabel({ fontSize: 11, color: THEME.green }) }
    }, action, React.createElement(Icon, { name: 'ChevronRight', size: 13, color: THEME.green }))
  );

  return React.createElement('div', {
    style: {
      position: 'relative', height: '100%', overflow: 'hidden',
      backgroundColor: '#6E8E4E',
    }
  },

    // ── Full-screen scenery (expanded art reaches the bottom edge — no fill gap) ──
    React.createElement('div', { style: { position: 'absolute', inset: 0, backgroundImage: "url('/assets/scene-bg.jpg')", backgroundSize: 'cover', backgroundPosition: 'center top', zIndex: 0 } }),

    // ── Backdrop chrome: LV/XP · coins · character (fixed, don't scroll) ──
    // LV / XP card
    React.createElement('div', { style: pixelCard({ position: 'absolute', top: 14, left: 12, zIndex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px 7px 8px' }) },
      React.createElement('div', { style: { width: 42, height: 42, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + THEME.line, background: THEME.creamHi, flexShrink: 0 } },
        React.createElement(CharacterFace, { size: 42, set: spriteSet })),
      React.createElement('div', null,
        React.createElement('div', { style: pixelLabel({ fontSize: 15, lineHeight: 1 }) }, 'LV. ' + level),
        React.createElement('div', { style: { width: 108, height: 9, borderRadius: 5, background: '#3B372F', overflow: 'hidden', margin: '5px 0 3px' } },
          React.createElement('div', { style: { width: Math.round((xp / xpNeed) * 100) + '%', height: '100%', background: THEME.gold, borderRadius: 5 } })),
        React.createElement('div', { style: pixelLabel({ fontSize: 9, color: THEME.sub }) }, `${xp} / ${xpNeed.toLocaleString()} XP`))
    ),
    // Coins card
    React.createElement('div', { style: pixelCard({ position: 'absolute', top: 14, right: 12, zIndex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px' }) },
      React.createElement('div', { style: { width: 30, height: 30, borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%, #F6D169, ' + THEME.gold + ' 70%)', border: '2px solid #C8912B', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
        React.createElement('div', { style: { width: 16, height: 16, borderRadius: '50%', border: '2px solid rgba(200,145,43,0.6)' } })),
      React.createElement('div', { style: { textAlign: 'right' } },
        React.createElement('div', { style: pixelLabel({ fontSize: 17, lineHeight: 1 }) }, coins.toLocaleString()),
        React.createElement('div', { style: pixelLabel({ fontSize: 9, color: THEME.sub, marginTop: 2 }) }, 'COINS'))
    ),
    // Character standing on the path
    React.createElement('div', { style: { position: 'absolute', top: '24%', left: '50%', transform: 'translateX(-50%)', zIndex: 1, pointerEvents: 'none' } },
      React.createElement(PetCat, { state: petState, size: 150, set: spriteSet })),

    // ── Scrollable cards floating over the scenery ──
    React.createElement('div', { style: { position: 'absolute', inset: 0, overflowY: 'auto', zIndex: 2, paddingTop: '43vh', paddingBottom: 112 } },

    // ── Calories card ──
    React.createElement('div', { style: pixelCard({ margin: '14px 14px 12px', padding: 16, display: 'flex', gap: 12 }) },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: pixelLabel({ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }) }, '🔥', 'CALORIES'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 10 } },
          React.createElement('span', { style: { fontSize: 34, fontWeight: 800, color: THEME.ink, letterSpacing: '-0.02em' } }, totals.calories.toLocaleString()),
          React.createElement('span', { style: { fontSize: 13, color: THEME.sub, fontWeight: 600 } }, '/ ' + Math.round(goalCals).toLocaleString() + ' kcal')),
        React.createElement('div', { style: { height: 12, borderRadius: 7, background: '#DCE6CE', overflow: 'hidden', marginBottom: 8 } },
          React.createElement('div', { style: { width: (calPct * 100) + '%', height: '100%', background: calsOver ? THEME.carbs : THEME.green, borderRadius: 7, transition: 'width .4s' } })),
        React.createElement('div', { style: { fontSize: 13, color: THEME.sub, fontWeight: 600 } }, calsOver ? Math.abs(calsLeft).toLocaleString() + ' kcal over' : calsLeft.toLocaleString() + ' kcal left')),
      React.createElement('div', { style: { width: '46%', display: 'flex', alignItems: 'center' } },
        React.createElement(CalorieChart, { dayMeals, goalCals }))
    ),

    // ── Macros breakdown card ──
    React.createElement('div', { style: pixelCard({ margin: '0 14px 12px', padding: '14px 16px' }) },
      sectionHead(React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, React.createElement(Icon, { name: 'Utensils', size: 15, color: THEME.ink }), 'MACROS BREAKDOWN'), 'VIEW DETAILS', onGoProgress),
      React.createElement(MacroRow, { icon: 'Dumbbell', label: 'Protein', value: totals.protein, goal: goals.protein, color: THEME.protein, tint: THEME.proteinTint }),
      React.createElement(MacroRow, { icon: 'Wheat',    label: 'Carbs',   value: totals.carbs,   goal: goals.carbs,   color: THEME.carbs,   tint: THEME.carbsTint }),
      React.createElement(MacroRow, { icon: 'Droplet',  label: 'Fats',    value: totals.fat,     goal: goals.fat,     color: THEME.fat,     tint: THEME.fatTint })
    ),

    // ── Today's meals card ──
    React.createElement('div', { style: pixelCard({ margin: '0 14px 12px', padding: '14px 16px' }) },
      sectionHead(React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 7 } }, React.createElement(Icon, { name: 'UtensilsCrossed', size: 15, color: THEME.ink }), "TODAY'S MEALS"), dayMeals.length > 0 ? 'VIEW ALL' : null, onGoMeals),
      shownMeals.length > 0
        ? shownMeals.map((m, i) => React.createElement(MealListRow, { key: m.id || i, meal: m, onOpen: onOpenMeal, divider: i > 0 }))
        : React.createElement('div', { style: { textAlign: 'center', padding: '18px 0 10px' } },
            React.createElement('div', { style: { fontSize: 30, marginBottom: 6 } }, '🍽️'),
            React.createElement('div', { style: { color: THEME.sub, fontSize: 13 } }, 'No meals logged yet — tap Add below.'))
    )
    )
  );
}

// ─── Meal Detail — full-screen sprite + macros (reuses the digest reveal look) ─
function MealDetail({ meal, onClose, onUpdateMeal }) {
  const { resolve, add: addSprite } = React.useContext(SpriteCtx);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenErr, setRegenErr]   = useState('');
  if (!meal) return null;
  const src  = resolve(meal);
  const cals = meal.calories || calcCals(meal.protein, meal.carbs, meal.fat);
  const canRegen = !src && !!meal.pendingPhoto;

  async function regenerate() {
    if (!meal.pendingPhoto || regenBusy) return;
    setRegenBusy(true); setRegenErr('');
    try {
      const sprite = await generatePixelSprite(meal.pendingPhoto, meal.name);
      const spriteId = meal.spriteId || meal.imageHash || String(meal.id);
      addSprite(spriteId, sprite);
      onUpdateMeal && onUpdateMeal(meal.id, { spriteId, pendingPhoto: undefined });
    } catch (e) {
      setRegenErr(e?.message || 'Still couldn’t generate — try again.');
    } finally {
      setRegenBusy(false);
    }
  }

  const macroCol = (label, val, color, tint) => React.createElement('div', { style: { flex: 1, textAlign: 'center' } },
    React.createElement('div', { style: { width: 34, height: 34, borderRadius: 10, background: tint, margin: '0 auto 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      React.createElement('div', { style: { width: 12, height: 12, borderRadius: '50%', background: color } })),
    React.createElement('div', { style: { fontSize: 20, fontWeight: 800, color: THEME.ink } }, Math.round(val) + 'g'),
    React.createElement('div', { style: pixelLabel({ fontSize: 10, color: THEME.sub, marginTop: 2 }) }, label.toUpperCase())
  );

  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 80, background: THEME.creamHi, display: 'flex', flexDirection: 'column', alignItems: 'center' }
  },
    React.createElement('button', {
      onClick: onClose,
      style: { position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: '50%', ...pixelCard({ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer' }) }
    }, React.createElement(Icon, { name: 'X', size: 20, color: THEME.ink })),

    React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '0 24px' } },
      React.createElement('div', { style: pixelCard({ width: 240, height: 240, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }) },
        src ? React.createElement('img', { src, alt: '', style: { width: '82%', height: '82%', objectFit: 'contain' } })
            : React.createElement('span', { style: { fontSize: 96 } }, '🍽️')),
      React.createElement('div', { style: { textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: 24, fontWeight: 800, color: THEME.ink, marginBottom: 4, maxWidth: 320 } }, meal.name || 'Meal'),
        meal.serving && React.createElement('div', { style: { fontSize: 14, color: THEME.sub } }, meal.serving)),
      canRegen && React.createElement('div', { style: { textAlign: 'center' } },
        React.createElement('button', {
          onClick: regenerate, disabled: regenBusy,
          style: { display: 'inline-flex', alignItems: 'center', gap: 8, background: regenBusy ? '#e5e7eb' : THEME.green, color: regenBusy ? '#6b7280' : '#fff', border: 'none', borderRadius: 12, padding: '10px 20px', fontSize: 14, fontWeight: 800, cursor: regenBusy ? 'default' : 'pointer' }
        }, React.createElement(Icon, { name: 'Sparkles', size: 16, color: regenBusy ? '#6b7280' : '#fff' }), regenBusy ? 'Generating…' : 'Generate pixel art'),
        regenErr && React.createElement('div', { style: { fontSize: 12, color: '#dc2626', marginTop: 6 } }, regenErr)),
      React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
        React.createElement('span', { style: { fontSize: 46, fontWeight: 900, color: THEME.green, letterSpacing: '-0.02em' } }, cals.toLocaleString()),
        React.createElement('span', { style: pixelLabel({ fontSize: 14, color: THEME.sub }) }, 'KCAL'))
    ),

    React.createElement('div', { style: pixelCard({ margin: '0 16px 28px', padding: '18px 16px', width: 'calc(100% - 32px)', maxWidth: 420, display: 'flex' }) },
      macroCol('Protein', meal.protein || 0, THEME.protein, THEME.proteinTint),
      macroCol('Carbs',   meal.carbs   || 0, THEME.carbs,   THEME.carbsTint),
      macroCol('Fats',    meal.fat     || 0, THEME.fat,     THEME.fatTint))
  );
}

// ─── Meals Page — collection album (dining-scene backdrop + card grid) ────────
const MEALS_PANEL = '#F3ECDD';                 // cream panel over the scene
const MEALS_CARD  = '#FBF7EC';                 // meal card fill
const MEALS_GREEN = '#3C5A38';                 // header + meal-name dark green
const MEALS_LINE  = 'rgba(70,60,40,0.14)';

function MealCollectCard({ meal, onOpen, onLog }) {
  const { resolve } = React.useContext(SpriteCtx);
  const src = resolve(meal);
  return React.createElement('div', {
    style: { position: 'relative', background: MEALS_CARD, borderRadius: 16, border: '1px solid ' + MEALS_LINE, boxShadow: '0 2px 0 rgba(60,50,30,0.05), 0 6px 14px rgba(60,50,30,0.08)', padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }
  },
    React.createElement('div', { style: { position: 'absolute', top: 0, right: 12, width: 24, height: 30, background: '#4C7B3B', clipPath: 'polygon(0 0,100% 0,100% 100%,50% 78%,0 100%)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 4, zIndex: 1 } },
      React.createElement(Icon, { name: 'Check', size: 12, color: 'white', strokeWidth: 3 })),
    // Tap the image/name to inspect the meal detail.
    React.createElement('button', {
      onClick: () => onOpen && onOpen(meal),
      style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }
    },
      React.createElement('div', { style: { width: '100%', aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } },
        src ? React.createElement('img', { src, alt: '', style: { width: '100%', height: '100%', objectFit: 'contain' } })
            : React.createElement('span', { style: { fontSize: '2.6rem' } }, '🍽️')),
      React.createElement('div', { style: { fontWeight: 800, fontSize: 12.5, color: MEALS_GREEN, textAlign: 'center', lineHeight: 1.12, minHeight: 28, display: 'flex', alignItems: 'center' } }, meal.name || 'Meal')
    ),
    // Re-log this past meal — opens the logging screen pre-filled with its macros.
    React.createElement('button', {
      onClick: () => onLog && onLog(meal),
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', background: 'transparent', color: 'rgba(45,40,32,0.62)', border: '1.5px solid rgba(45,40,32,0.22)', borderRadius: 10, padding: '8px 10px', cursor: 'pointer', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }
    }, 'Log Meal')
  );
}

function EmptyMealCard() {
  return React.createElement('div', {
    style: { borderRadius: 16, border: '2px dashed rgba(92,80,58,0.32)', background: 'rgba(255,255,255,0.20)', minHeight: 182, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }
  },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(92,80,58,0.4)' } },
      React.createElement('span', { style: { fontSize: 11 } }, '✦'),
      React.createElement('span', { style: { fontFamily: PIXEL, fontWeight: 700, fontSize: 32, lineHeight: 1 } }, '?'),
      React.createElement('span', { style: { fontSize: 11 } }, '✦')),
    React.createElement('div', { style: { fontSize: 11, color: 'rgba(92,80,58,0.5)', textAlign: 'center', padding: '0 6px' } }, 'Meal not found yet')
  );
}

function MealsPage({ meals, onOpenMeal, onLogMeal }) {
  // Dedupe into a collection: one card per unique dish (by sprite, else name), newest first.
  const seen = new Set(); const collected = [];
  Object.keys(meals).sort().reverse().forEach(dk => (meals[dk] || []).forEach(m => {
    const key = m.spriteId || (m.name || '').toLowerCase().trim();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    collected.push(m);
  }));
  const total = Math.max(9, Math.ceil((collected.length + 1) / 3) * 3);
  const slots = [...collected, ...Array(total - collected.length).fill(null)];

  const dashLine = () => React.createElement('div', { style: { flex: 1, height: 0, borderTop: '2px dashed ' + MEALS_LINE } });

  return React.createElement('div', { style: { position: 'relative', height: '100%', overflow: 'hidden', background: '#6E4A2B' } },
    // Dining-scene backdrop (fixed; the cream panel scrolls over it).
    React.createElement('div', { style: { position: 'absolute', inset: 0, backgroundImage: "url('/assets/meals-bg.jpg')", backgroundSize: 'cover', backgroundPosition: 'center top', zIndex: 0 } }),
    React.createElement('div', { style: { position: 'absolute', inset: 0, overflowY: 'auto', zIndex: 1 } },
      React.createElement('div', { style: { height: '43vh' } }),   // reveal the scene (incl. the table of food) above the panel
      // Panel fills from the reveal to well past the bottom, so scrolling only ever shows cream — never the scene behind.
      React.createElement('div', { style: { minHeight: 'calc(100vh - 43vh)', background: MEALS_PANEL, borderTopLeftRadius: 28, borderTopRightRadius: 28, boxShadow: '0 -6px 20px rgba(0,0,0,0.22)', padding: '22px 16px 130px' } },
        // Header
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 8 } },
          React.createElement(Icon, { name: 'UtensilsCrossed', size: 22, color: MEALS_GREEN }),
          React.createElement('span', { style: { fontFamily: PIXEL, fontWeight: 700, fontSize: 24, letterSpacing: '0.03em', color: MEALS_GREEN } }, 'MEALS COLLECTED')),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', marginBottom: 18 } },
          dashLine(),
          React.createElement('span', { style: { fontFamily: PIXEL, fontSize: 13, color: THEME.green, whiteSpace: 'nowrap' } }, collected.length + ' collected'),
          dashLine()),
        // Card grid
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 } },
          slots.map((m, i) => m
            ? React.createElement(MealCollectCard, { key: m.id || i, meal: m, onOpen: onOpenMeal, onLog: onLogMeal })
            : React.createElement(EmptyMealCard, { key: 'e' + i })))
      )
    )
  );
}

// ─── Progress Page — scene-backdrop header, Individual / Leaderboard tabs ──────
const PROG_RED    = '#D14B3C';   // over-goal
const PROG_GREEN  = '#4C7B3B';   // today / on-track
const PROG_BAR    = '#D8CBAE';   // past-day bar (tan)
const PROG_TODAYBG = '#E7EFDD';  // today row / goal pill fill

// A cream card that floats on the tan panel — the shared block for each progress section.
function ProgressCard({ icon, title, right, children }) {
  return React.createElement('div', { style: { background: MEALS_CARD, border: '1px solid ' + MEALS_LINE, borderRadius: 18, boxShadow: '0 2px 0 rgba(60,50,30,0.05), 0 6px 14px rgba(60,50,30,0.08)', padding: '16px 16px 18px', marginBottom: 14 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        React.createElement(Icon, { name: icon, size: 18, color: MEALS_GREEN }),
        React.createElement('span', { style: pixelLabel({ fontSize: 15, color: MEALS_GREEN, letterSpacing: '0.02em' }) }, title)),
      right || null),
    children
  );
}

function StatTile({ label, value, unit, foot, footColor }) {
  return React.createElement('div', { style: { flex: 1, minWidth: 0, background: THEME.creamHi, border: '1px solid ' + MEALS_LINE, borderRadius: 14, padding: '12px 4px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 } },
    React.createElement('div', { style: pixelLabel({ fontSize: 8, color: THEME.sub, letterSpacing: '0.02em', lineHeight: 1.25, minHeight: 20, display: 'flex', alignItems: 'center', textAlign: 'center' }) }, label),
    React.createElement('div', { style: { fontSize: 23, fontWeight: 900, color: THEME.ink, lineHeight: 1.1 } }, value),
    unit && React.createElement('div', { style: { fontSize: 9.5, color: THEME.sub } }, unit),
    foot && React.createElement('div', { style: { fontSize: 10, fontWeight: 700, color: footColor || THEME.sub, marginTop: 2 } }, foot)
  );
}

function AnalyticsPage({ meals, goals }) {
  const [tab, setTab] = useState('individual');

  // Seven-day window ending `endOffset` days before today (0 = the current week, 7 = the prior).
  const week = (endOffset) => Array.from({ length: 7 }, (_, i) => addDays(today(), -(endOffset + 6 - i)));
  const sumDay = (d) => {
    const ms = meals[toDateKey(d)] || [];
    const t = ms.reduce((a, m) => ({
      protein: a.protein + (Number(m.protein) || 0), carbs: a.carbs + (Number(m.carbs) || 0),
      fat: a.fat + (Number(m.fat) || 0), calories: a.calories + (Number(m.calories) || 0),
    }), { protein: 0, carbs: 0, fat: 0, calories: 0 });
    return { date: d, key: toDateKey(d), ...t, mealCount: ms.length };
  };
  const dayData = week(0).map(sumDay);
  const prevData = week(7).map(sumDay);

  const goalCals = goals ? (goals.calories || (goals.protein * 4 + goals.carbs * 4 + goals.fat * 9)) : 0;
  const sum = (arr, k) => arr.reduce((a, d) => a + d[k], 0);
  const avg = (arr, k) => Math.round(sum(arr, k) / (arr.length || 1));
  const avgCals = avg(dayData, 'calories');
  const totalCals = Math.round(sum(dayData, 'calories'));
  const bestDay = Math.round(Math.max(...dayData.map(d => d.calories), 0));
  const mealsLogged = dayData.reduce((a, d) => a + d.mealCount, 0);
  const prevAvg = avg(prevData, 'calories');
  const pctChange = prevAvg > 0 ? Math.round(((avgCals - prevAvg) / prevAvg) * 100) : null;

  // Bar-chart y-axis: round the taller of the week's peak or the daily goal up to a clean 1K step.
  const peak = Math.max(...dayData.map(d => d.calories), goalCals, 1);
  const yMax = Math.max(1000, Math.ceil(peak / 1000) * 1000);
  const gridLines = []; for (let v = yMax; v >= 0; v -= 1000) gridLines.push(v);
  const PLOT_H = 150;

  const todayData = dayData[6];
  const overToday = goalCals > 0 && todayData.calories > goalCals;
  const goalDiff = Math.round(Math.abs(goalCals - todayData.calories));

  const dayInitial = (d) => d.date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
  const rowDate = (d) => d.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const numCell = (v, extra = {}) => React.createElement('td', { style: { padding: '10px 4px', textAlign: 'center', fontSize: 13, color: THEME.sub, ...extra } }, v);

  // ── Individual tab body ──
  const individual = React.createElement(React.Fragment, null,
    // DAILY CALORIES — bar chart + range pill + goal note
    React.createElement(ProgressCard, {
      icon: 'Flame', title: 'DAILY CALORIES',
      right: React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, background: THEME.creamHi, border: '1px solid ' + MEALS_LINE, borderRadius: 10, padding: '6px 10px', fontSize: 12, color: THEME.ink, fontWeight: 700, whiteSpace: 'nowrap' } },
        'Last 7 days', React.createElement(Icon, { name: 'ChevronDown', size: 14, color: THEME.sub })),
    },
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        // y-axis
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: PLOT_H, width: 22, textAlign: 'right', fontSize: 10, color: THEME.sub, flexShrink: 0 } },
          gridLines.map((v, i) => React.createElement('div', { key: i }, v >= 1000 ? (v / 1000) + 'K' : v))),
        // plot
        React.createElement('div', { style: { position: 'relative', flex: 1 } },
          React.createElement('div', { style: { position: 'relative', height: PLOT_H } },
            gridLines.map((v, i) => React.createElement('div', { key: i, style: { position: 'absolute', left: 0, right: 0, top: PLOT_H * (1 - v / yMax), borderTop: '1px dashed ' + MEALS_LINE } })),
            React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 6 } },
              dayData.map(d => {
                const isToday = d.key === todayData.key;
                const over = goalCals > 0 && d.calories > goalCals;
                const h = d.calories > 0 ? Math.max(Math.round((d.calories / yMax) * PLOT_H), 5) : 4;
                const color = d.calories <= 0 ? PROG_BAR : (over ? PROG_RED : (isToday ? PROG_GREEN : PROG_BAR));
                return React.createElement('div', { key: d.key, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' } },
                  d.calories > 0 && React.createElement('div', { style: { fontSize: 10, fontWeight: 800, color: over ? PROG_RED : THEME.ink, marginBottom: 3 } }, Math.round(d.calories)),
                  React.createElement('div', { style: { width: '100%', maxWidth: 30, height: h, background: color, borderRadius: '5px 5px 0 0' } }));
              }))),
          // x labels
          React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            dayData.map(d => React.createElement('div', { key: d.key, style: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: d.key === todayData.key ? 800 : 500, color: d.key === todayData.key ? PROG_GREEN : THEME.sub } }, dayInitial(d)))))),
      goalCals > 0 && React.createElement('div', { style: { marginTop: 14, background: overToday ? '#F6E4E0' : PROG_TODAYBG, border: '1px solid ' + MEALS_LINE, borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: THEME.ink } },
        React.createElement(Icon, { name: 'Star', size: 15, color: overToday ? PROG_RED : PROG_GREEN }),
        React.createElement('span', null,
          overToday ? "You’re over your goal by " : "You’re under your goal by ",
          React.createElement('span', { style: { fontWeight: 800, color: overToday ? PROG_RED : PROG_GREEN } }, goalDiff + ' kcal'),
          ' today', overToday ? '.' : '!'))),

    // MACRO BREAKDOWN — per-day table + average row
    React.createElement(ProgressCard, { icon: 'PieChart', title: 'MACRO BREAKDOWN' },
      React.createElement('div', { style: { overflowX: 'auto' } },
        React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 300 } },
          React.createElement('thead', null,
            React.createElement('tr', { style: { color: THEME.sub, borderBottom: '1px solid ' + MEALS_LINE } },
              React.createElement('th', { style: { textAlign: 'left', padding: '0 4px 8px', fontSize: 12, fontWeight: 600 } }, 'Day'),
              ['Protein', 'Carbs', 'Fat', 'kcal'].map(h => React.createElement('th', { key: h, style: { textAlign: 'center', padding: '0 4px 8px', fontSize: 12, fontWeight: 600 } }, h)))),
          React.createElement('tbody', null,
            dayData.map(d => {
              const isToday = d.key === todayData.key;
              const over = goalCals > 0 && d.calories > goalCals;
              return React.createElement('tr', { key: d.key, style: { borderBottom: '1px solid ' + MEALS_LINE, background: isToday ? PROG_TODAYBG : 'transparent' } },
                React.createElement('td', { style: { padding: '10px 4px', fontSize: 13, fontWeight: 700, color: THEME.ink } }, rowDate(d)),
                numCell(Math.round(d.protein) + 'g'), numCell(Math.round(d.carbs) + 'g'), numCell(Math.round(d.fat) + 'g'),
                numCell(Math.round(d.calories), { fontWeight: 800, color: over ? PROG_RED : (isToday ? PROG_GREEN : THEME.ink) }));
            }),
            React.createElement('tr', { style: { background: '#EDE6D6' } },
              React.createElement('td', { style: { padding: '10px 4px', fontSize: 13, fontWeight: 800, color: THEME.ink } }, 'AVG.'),
              numCell(avg(dayData, 'protein') + 'g', { fontWeight: 800, color: THEME.ink }),
              numCell(avg(dayData, 'carbs') + 'g', { fontWeight: 800, color: THEME.ink }),
              numCell(avg(dayData, 'fat') + 'g', { fontWeight: 800, color: THEME.ink }),
              numCell(avgCals, { fontWeight: 800, color: THEME.ink })))))),

    // WEEKLY SUMMARY — four stat tiles
    React.createElement(ProgressCard, { icon: 'BarChart3', title: 'WEEKLY SUMMARY' },
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        React.createElement(StatTile, { label: 'AVG CALORIES', value: avgCals.toLocaleString(), unit: 'kcal/day',
          foot: pctChange != null ? (pctChange <= 0 ? '▼ ' : '▲ ') + Math.abs(pctChange) + '% vs last week' : null,
          footColor: pctChange != null ? (pctChange <= 0 ? PROG_GREEN : PROG_RED) : THEME.sub }),
        React.createElement(StatTile, { label: 'TOTAL CALORIES', value: totalCals.toLocaleString(), unit: 'kcal' }),
        React.createElement(StatTile, { label: 'BEST DAY', value: bestDay.toLocaleString(), unit: 'kcal', foot: '🔥' }),
        React.createElement(StatTile, { label: 'MEALS LOGGED', value: String(mealsLogged), unit: 'meals', foot: '🍴' })))
  );

  // ── Leaderboard tab body (LeaderBot) — placeholder until the design lands ──
  const leaderboard = React.createElement('div', { style: { textAlign: 'center', padding: '54px 24px', color: THEME.sub } },
    React.createElement('div', { style: { fontSize: 52, marginBottom: 14 } }, '🏆'),
    React.createElement('div', { style: pixelLabel({ fontSize: 17, color: MEALS_GREEN, marginBottom: 8 }) }, 'LEADERBOARD'),
    React.createElement('div', { style: { fontSize: 13, lineHeight: 1.5, maxWidth: 260, margin: '0 auto' } }, 'LeaderBot is on the way — compete with friends and climb the ranks. Coming soon.'));

  const tabBtn = (id, label, icon) => {
    const active = tab === id;
    return React.createElement('button', { key: id, onClick: () => setTab(id),
      style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 8px', borderRadius: 14, cursor: 'pointer',
        border: '1px solid ' + MEALS_LINE, background: active ? MEALS_CARD : 'rgba(70,55,40,0.09)',
        color: active ? MEALS_GREEN : THEME.sub, fontFamily: PIXEL, fontWeight: 700, fontSize: 14, letterSpacing: '0.03em',
        boxShadow: active ? '0 2px 0 rgba(60,50,30,0.06)' : 'none' } },
      React.createElement(Icon, { name: icon, size: 16, color: active ? MEALS_GREEN : THEME.sub }), label);
  };

  return React.createElement('div', { style: { position: 'relative', height: '100%', overflow: 'hidden', background: '#4A3423' } },
    // Journal-room backdrop (fixed; the cream panel scrolls over it). This scene is landscape
    // (1.5:1), unlike the portrait Home/Meals backdrops — so `cover` on a portrait phone zooms
    // into a tiny slice. Fit the full image width instead (top-anchored, no vertical tiling) so
    // the whole room shows in the reveal band.
    React.createElement('div', { style: { position: 'absolute', inset: 0, backgroundImage: "url('/assets/progress-bg.jpg')", backgroundSize: '100% auto', backgroundPosition: 'top center', backgroundRepeat: 'no-repeat', zIndex: 0 } }),
    React.createElement('div', { style: { position: 'absolute', inset: 0, overflowY: 'auto', zIndex: 1 } },
      React.createElement('div', { style: { height: '30vh' } }),   // reveal the scene above the panel
      React.createElement('div', { style: { minHeight: 'calc(100vh - 30vh)', background: MEALS_PANEL, borderTopLeftRadius: 28, borderTopRightRadius: 28, boxShadow: '0 -6px 20px rgba(0,0,0,0.22)', padding: '22px 16px 130px' } },
        // Header
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 2 } },
          React.createElement(Icon, { name: 'TrendingUp', size: 22, color: MEALS_GREEN }),
          React.createElement('span', { style: { fontFamily: PIXEL, fontWeight: 700, fontSize: 24, letterSpacing: '0.03em', color: MEALS_GREEN } }, 'PROGRESS')),
        React.createElement('div', { style: { textAlign: 'center', fontSize: 13, color: THEME.green, marginBottom: 16 } }, 'Track your journey'),
        // Tabs
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 16 } },
          tabBtn('individual', 'INDIVIDUAL', 'User'),
          tabBtn('leaderboard', 'LEADERBOARD', 'Trophy')),
        // Body
        tab === 'individual' ? individual : leaderboard
      )
    )
  );
}

// ─── Onboarding — collect body metrics, derive goals (Mifflin-St Jeor) ────────
const ACTIVITY_OPTIONS = [
  { key: 'sedentary',  label: 'Sedentary',   hint: 'Little or no exercise' },
  { key: 'light',      label: 'Light',       hint: 'Exercise 1–3 days/week' },
  { key: 'moderate',   label: 'Moderate',    hint: 'Exercise 3–5 days/week' },
  { key: 'active',     label: 'Active',      hint: 'Exercise 6–7 days/week' },
  { key: 'veryActive', label: 'Very active', hint: 'Hard daily training or physical job' },
];
const GOAL_OPTIONS = [
  { key: 'lose',     label: 'Lose',     hint: '−20%' },
  { key: 'maintain', label: 'Maintain', hint: 'at TDEE' },
  { key: 'gain',     label: 'Gain',     hint: '+15%' },
];

function cmFromFtIn(ft, inch) { return (Number(ft || 0) * 12 + Number(inch || 0)) * 2.54; }
function ftInFromCm(cm) { const t = Math.round(Number(cm || 0) / 2.54); return { ft: Math.floor(t / 12), in: t % 12 }; }
function kgFromLbs(lbs) { return Number(lbs || 0) * 0.453592; }
function lbsFromKg(kg) { return Math.round(Number(kg || 0) / 0.453592); }

function OnboardingSheet({ onComplete, onSkip, onCancel, initialProfile = null, editMode = false }) {
  const [step, setStep]   = useState('form');                       // 'form' | 'review'
  const [units, setUnits] = useState(initialProfile?.units || 'metric');
  const [age, setAge]     = useState(initialProfile?.age ? String(initialProfile.age) : '');
  const [sex, setSex]     = useState(initialProfile?.sex || '');
  const [cm, setCm]       = useState(initialProfile?.heightCm ? String(Math.round(initialProfile.heightCm)) : '');
  const _fi = initialProfile?.heightCm ? ftInFromCm(initialProfile.heightCm) : { ft: '', in: '' };
  const [ft, setFt]       = useState(_fi.ft === '' ? '' : String(_fi.ft));
  const [inch, setInch]   = useState(_fi.in === '' ? '' : String(_fi.in));
  const [kg, setKg]       = useState(initialProfile?.weightKg ? String(Math.round(initialProfile.weightKg)) : '');
  const [lbs, setLbs]     = useState(initialProfile?.weightKg ? String(lbsFromKg(initialProfile.weightKg)) : '');
  const [activity, setActivity] = useState(initialProfile?.activity || '');
  const [goalDir, setGoalDir]   = useState(initialProfile?.goalDir || '');
  const [error, setError] = useState('');
  const [draftGoals, setDraftGoals] = useState(null);

  const inp = { width: '100%', border: '1.5px solid #e5e7eb', borderRadius: 12, padding: '10px 12px', fontSize: 14, boxSizing: 'border-box', outline: 'none' };
  const lbl = { fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 5, fontWeight: 600 };
  const pill = (active) => ({ flex: 1, padding: '9px 8px', borderRadius: 12, border: '1.5px solid ' + (active ? '#22c55e' : '#e5e7eb'), background: active ? '#f0fdf4' : 'white', color: active ? '#16a34a' : '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'center' });

  function buildProfile() {
    const heightCm = units === 'metric' ? Number(cm) : cmFromFtIn(ft, inch);
    const weightKg = units === 'metric' ? Number(kg) : kgFromLbs(lbs);
    return { units, heightCm: Math.round(heightCm), weightKg: Math.round(weightKg), age: Number(age), sex, activity, goalDir };
  }

  function handleCalc() {
    const heightOk = units === 'metric' ? Number(cm) > 0 : (Number(ft) > 0 || Number(inch) > 0);
    const weightOk = units === 'metric' ? Number(kg) > 0 : Number(lbs) > 0;
    if (!(Number(age) > 0) || !sex || !heightOk || !weightOk || !activity || !goalDir) {
      setError('Please fill in every field.'); return;
    }
    const g = deriveGoals(buildProfile());
    if (!g) { setError('Could not compute goals — check your inputs.'); return; }
    setError(''); setDraftGoals(g); setStep('review');
  }

  // Full-page takeover (not a bottom sheet) — content column capped for readability on wide screens.
  const page  = { position: 'fixed', inset: 0, zIndex: 70, background: '#f9fafb', overflowY: 'auto' };
  const inner = { width: '100%', maxWidth: 480, minHeight: '100%', margin: '0 auto', boxSizing: 'border-box', padding: '56px 22px 40px', display: 'flex', flexDirection: 'column' };
  // Edit mode (opened from Settings) gets a close control to back out without saving.
  const cancelX = editMode && onCancel && React.createElement('button', { key: 'cancelX', onClick: onCancel, style: { position: 'absolute', top: 16, right: 16, background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 34, height: 34, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 } }, React.createElement(Icon, { name: 'X', size: 18 }));

  // ── Review step ──
  if (step === 'review') {
    return React.createElement('div', { style: page },
      cancelX,
      React.createElement('div', { style: inner },
        React.createElement('h2', { style: { fontSize: 26, fontWeight: 900, color: '#111', margin: '0 0 8px' } }, 'Your daily targets'),
        React.createElement('p', { style: { fontSize: 14, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 } }, 'Calculated from your details with the Mifflin-St Jeor formula. Tweak anything before you start — you can always change it later in Settings.'),
        React.createElement('div', { style: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 16, padding: '18px 18px', marginBottom: 18, display: 'flex', alignItems: 'baseline', gap: 6 } },
          React.createElement('span', { style: { fontSize: 38, fontWeight: 900, color: '#16a34a' } }, (draftGoals?.calories || 0).toLocaleString()),
          React.createElement('span', { style: { fontSize: 14, color: '#16a34a', fontWeight: 600 } }, 'kcal / day')
        ),
        React.createElement(GoalsEditor, { goals: draftGoals || {}, onChange: setDraftGoals }),
        React.createElement('div', { style: { display: 'flex', gap: 10, marginTop: 'auto', paddingTop: 28 } },
          React.createElement('button', { onClick: () => setStep('form'), style: { flex: 1, border: '1.5px solid #e5e7eb', borderRadius: 14, padding: '15px', fontSize: 15, fontWeight: 700, color: '#6b7280', background: 'white', cursor: 'pointer' } }, 'Back'),
          React.createElement('button', { onClick: () => onComplete(buildProfile(), draftGoals), style: { flex: 2, border: 'none', borderRadius: 14, padding: '15px', fontSize: 15, fontWeight: 700, color: 'white', background: '#22c55e', cursor: 'pointer' } }, editMode ? 'Save' : 'Start tracking')
        )
      )
    );
  }

  // ── Form step ──
  const heightField = units === 'metric'
    ? React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'cm', value: cm, onChange: e => setCm(e.target.value) })
    : React.createElement('div', { style: { display: 'flex', gap: 8 } },
        React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'ft', value: ft, onChange: e => setFt(e.target.value) }),
        React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'in', value: inch, onChange: e => setInch(e.target.value) })
      );
  const weightField = units === 'metric'
    ? React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'kg', value: kg, onChange: e => setKg(e.target.value) })
    : React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'lbs', value: lbs, onChange: e => setLbs(e.target.value) });

  return React.createElement('div', { style: page },
    cancelX,
    React.createElement('div', { style: inner },
      React.createElement('h2', { style: { fontSize: 26, fontWeight: 900, color: '#111', margin: '0 0 8px' } }, editMode ? 'Edit your metrics' : 'Set up your goals'),
      React.createElement('p', { style: { fontSize: 14, color: '#6b7280', margin: '0 0 22px', lineHeight: 1.5 } }, 'A few details let MacroWorld calculate your daily calorie and macro targets.'),

      // Units toggle
      React.createElement('div', { style: { display: 'flex', background: '#f3f4f6', borderRadius: 12, padding: 3, marginBottom: 16 } },
        ['metric', 'imperial'].map(u =>
          React.createElement('button', { key: u, onClick: () => setUnits(u), style: { flex: 1, padding: '8px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, background: units === u ? 'white' : 'transparent', color: units === u ? '#111' : '#9ca3af', boxShadow: units === u ? '0 1px 3px rgba(0,0,0,.1)' : 'none' } }, u === 'metric' ? 'Metric' : 'Imperial')
        )
      ),

      // Age + Sex
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 } },
        React.createElement('div', null,
          React.createElement('label', { style: lbl }, 'Age'),
          React.createElement('input', { type: 'number', inputMode: 'numeric', style: inp, placeholder: 'years', value: age, onChange: e => setAge(e.target.value) })
        ),
        React.createElement('div', null,
          React.createElement('label', { style: lbl }, 'Sex'),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('button', { onClick: () => setSex('male'), style: pill(sex === 'male') }, 'Male'),
            React.createElement('button', { onClick: () => setSex('female'), style: pill(sex === 'female') }, 'Female')
          )
        )
      ),

      // Height + Weight
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 } },
        React.createElement('div', null, React.createElement('label', { style: lbl }, 'Height'), heightField),
        React.createElement('div', null, React.createElement('label', { style: lbl }, 'Weight'), weightField)
      ),

      // Activity
      React.createElement('label', { style: lbl }, 'Activity level'),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 } },
        ACTIVITY_OPTIONS.map(o =>
          React.createElement('button', { key: o.key, onClick: () => setActivity(o.key),
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderRadius: 12, border: '1.5px solid ' + (activity === o.key ? '#22c55e' : '#e5e7eb'), background: activity === o.key ? '#f0fdf4' : 'white', cursor: 'pointer', textAlign: 'left' } },
            React.createElement('span', { style: { fontSize: 14, fontWeight: 700, color: activity === o.key ? '#16a34a' : '#374151' } }, o.label),
            React.createElement('span', { style: { fontSize: 11, color: '#9ca3af' } }, o.hint)
          )
        )
      ),

      // Goal direction
      React.createElement('label', { style: lbl }, 'Goal'),
      React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        GOAL_OPTIONS.map(o =>
          React.createElement('button', { key: o.key, onClick: () => setGoalDir(o.key), style: { ...pill(goalDir === o.key), display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 6px' } },
            React.createElement('span', null, o.label),
            React.createElement('span', { style: { fontSize: 10, color: goalDir === o.key ? '#16a34a' : '#9ca3af', fontWeight: 600 } }, o.hint)
          )
        )
      ),

      error && React.createElement('p', { style: { color: '#ef4444', fontSize: 12, margin: '16px 0 0', marginTop: 'auto' } }, error),

      React.createElement('button', { onClick: handleCalc, style: { width: '100%', border: 'none', borderRadius: 14, padding: '16px', fontSize: 15, fontWeight: 700, color: 'white', background: '#22c55e', cursor: 'pointer', marginTop: error ? 12 : 'auto' } }, 'Calculate my goals'),

      !editMode && onSkip && React.createElement('button', { onClick: onSkip, style: { width: '100%', background: 'none', border: 'none', padding: 12, fontSize: 13, color: '#9ca3af', cursor: 'pointer', marginTop: 4 } }, 'Set goals manually instead')
    )
  );
}

// ─── Bottom navigation ────────────────────────────────────────────────────────
function BottomNav({ page, onHome, onMeals, onProgress, onAdd, onMore }) {
  const tabs = [
    { key: 'home',     label: 'HOME',     icon: 'Home',            on: onHome,     active: page === 'home' },
    { key: 'meals',    label: 'MEALS',    icon: 'UtensilsCrossed', on: onMeals,    active: page === 'meals' },
    { key: 'progress', label: 'PROGRESS', icon: 'BarChart3',       on: onProgress, active: page === 'analytics' },
    { key: 'add',      label: 'ADD',      icon: 'Plus',            on: onAdd,      active: false },
    { key: 'more',     label: 'MORE',     icon: 'Menu',            on: onMore,     active: false },
  ];
  return React.createElement('div', {
    style: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 40, background: THEME.greenDk, borderTopLeftRadius: 20, borderTopRightRadius: 20, display: 'flex', padding: '10px 8px calc(12px + env(safe-area-inset-bottom))', boxShadow: '0 -4px 16px rgba(0,0,0,0.15)' }
  },
    tabs.map(t => React.createElement('button', {
      key: t.key, onClick: t.on,
      style: { flex: 1, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 0' }
    },
      React.createElement(Icon, { name: t.icon, size: 22, color: t.active ? THEME.gold : '#9FB08F' }),
      React.createElement('span', { style: pixelLabel({ fontSize: 9, color: t.active ? THEME.gold : '#9FB08F' }) }, t.label)
    ))
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
function App() {
  const [page, setPage]               = useState('home');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [meals, setMeals]             = useState(() => storageGet(MEALS_KEY) || {});
  const [goals, setGoals]             = useState(() => storageGet(GOALS_KEY) || DEFAULT_GOALS);
  const [profile, setProfile]         = useState(() => storageGet(PROFILE_KEY) || null);
  const [game, setGame]               = useState(() => storageGet(GAME_KEY) || seedGame(storageGet(MEALS_KEY) || {}));
  const [detailMeal, setDetailMeal]   = useState(null);
  const [relogMeal, setRelogMeal]     = useState(null);
  const [justFed, setJustFed]         = useState(false);
  const fedTimerRef                   = useRef(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCamera, setShowCamera]   = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [user, setUser]               = useState(null);
  const [authorized, setAuthorized]   = useState(null);   // null = checking · true · false
  const [authReady, setAuthReady]     = useState(!isFirebaseConfigured());
  const firestoreSaveRef = useRef(null);
  const latestRef        = useRef(null);
  const [sprites, setSprites] = useState(() => storageGet(SPRITES_KEY) || {});
  const spritesRef = useRef(sprites);

  // Keep latestRef always current — read inside the debounced save to avoid stale closures
  useEffect(() => { latestRef.current = { meals, goals, profile, game, user }; });

  // Sprite store: deduped base64 keyed by id, kept OUT of the meals doc (its own Firestore subcollection).
  const addSprite = useCallback((id, b64) => {
    if (!id || !b64 || spritesRef.current[id]) return;
    spritesRef.current = { ...spritesRef.current, [id]: b64 };
    setSprites(spritesRef.current);
    storageSet(SPRITES_KEY, spritesRef.current);
    const u = latestRef.current?.user;
    if (u && isFirebaseConfigured()) {
      firebase.firestore().collection('users').doc(u.uid).collection('sprites').doc(id).set({ data: b64 })
        .catch(e => console.error('[Firestore] sprite save failed:', e));
    }
  }, []);
  const resolveSprite = useCallback(meal => {
    if (!meal) return null;
    return meal.spriteId ? (sprites[meal.spriteId] || null) : (meal.sprite || null);
  }, [sprites]);

  // Firebase auth listener + handle redirect result from signInWithRedirect
  useEffect(() => {
    if (!initFirebase()) return;

    // Handle the redirect return — fires before onAuthStateChanged on a fresh page load
    firebase.auth().getRedirectResult().then(result => {
      if (result && result.user) {
        setUser(result.user);
        loadUserData(result.user);
      }
    }).catch(e => console.error('[Auth] redirect result error:', e));

    const unsub = firebase.auth().onAuthStateChanged(u => {
      setUser(u);
      setAuthReady(true);
      if (u) {
        loadUserData(u);
      }
    });
    return unsub;
  }, []);

  // First-run onboarding — for a signed-in user with no profile yet.
  useEffect(() => {
    if (!authReady) return;
    if (!profile && !localStorage.getItem('onboarding-dismissed')) setShowOnboarding(true);
  }, [authReady, profile]);

  async function loadUserData(u) {
    try {
      const ref = firebase.firestore().collection('users').doc(u.uid);
      const snap = await ref.get();
      if (snap.exists) {
        const d = snap.data();
        if (d.goals) setGoals(d.goals);
        if (d.profile) { setProfile(d.profile); storageSet(PROFILE_KEY, d.profile); }
        if (d.meals && Object.keys(d.meals).length > 0) {
          setMeals(d.meals);
          storageSet(MEALS_KEY, d.meals);
        }
        if (d.game) { setGame(d.game); storageSet(GAME_KEY, d.game); }
        else if (d.meals) { const g = seedGame(d.meals); setGame(g); storageSet(GAME_KEY, g); }
      }
      // Load the sprite subcollection into the store (kept out of the main doc).
      const sprSnap = await ref.collection('sprites').get();
      if (!sprSnap.empty) {
        const merged = { ...spritesRef.current };
        sprSnap.forEach(doc => { const v = doc.data(); if (v && v.data) merged[doc.id] = v.data; });
        spritesRef.current = merged;
        setSprites(merged);
        storageSet(SPRITES_KEY, merged);
      }
    } catch(e) { console.error('[Firestore] Load failed:', e); }
  }

  function scheduleFirestoreSave() {
    clearTimeout(firestoreSaveRef.current);
    firestoreSaveRef.current = setTimeout(async () => {
      const { meals, goals, profile, game, user: u } = latestRef.current || {};
      if (!u || !isFirebaseConfigured()) return;
      // Strip pendingPhoto (a local-only regeneration fallback) so it never counts against
      // the 1 MiB document limit — the sprite itself lives in its own subcollection.
      const cleanMeals = {};
      for (const [k, arr] of Object.entries(meals || {})) {
        cleanMeals[k] = (arr || []).map(({ pendingPhoto, ...rest }) => rest);
      }
      try {
        await firebase.firestore().collection('users').doc(u.uid).set({ meals: cleanMeals, goals, profile: profile || null, game: game || null });
      } catch(e) { console.error('[Firestore] Save failed:', e); }
    }, 1500);
  }

  // Persist to localStorage; schedule Firestore save on any data change
  useEffect(() => { storageSet(MEALS_KEY, meals); scheduleFirestoreSave(); }, [meals]);
  useEffect(() => { storageSet(GOALS_KEY, goals); scheduleFirestoreSave(); }, [goals]);
  useEffect(() => { storageSet(PROFILE_KEY, profile); scheduleFirestoreSave(); }, [profile]);
  useEffect(() => { storageSet(GAME_KEY, game); scheduleFirestoreSave(); }, [game]);

  function addMeal(dateKey, meal) {
    const m = { ...meal, loggedAt: meal.loggedAt || Date.now() };

    // Would this meal push today's total across the calorie goal? (award a bonus if so)
    const goalCals = goals.calories || (goals.protein * 4 + goals.carbs * 4 + goals.fat * 9);
    const dayCals  = (meals[dateKey] || []).reduce((s, x) => s + (Number(x.calories) || 0), 0);
    const mealCals = m.calories || calcCals(m.protein, m.carbs, m.fat);
    const hitsGoal = isSameDay(new Date(dateKey), today()) && goalCals > 0 && dayCals < goalCals && (dayCals + mealCals) >= goalCals;

    setMeals(prev => ({ ...prev, [dateKey]: [...(prev[dateKey] || []), m] }));
    setGame(prev => applyRewards(prev, XP_PER_MEAL + (hitsGoal ? GOAL_XP_BONUS : 0), COINS_PER_MEAL + (hitsGoal ? GOAL_COIN_BONUS : 0)));

    // Trigger the eating animation on the home scene for a few seconds.
    clearTimeout(fedTimerRef.current);
    setJustFed(true);
    fedTimerRef.current = setTimeout(() => setJustFed(false), 3500);
  }

  function deleteMeal(dateKey, id) {
    setMeals(prev => ({ ...prev, [dateKey]: (prev[dateKey] || []).filter(m => m.id !== id) }));
  }

  // Patch a meal by id across every day bucket. Also updates the open detail view so a
  // just-regenerated sprite shows immediately (resolveSprite keys off the meal's spriteId).
  function updateMeal(id, patch) {
    setMeals(prev => {
      const next = {};
      for (const [k, arr] of Object.entries(prev)) next[k] = arr.map(m => m.id === id ? { ...m, ...patch } : m);
      return next;
    });
    setDetailMeal(dm => (dm && dm.id === id ? { ...dm, ...patch } : dm));
  }

  async function handleSignIn() {
    if (!isFirebaseConfigured()) return;
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch(e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request') {
        try { await firebase.auth().signInWithRedirect(provider); } catch(e2) { console.error(e2); }
      } else if (e.code !== 'auth/popup-closed-by-user') { console.error(e); }
    }
  }

  async function handleSignOut() {
    await firebase.auth().signOut();
    setUser(null);
    setShowSettings(false);
  }

  // Verify the signed-in user against the server email allowlist.
  useEffect(() => {
    if (!user) { setAuthorized(null); return; }
    let alive = true;
    authedFetch('/api/authorize', { method: 'POST' })
      .then(res => { if (alive) setAuthorized(res.ok); })
      .catch(() => { if (alive) setAuthorized(false); });
    return () => { alive = false; };
  }, [user]);

  // Spinner while Firebase checks auth state
  if (!authReady) {
    return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f9fafb' } },
      React.createElement('div', { style: { width: 36, height: 36, borderRadius: '50%', border: '3px solid #e5e7eb', borderTopColor: '#22c55e', animation: 'spin 0.8s linear infinite' } })
    );
  }

  const GATE_WRAP = { minHeight: '100vh', background: '#f0fdf4', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' };

  // Must sign in with an allowed Google account to use the app.
  if (!user) {
    return React.createElement('div', { style: GATE_WRAP },
      React.createElement('div', { style: { fontSize: 46, marginBottom: 10 } }, '🍔'),
      React.createElement('h1', { style: { fontSize: 30, fontWeight: 900, color: '#111', margin: '0 0 6px', letterSpacing: '-0.02em' } }, 'MacroWorld'),
      React.createElement('p', { style: { fontSize: 14, color: '#6b7280', margin: '0 0 28px', maxWidth: 300, lineHeight: 1.5 } }, 'Sign in to track your macros and feed your pet.'),
      React.createElement('button', { onClick: handleSignIn, style: { display: 'flex', alignItems: 'center', gap: 10, background: 'white', border: '1.5px solid #e5e7eb', borderRadius: 14, padding: '13px 22px', fontSize: 15, fontWeight: 600, color: '#374151', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,.1)' } },
        React.createElement(GoogleIcon), 'Continue with Google'
      )
    );
  }

  // Signed in, waiting on the allowlist check.
  if (authorized === null) {
    return React.createElement('div', { style: GATE_WRAP },
      React.createElement('div', { style: { width: 36, height: 36, borderRadius: '50%', border: '3px solid #e5e7eb', borderTopColor: '#22c55e', animation: 'spin 0.8s linear infinite' } }),
      React.createElement('p', { style: { fontSize: 13, color: '#9ca3af', marginTop: 14 } }, 'Checking access…')
    );
  }

  // Signed in but not on the allowlist — access denied.
  if (authorized === false) {
    return React.createElement('div', { style: GATE_WRAP },
      React.createElement('div', { style: { fontSize: 42, marginBottom: 10 } }, '⛔'),
      React.createElement('h1', { style: { fontSize: 23, fontWeight: 800, color: '#b91c1c', margin: '0 0 8px' } }, 'Access not allowed'),
      React.createElement('p', { style: { fontSize: 14, color: '#6b7280', margin: '0 0 26px', maxWidth: 320, lineHeight: 1.5 } }, (user.email || 'This account') + ' doesn’t have access to MacroWorld.'),
      React.createElement('button', { onClick: handleSignOut, style: { background: '#f3f4f6', border: 'none', borderRadius: 12, padding: '11px 22px', fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' } }, 'Sign out')
    );
  }

  return (
    React.createElement(SpriteCtx.Provider, { value: { resolve: resolveSprite, add: addSprite } },
    React.createElement('div', { style: { position: 'relative', width: '100%', height: '100vh', background: THEME.creamHi, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },

      // Pages
      React.createElement('div', { style: { flex: 1, overflow: 'hidden' } },
        page === 'home'
          ? React.createElement(HomePage, {
              meals, goals, game, justFed,
              spriteSet: resolveSpriteSet(user?.email),
              onOpenMeal: setDetailMeal,
              onOpenSettings: () => setShowSettings(true),
              onGoProgress: () => setPage('analytics'),
              onGoMeals: () => setPage('meals'),
            })
          : page === 'meals'
          ? React.createElement(MealsPage, { meals, onOpenMeal: setDetailMeal, onLogMeal: setRelogMeal })
          : React.createElement(AnalyticsPage, { meals, goals })
      ),

      // Bottom nav — Home · Meals · Progress · Add · More
      React.createElement(BottomNav, {
        page,
        onHome:     () => setPage('home'),
        onMeals:    () => setPage('meals'),
        onProgress: () => setPage('analytics'),
        onAdd:      () => setShowCamera(true),
        onMore:     () => setShowSettings(true),
      }),

      detailMeal && React.createElement(MealDetail, { meal: detailMeal, onClose: () => setDetailMeal(null), onUpdateMeal: updateMeal }),

      // Re-log a past meal: open the entry form pre-filled with its macros; reuse its sprite on add.
      relogMeal && React.createElement(MealForm, {
        allMeals: meals,
        prefill: relogMeal,
        onAdd: meal => { addMeal(toDateKey(today()), { ...meal, spriteId: relogMeal.spriteId }); setRelogMeal(null); setPage('home'); },
        onCancel: () => setRelogMeal(null)
      }),

      showCamera && React.createElement(CameraCapture, {
        allMeals: meals,
        onAdd: meal => { addMeal(toDateKey(today()), meal); setShowCamera(false); setPage('home'); },
        onCancel: () => setShowCamera(false)
      }),

      showSettings && React.createElement(SettingsSheet, {
        user,
        goals,
        onGoalsChange: g => setGoals(g),
        profile,
        onEditProfile: () => setShowProfileEdit(true),
        onSignIn: handleSignIn,
        onSignOut: handleSignOut,
        onClose: () => setShowSettings(false)
      }),

      showOnboarding && React.createElement(OnboardingSheet, {
        onComplete: (prof, g) => { setProfile(prof); setGoals(g); setShowOnboarding(false); },
        onSkip: () => { localStorage.setItem('onboarding-dismissed', '1'); setShowOnboarding(false); }
      }),

      showProfileEdit && React.createElement(OnboardingSheet, {
        editMode: true,
        initialProfile: profile,
        onComplete: (prof, g) => { setProfile(prof); setGoals(g); setShowProfileEdit(false); },
        onCancel: () => setShowProfileEdit(false)
      })
    )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
