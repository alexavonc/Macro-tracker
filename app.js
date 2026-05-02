const { useState, useEffect, useCallback, useRef } = React;

// ─── Storage helpers ──────────────────────────────────────────────────────────
const MEALS_KEY = 'macro-tracker-meals';
const GOALS_KEY = 'macro-tracker-goals';

function storageGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
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

// ─── Pet system — sprite sheet ───────────────────────────────────────────────
// Sheet: public/assets/cat-sprite.png  →  1536×1024, 7 cols × 4 rows = 28 frames
// Row 1 (frames  0-6):  idle
// Row 2 (frames  7-13): hungry
// Row 3 (frames 14-20): evolve / sparkle
// Row 4 (frames 21-27): dead (unused in this app — mapped to happy)

const SPRITE_PATH = '/assets/cat-sprite.png';

const ANIMATIONS = {
  idle:   { frames: [0,1,2,3,4,5],       fps: 1.62, loop: true  },
  hungry: { frames: [7,8,9,10,11,12],    fps: 2.16, loop: true  },
  evolve: { frames: [14,15,16,17,18,19], fps: 5.4,  loop: false },
  happy:  { frames: [14,15,16,17],       fps: 3.24, loop: true  },
};

// Per-frame source rects [sx, sy, sw, sh] in the original 1536×1024 sprite sheet.
// Derived by cross-cell connected-component analysis: floods across ±1 cell boundary
// to capture cats whose bodies physically cross cell edges (e.g. the sleeping cat).
const FRAME_BBOXES = [
  [  103,   87, 147, 151],  //  0 idle c0
  [  312,   87, 145, 150],  //  1 idle c1
  [  502,   87, 147, 151],  //  2 idle c2
  [  695,   87, 146, 151],  //  3 idle c3
  [  887,   87, 147, 151],  //  4 idle c4
  [ 1080,   87, 145, 151],  //  5 idle c5
  [ 1317,    0, 219, 256],  //  6 (unused)
  [  104,  292, 153, 140],  //  7 hungry c0
  [  310,  304, 149, 129],  //  8 hungry c1
  [  488,  304, 155, 128],  //  9 hungry c2
  [  678,  296, 147, 137],  // 10 hungry c3
  [  875,  291, 146, 141],  // 11 hungry c4
  [ 1066,  328, 178, 115],  // 12 hungry c5 — sleeping cat crosses cell boundary
  [ 1317,  256, 219, 256],  // 13 (unused)
  [  105,  512, 152, 124],  // 14 evolve c0
  [  312,  512, 149, 124],  // 15 evolve c1
  [  502,  512, 131, 124],  // 16 evolve c2
  [  693,  512, 122, 124],  // 17 evolve c3
  [  888,  512, 132, 124],  // 18 evolve c4
  [ 1064,  512, 172, 128],  // 19 evolve c5 — crosses cell boundary
  [ 1317,  512, 219, 256],  // 20 (unused)
  [    0,  768, 219, 256],  // 21 (unused)
  [  219,  768, 220, 256],  // 22 (unused)
  [  439,  768, 219, 256],  // 23 (unused)
  [  658,  768, 220, 256],  // 24 (unused)
  [  878,  768, 219, 256],  // 25 (unused)
  [ 1097,  768, 220, 256],  // 26 (unused)
  [ 1317,  768, 219, 256],  // 27 (unused)
];

// MAX=200 accommodates the widest cross-boundary frame (f12: sw=178) at size=240
const MAX_FRAME_W = 200;
const MAX_FRAME_H = 200;

// Alpha-weighted centroid x within each bbox (recomputed after cross-cell expansion).
const FRAME_CENT_X = [
   66.4,  63.2,  67.6,  67.0,  67.1,  67.1, 109.5,  // 0-6  idle row
   66.9,  66.6,  69.7,  68.2,  68.7,  81.1, 109.5,  // 7-13 hungry row
   70.2,  71.5,  59.7,  55.2,  64.6,  81.8, 109.5,  // 14-20 evolve row
  109.5, 109.5, 109.5, 109.5, 109.5, 109.5, 109.5,  // 21-27 dead row (unused)
];

// Global sprite cache — load once, resolve all pending callbacks
let _sprite  = null;
const _queue = [];
let _loading = false;

function loadSprite(cb) {
  if (_sprite)  { cb(_sprite); return; }
  _queue.push(cb);
  if (_loading) return;
  _loading = true;
  const img = new Image();
  img.src = SPRITE_PATH;
  img.onload  = () => { _sprite = img; _queue.forEach(fn => fn(img)); _queue.length = 0; };
  img.onerror = () => console.error('[PetCat] sprite failed:', SPRITE_PATH);
}

function PetCat({ state = 'idle', size = 160 }) {
  const canvasRef   = useRef(null);
  const timerRef    = useRef(null);
  const frameIdxRef = useRef(0);
  const [sprite, setSprite] = useState(null);

  const scale = Math.min(size / MAX_FRAME_W, size / MAX_FRAME_H);

  useEffect(() => {
    loadSprite(img => setSprite(img));
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  useEffect(() => {
    if (!sprite) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const anim = ANIMATIONS[state] || ANIMATIONS.idle;
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
      const [sx, sy, sw, sh] = FRAME_BBOXES[fi];
      const dw = Math.round(sw * scale);
      const dh = Math.round(sh * scale);
      const dx = Math.round(size / 2 - FRAME_CENT_X[fi] * scale);
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
  const cals = meal.calories || calcCals(meal.protein, meal.carbs, meal.fat);
  return (
    React.createElement('div', { className: 'flex items-center justify-between py-3 border-b border-gray-50 last:border-0' },
      React.createElement('div', { className: 'flex-1 min-w-0' },
        React.createElement('div', { className: 'font-medium text-gray-800 text-sm truncate' }, meal.name),
        meal.serving && React.createElement('div', { className: 'text-xs text-gray-400 mt-0.5' }, meal.serving),
        React.createElement('div', { className: 'flex gap-3 mt-1 text-xs text-gray-500' },
          React.createElement('span', null, `P: ${meal.protein}g`),
          React.createElement('span', null, `C: ${meal.carbs}g`),
          React.createElement('span', null, `F: ${meal.fat}g`)
        )
      ),
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
function MealForm({ allMeals, onAdd, onCancel, apiKey }) {
  const [name, setName] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [calories, setCalories] = useState('');
  const [serving, setServing] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

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
    if (!apiKey) { setError('No API key set. Add your Anthropic API key in Settings.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
      setError('Failed to get macros. Check your API key or try again.');
      console.error(e);
    } finally { setLoading(false); }
  }

  function handleSubmit() {
    if (!name.trim()) { setError('Enter a meal name.'); return; }
    const p = Number(protein) || 0, c = Number(carbs) || 0, f = Number(fat) || 0;
    const cals = Number(calories) || calcCals(p, c, f);
    onAdd({ id: Date.now(), name: name.trim(), protein: p, carbs: c, fat: f, calories: cals, serving });
  }

  return (
    React.createElement('div', { className: 'fixed inset-0 z-50 flex items-end justify-center' },
      React.createElement('div', { className: 'absolute inset-0 bg-black/40', onClick: onCancel }),
      React.createElement('div', { className: 'relative bg-white rounded-t-3xl w-full max-w-lg p-6 pb-10 shadow-2xl' },
        React.createElement('div', { className: 'flex items-center justify-between mb-5' },
          React.createElement('h2', { className: 'text-lg font-bold text-gray-800' }, 'Add Meal'),
          React.createElement('button', { onClick: onCancel, className: 'text-gray-400 hover:text-gray-600' },
            React.createElement(Icon, { name: 'X', size: 22 }))
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

// ─── Goals Editor ─────────────────────────────────────────────────────────────
function GoalsEditor({ goals, onChange }) {
  const fields = [
    { key: 'protein', label: 'Protein', unit: 'g' },
    { key: 'carbs', label: 'Carbs', unit: 'g' },
    { key: 'fat', label: 'Fat', unit: 'g' },
  ];
  return (
    React.createElement('div', { className: 'flex gap-3 mt-3' },
      fields.map(f =>
        React.createElement('div', { key: f.key, className: 'flex-1' },
          React.createElement('label', { className: 'text-xs text-gray-500 block mb-1' }, f.label),
          React.createElement('div', { className: 'flex items-center border border-gray-200 rounded-xl overflow-hidden' },
            React.createElement('input', {
              type: 'number',
              className: 'flex-1 w-0 px-2 py-2 text-sm text-center focus:outline-none',
              value: goals[f.key],
              onChange: e => onChange({ ...goals, [f.key]: Number(e.target.value) || 0 })
            }),
            React.createElement('span', { className: 'text-xs text-gray-400 pr-2' }, f.unit)
          )
        )
      )
    )
  );
}

// ─── API Key modal ────────────────────────────────────────────────────────────
function ApiKeyModal({ current, onSave, onClose }) {
  const [val, setVal] = useState(current || '');
  return (
    React.createElement('div', { className: 'fixed inset-0 z-50 flex items-center justify-center' },
      React.createElement('div', { className: 'absolute inset-0 bg-black/40', onClick: onClose }),
      React.createElement('div', { className: 'relative bg-white rounded-2xl w-80 p-6 shadow-2xl' },
        React.createElement('h2', { className: 'font-bold text-gray-800 mb-3' }, 'Anthropic API Key'),
        React.createElement('p', { className: 'text-xs text-gray-500 mb-4' }, 'Required for AI macro lookup. Your key is stored locally only.'),
        React.createElement('input', {
          type: 'password',
          className: 'w-full border border-gray-200 rounded-xl px-4 py-3 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-green-400',
          placeholder: 'sk-ant-...',
          value: val,
          onChange: e => setVal(e.target.value)
        }),
        React.createElement('div', { className: 'flex gap-3' },
          React.createElement('button', { onClick: onClose, className: 'flex-1 border border-gray-200 rounded-xl py-2.5 text-sm font-semibold text-gray-600' }, 'Cancel'),
          React.createElement('button', { onClick: () => onSave(val.trim()), className: 'flex-1 bg-green-500 text-white rounded-xl py-2.5 text-sm font-semibold' }, 'Save')
        )
      )
    )
  );
}

// ─── Home Page ────────────────────────────────────────────────────────────────
function HomePage({ meals, goals, onGoalsChange, onAddMeal, onDeleteMeal, selectedDate, onDateChange, apiKey, onOpenSettings }) {
  const [showForm, setShowForm] = useState(false);
  const [editGoals, setEditGoals] = useState(false);
  const [justFed, setJustFed] = useState(false);
  const [evolveActive, setEvolveActive] = useState(false);
  const fedTimerRef = useRef(null);
  const evolveTimerRef = useRef(null);

  const dateKey = toDateKey(selectedDate);
  const dayMeals = meals[dateKey] || [];
  const isToday = isSameDay(selectedDate, today());

  const totals = dayMeals.reduce((acc, m) => ({
    protein: acc.protein + (Number(m.protein) || 0),
    carbs:   acc.carbs   + (Number(m.carbs)   || 0),
    fat:     acc.fat     + (Number(m.fat)     || 0),
    calories:acc.calories+ (Number(m.calories)|| 0),
  }), { protein: 0, carbs: 0, fat: 0, calories: 0 });

  const goalCals = goals.protein * 4 + goals.carbs * 4 + goals.fat * 9;
  const calPct   = goalCals > 0 ? totals.calories / goalCals : 0;
  const calsLeft = Math.round(goalCals - totals.calories);
  const calsOver = calsLeft < 0;

  // Pet state machine
  const petState = evolveActive ? 'evolve'
    : justFed ? 'happy'
    : (isToday && calPct < 0.2) ? 'hungry'
    : 'idle';

  function handleMealAdd(meal) {
    const mealCals = meal.calories || calcCals(meal.protein, meal.carbs, meal.fat);
    const willHitGoal = goalCals > 0 && totals.calories < goalCals && (totals.calories + mealCals) >= goalCals;

    onAddMeal(dateKey, meal);

    // Trigger happy animation
    clearTimeout(fedTimerRef.current);
    setJustFed(true);
    fedTimerRef.current = setTimeout(() => setJustFed(false), 3000);

    // Trigger evolve after happy if goal reached
    if (willHitGoal) {
      clearTimeout(evolveTimerRef.current);
      evolveTimerRef.current = setTimeout(() => {
        setEvolveActive(true);
        setTimeout(() => setEvolveActive(false), 5000);
      }, 3100);
    }
  }

  return (
    React.createElement('div', {
      style: {
        display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', overflow: 'hidden',
        backgroundImage: "url('/assets/room-bg.PNG')",
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
      }
    },

      // ── Pet name + hearts (top-left) ──
      React.createElement('div', {
        style: { position: 'absolute', top: 48, left: 20, zIndex: 30 }
      },
        React.createElement('div', {
          style: { color: 'white', fontWeight: 900, fontSize: 28, lineHeight: 1, textShadow: '1px 1px 0 rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)' }
        }, 'Bagel'),
        React.createElement(PetHearts, { calPct: isToday ? calPct : 0 })
      ),

      // ── Settings gear (top-right) ──
      React.createElement('button', {
        onClick: onOpenSettings,
        style: { position: 'absolute', top: 52, right: 20, zIndex: 30, background: 'none', border: 'none', cursor: 'pointer', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))' }
      }, React.createElement(Icon, { name: 'Settings', size: 22, color: 'white' })),

      // ── Cat (sitting on carpet) ──
      React.createElement('div', {
        style: {
          position: 'absolute',
          top: '38%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          pointerEvents: 'none'
        }
      }, React.createElement(PetCat, { state: petState, size: 240 })),

      // ── White scrollable card ──
      React.createElement('div', {
        style: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          top: '65%',
          backgroundColor: 'white',
          borderTopLeftRadius: 32,
          borderTopRightRadius: 32,
          overflowY: 'auto',
          paddingBottom: 120,
          zIndex: 20,
        }
      },
        // Date nav inside card
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 8px' } },
          React.createElement('button', {
            onClick: () => onDateChange(addDays(selectedDate, -1)),
            style: { background: 'none', border: 'none', cursor: 'pointer', padding: 4 }
          }, React.createElement(Icon, { name: 'ChevronLeft', size: 20 })),
          React.createElement('div', { style: { textAlign: 'center' } },
            React.createElement('div', { style: { fontWeight: 700, fontSize: 15, color: '#1f2937' } }, dateLabel(selectedDate)),
            !isToday && React.createElement('div', { style: { fontSize: 11, color: '#9ca3af' } }, formatDay(selectedDate))
          ),
          React.createElement('button', {
            onClick: () => !isToday && onDateChange(addDays(selectedDate, 1)),
            disabled: isToday,
            style: { background: 'none', border: 'none', cursor: isToday ? 'default' : 'pointer', padding: 4, opacity: isToday ? 0.3 : 1 }
          }, React.createElement(Icon, { name: 'ChevronRight', size: 20 }))
        ),

        // Calories + macros card
        React.createElement('div', { style: { margin: '0 16px 12px', background: '#f9fafb', borderRadius: 24, padding: '16px 20px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 } },
            React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 11, color: '#9ca3af', marginBottom: 2 } }, calsOver ? 'Calories over' : 'Calories left'),
              React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 4 } },
                React.createElement('span', { style: { fontSize: 36, fontWeight: 900, color: calsOver ? '#ef4444' : '#111827' } }, Math.abs(calsLeft).toLocaleString()),
                React.createElement('span', { style: { fontSize: 13, color: '#9ca3af' } }, 'kcal')
              )
            ),
            React.createElement('button', {
              onClick: () => setShowForm(true),
              style: { width: 48, height: 48, borderRadius: '50%', background: 'white', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.1)' }
            }, React.createElement(Icon, { name: 'Plus', size: 22 }))
          ),

          React.createElement('div', { style: { display: 'flex', gap: 16 } },
            React.createElement(MacroBar, { label: 'Carbs',    value: totals.carbs,   goal: goals.carbs }),
            React.createElement(MacroBar, { label: 'Fats',     value: totals.fat,     goal: goals.fat }),
            React.createElement(MacroBar, { label: 'Proteins', value: totals.protein, goal: goals.protein })
          ),

          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' } },
            React.createElement('button', {
              onClick: () => setEditGoals(g => !g),
              style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 4 }
            },
              React.createElement(Icon, { name: 'Target', size: 12 }),
              ` Goal: ${Math.round(goalCals).toLocaleString()} kcal`
            ),
            React.createElement('span', { style: { color: '#d1d5db', fontSize: 18 } }, '···')
          ),

          editGoals && React.createElement(GoalsEditor, { goals, onChange: onGoalsChange })
        ),

        // Meals list
        dayMeals.length > 0
          ? React.createElement('div', { style: { margin: '0 16px 12px', background: '#f9fafb', borderRadius: 24, padding: '16px 20px' } },
              React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 } }, `Meals · ${dayMeals.length}`),
              dayMeals.map(m => React.createElement(MealCard, { key: m.id, meal: m, onDelete: id => onDeleteMeal(dateKey, id) }))
            )
          : React.createElement('div', { style: { margin: '0 16px', background: '#f9fafb', borderRadius: 24, padding: 32, textAlign: 'center' } },
              React.createElement('div', { style: { fontSize: 36, marginBottom: 8 } }, '🍽️'),
              React.createElement('div', { style: { color: '#9ca3af', fontSize: 13 } }, 'No meals logged yet.'),
              React.createElement('div', { style: { color: '#d1d5db', fontSize: 11, marginTop: 4 } }, 'Tap + to add your first meal')
            )
      ),

      showForm && React.createElement(MealForm, {
        allMeals: meals,
        onAdd: meal => { handleMealAdd(meal); setShowForm(false); },
        onCancel: () => setShowForm(false),
        apiKey
      })
    )
  );
}

// ─── Analytics Page ───────────────────────────────────────────────────────────
function AnalyticsPage({ meals }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(today(), -(6 - i)));

  const dayData = days.map(d => {
    const key = toDateKey(d);
    const ms = meals[key] || [];
    const totals = ms.reduce((a, m) => ({
      protein: a.protein + (Number(m.protein) || 0),
      carbs: a.carbs + (Number(m.carbs) || 0),
      fat: a.fat + (Number(m.fat) || 0),
      calories: a.calories + (Number(m.calories) || 0),
    }), { protein: 0, carbs: 0, fat: 0, calories: 0 });
    return { date: d, key, ...totals, mealCount: ms.length };
  });

  const maxCals = Math.max(...dayData.map(d => d.calories), 1);
  const avg = (key) => {
    const vals = dayData.map(d => d[key]);
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const todayIdx = days.findIndex(d => isSameDay(d, today()));

  return (
    React.createElement('div', { className: 'flex flex-col h-full' },
      React.createElement('div', { className: 'bg-white px-4 pt-14 pb-4 border-b border-gray-100 flex-shrink-0' },
        React.createElement('h1', { className: 'text-2xl font-black text-gray-900' }, 'Statistics'),
        React.createElement('div', { className: 'text-sm text-gray-400' }, 'Last 7 days')
      ),

      React.createElement('div', { className: 'flex-1 overflow-y-auto px-4 pt-4 pb-32' },

        // Bar chart card
        React.createElement('div', { className: 'bg-white rounded-3xl shadow-sm p-5 mb-3' },
          React.createElement('div', { className: 'text-sm font-semibold text-gray-700 mb-4' }, 'Daily Calories'),
          React.createElement('div', { className: 'flex items-end gap-2 h-32' },
            dayData.map((d, i) => {
              const h = maxCals > 0 ? Math.max((d.calories / maxCals) * 100, d.calories > 0 ? 8 : 2) : 2;
              const isT = isSameDay(d.date, today());
              return React.createElement('div', { key: d.key, className: 'flex-1 flex flex-col items-center gap-1' },
                d.calories > 0 && React.createElement('div', { className: 'text-xs text-gray-400', style: { fontSize: 9 } }, Math.round(d.calories)),
                React.createElement('div', {
                  className: 'w-full rounded-t-lg transition-all',
                  style: { height: `${h}%`, backgroundColor: isT ? '#22c55e' : '#d1fae5' }
                }),
                React.createElement('div', { className: `text-xs ${isT ? 'font-bold text-green-600' : 'text-gray-400'}` },
                  d.date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0)
                )
              );
            })
          )
        ),

        // Macro breakdown table
        React.createElement('div', { className: 'bg-white rounded-3xl shadow-sm p-5 mb-3 overflow-x-auto' },
          React.createElement('div', { className: 'text-sm font-semibold text-gray-700 mb-4' }, 'Macro Breakdown'),
          React.createElement('table', { className: 'w-full text-xs min-w-max' },
            React.createElement('thead', null,
              React.createElement('tr', { className: 'text-gray-400 border-b border-gray-100' },
                React.createElement('th', { className: 'text-left py-2 font-medium' }, 'Day'),
                React.createElement('th', { className: 'text-right py-2 font-medium' }, 'Protein'),
                React.createElement('th', { className: 'text-right py-2 font-medium' }, 'Carbs'),
                React.createElement('th', { className: 'text-right py-2 font-medium' }, 'Fat'),
                React.createElement('th', { className: 'text-right py-2 font-medium' }, 'kcal')
              )
            ),
            React.createElement('tbody', null,
              dayData.map((d, i) => {
                const isT = isSameDay(d.date, today());
                return React.createElement('tr', { key: d.key, className: `border-b border-gray-50 ${isT ? 'bg-green-50' : ''}` },
                  React.createElement('td', { className: 'py-2.5 font-medium text-gray-700' },
                    d.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                  ),
                  React.createElement('td', { className: 'py-2.5 text-right text-gray-600' }, `${Math.round(d.protein)}g`),
                  React.createElement('td', { className: 'py-2.5 text-right text-gray-600' }, `${Math.round(d.carbs)}g`),
                  React.createElement('td', { className: 'py-2.5 text-right text-gray-600' }, `${Math.round(d.fat)}g`),
                  React.createElement('td', { className: 'py-2.5 text-right font-semibold text-gray-800' }, Math.round(d.calories))
                );
              }),
              // Averages row
              React.createElement('tr', { className: 'bg-gray-50 font-semibold' },
                React.createElement('td', { className: 'py-2.5 text-gray-700' }, 'Avg.'),
                React.createElement('td', { className: 'py-2.5 text-right text-gray-700' }, `${avg('protein')}g`),
                React.createElement('td', { className: 'py-2.5 text-right text-gray-700' }, `${avg('carbs')}g`),
                React.createElement('td', { className: 'py-2.5 text-right text-gray-700' }, `${avg('fat')}g`),
                React.createElement('td', { className: 'py-2.5 text-right text-gray-800' }, avg('calories'))
              )
            )
          )
        ),

        // Weekly summary
        React.createElement('div', { className: 'bg-white rounded-3xl shadow-sm p-5 mb-3' },
          React.createElement('div', { className: 'text-sm font-semibold text-gray-700 mb-3' }, 'Weekly Summary'),
          React.createElement('div', { className: 'grid grid-cols-2 gap-3' },
            [
              { label: 'Avg. Calories', value: `${avg('calories')} kcal` },
              { label: 'Avg. Protein', value: `${avg('protein')}g` },
              { label: 'Avg. Carbs', value: `${avg('carbs')}g` },
              { label: 'Avg. Fat', value: `${avg('fat')}g` },
            ].map(item =>
              React.createElement('div', { key: item.label, className: 'bg-gray-50 rounded-2xl p-4' },
                React.createElement('div', { className: 'text-xs text-gray-400 mb-1' }, item.label),
                React.createElement('div', { className: 'text-lg font-bold text-gray-800' }, item.value)
              )
            )
          )
        )
      )
    )
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
function App() {
  const [page, setPage] = useState('home');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [meals, setMeals] = useState(() => storageGet(MEALS_KEY) || {});
  const [goals, setGoals] = useState(() => storageGet(GOALS_KEY) || DEFAULT_GOALS);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('macro-tracker-apikey') || '');
  const [showApiKey, setShowApiKey] = useState(false);

  // Persist
  useEffect(() => { storageSet(MEALS_KEY, meals); }, [meals]);
  useEffect(() => { storageSet(GOALS_KEY, goals); }, [goals]);
  useEffect(() => { localStorage.setItem('macro-tracker-apikey', apiKey); }, [apiKey]);

  function addMeal(dateKey, meal) {
    setMeals(prev => ({ ...prev, [dateKey]: [...(prev[dateKey] || []), meal] }));
  }

  function deleteMeal(dateKey, id) {
    setMeals(prev => ({ ...prev, [dateKey]: (prev[dateKey] || []).filter(m => m.id !== id) }));
  }

  return (
    React.createElement('div', { className: 'relative w-full h-screen bg-gray-50 flex flex-col overflow-hidden' },

        // Pages
        React.createElement('div', { className: 'flex-1 overflow-hidden' },
          page === 'home'
            ? React.createElement(HomePage, {
                meals, goals, apiKey,
                onGoalsChange: g => setGoals(g),
                onAddMeal: addMeal,
                onDeleteMeal: deleteMeal,
                selectedDate,
                onDateChange: setSelectedDate,
                onOpenSettings: () => setShowApiKey(true),
              })
            : React.createElement(AnalyticsPage, { meals })
        ),

        // Bottom nav
        React.createElement('div', { className: 'absolute bottom-6 left-0 right-0 flex justify-center px-4 z-20' },
          React.createElement('div', { className: 'bg-white rounded-full shadow-lg px-6 py-3 flex items-center gap-6' },
            React.createElement('button', {
              onClick: () => setPage('home'),
              className: `flex flex-col items-center gap-0.5 ${page === 'home' ? 'text-gray-900' : 'text-gray-300'}`
            },
              React.createElement(Icon, { name: 'Home', size: 22, color: page === 'home' ? '#111' : '#d1d5db' })
            ),
            React.createElement('button', {
              onClick: () => setPage('analytics'),
              className: `flex flex-col items-center gap-0.5 ${page === 'analytics' ? 'text-gray-900' : 'text-gray-300'}`
            },
              React.createElement(Icon, { name: 'BarChart3', size: 22, color: page === 'analytics' ? '#111' : '#d1d5db' })
            )
          )
        ),

        // Floating + button
        React.createElement('button', {
          onClick: () => { setPage('home'); },
          className: 'absolute bottom-4 right-4 z-30 w-14 h-14 bg-gray-900 rounded-full shadow-xl flex items-center justify-center hover:bg-gray-700 transition-colors'
        }, React.createElement(Icon, { name: 'Plus', size: 26, color: 'white' })),

        showApiKey && React.createElement(ApiKeyModal, {
          current: apiKey,
          onSave: k => { setApiKey(k); setShowApiKey(false); },
          onClose: () => setShowApiKey(false)
        })
      )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
