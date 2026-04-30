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

// ─── Pet system ───────────────────────────────────────────────────────────────
function injectPetStyles() {
  if (document.getElementById('macro-pet-css')) return;
  const s = document.createElement('style');
  s.id = 'macro-pet-css';
  s.textContent = `
    @keyframes petBreathe { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(1.05)} }
    @keyframes tailIdle   { 0%,100%{transform:rotate(-8deg)} 50%{transform:rotate(8deg)} }
    @keyframes tailSad    { 0%,100%{transform:rotate(-4deg) translateY(5px)} 50%{transform:rotate(4deg) translateY(5px)} }
    @keyframes tailHappy  { 0%,100%{transform:rotate(-26deg)} 50%{transform:rotate(26deg)} }
    @keyframes petBlink   { 0%,87%,100%{transform:scaleY(1)} 90%{transform:scaleY(0.05)} 93%{transform:scaleY(1)} }
    @keyframes petDroop   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(5px)} }
    @keyframes petBounce  { 0%,100%{transform:translateY(0)} 45%{transform:translateY(-14px)} }
    @keyframes sparkleAnim{ 0%,100%{opacity:0;transform:scale(0) rotate(0deg)} 50%{opacity:1;transform:scale(1) rotate(45deg)} }
    @keyframes petGlow    { 0%,100%{filter:drop-shadow(0 0 8px #FFD700) drop-shadow(0 0 16px rgba(255,165,0,.5))} 50%{filter:drop-shadow(0 0 26px #FFD700) drop-shadow(0 0 52px rgba(255,165,0,.8))} }
  `;
  document.head.appendChild(s);
}

function catSVG(state, size) {
  const hungry = state === 'hungry';
  const happy  = state === 'happy';
  const evolve = state === 'evolve';
  const eating = happy || evolve;

  // Pixel grid: S = scale factor (SVG units per logical pixel)
  // Canvas: 20 x 26 logical pixels, centered in a 24x28 viewbox with 2px padding
  const S = 5;
  const OX = 2 * S; // x offset to center the 20px wide cat in 24px wide canvas
  const OY = 1 * S; // y offset

  // Color palette
  const K  = '#2C1A08'; // dark outline
  const Br = '#8B5E3C'; // medium brown fur
  const Lb = '#C48A50'; // light brown fur
  const Cr = '#F0D8A8'; // cream belly
  const Pk = '#E87878'; // pink inner ear / nose
  const Wh = '#FFFEF0'; // white eye highlight
  const Ir = '#3A6030'; // iris green
  const Pu = '#150800'; // pupil dark
  const Gd = '#F8D020'; // gold (evolve)
  const Rs = '#F0A080'; // rosy cheek

  // r(x, y, w, h, color) → SVG rect at logical pixel coords
  function r(x, y, w, h, c) {
    return `<rect x="${OX + x*S}" y="${OY + y*S}" width="${w*S}" height="${h*S}" fill="${c}"/>`;
  }

  // Body animation wrapper style
  const bodyAnim = eating
    ? `animation:petBounce .5s steps(2) infinite;transform-origin:${OX+10*S}px ${OY+18*S}px;`
    : hungry
    ? `animation:petDroop 3s ease-in-out infinite;`
    : `animation:petBreathe 3.5s ease-in-out infinite;transform-origin:${OX+10*S}px ${OY+18*S}px;`;

  // Tail animation
  const tailAnim = eating
    ? `transform-box:fill-box;transform-origin:0% 100%;animation:tailHappy .35s steps(2) infinite;`
    : hungry
    ? `transform-box:fill-box;transform-origin:0% 100%;animation:tailSad 3s ease-in-out infinite;`
    : `transform-box:fill-box;transform-origin:0% 100%;animation:tailIdle 2.5s ease-in-out infinite;`;

  const glowStyle = evolve ? 'animation:petGlow 1.2s ease-in-out infinite;' : '';
  const sc = evolve ? Gd : '#FFB0C8';

  // Sparkle rects (pixel stars)
  const sparkles = eating ? `
    <g style="animation:sparkleAnim .8s steps(2) infinite 0s;transform-origin:${1*S}px ${5*S}px;">
      ${r(-2,2,1,1,sc)}${r(-1,1,1,1,sc)}${r(-1,3,1,1,sc)}${r(0,2,1,1,sc)}
    </g>
    <g style="animation:sparkleAnim .8s steps(2) infinite .3s;transform-origin:${22*S}px ${4*S}px;">
      ${r(21,1,1,1,sc)}${r(22,0,1,1,sc)}${r(22,2,1,1,sc)}${r(23,1,1,1,sc)}
    </g>
    <g style="animation:sparkleAnim .8s steps(2) infinite .6s;transform-origin:${2*S}px ${14*S}px;">
      ${r(-1,12,1,1,sc)}${r(0,11,1,1,sc)}${r(0,13,1,1,sc)}${r(1,12,1,1,sc)}
    </g>
    <g style="animation:sparkleAnim .8s steps(2) infinite .15s;transform-origin:${21*S}px ${14*S}px;">
      ${r(20,12,1,1,sc)}${r(21,11,1,1,sc)}${r(21,13,1,1,sc)}${r(22,12,1,1,sc)}
    </g>
  ` : '';

  // ── Static cat pixels ─────────────────────────────────────────────

  // Ears (rows 0-2)
  const ears =
    r(3,0,2,1,K) + r(15,0,2,1,K) +        // ear tips outline
    r(3,1,2,2,Br) + r(15,1,2,2,Br) +      // outer ear
    r(4,1,1,1,Pk) + r(15,1,1,1,Pk);       // inner ear pink

  // Head outline (rows 2-9, 14px wide)
  const headOutline =
    r(3,2,14,1,K) +   // top of head
    r(2,3,1,6,K) + r(17,3,1,6,K) +  // sides
    r(2,9,1,1,K) + r(17,9,1,1,K);

  // Head fill (rows 3-8)
  const headFill =
    r(3,3,14,6,Br);   // main head fur

  // Forehead stripe detail
  const forehead =
    r(8,3,1,1,Lb) + r(11,3,1,1,Lb);  // subtle lighter pixels

  // Eyes — state dependent
  let eyes = '';
  if (eating) {
    // ^ crescent happy eyes (3 pixels wide)
    eyes =
      r(5,5,1,1,K) + r(6,4,1,1,K) + r(7,5,1,1,K) +   // left ^
      r(12,5,1,1,K) + r(13,4,1,1,K) + r(14,5,1,1,K);  // right ^
  } else if (hungry) {
    // half-lidded eyes: white box bottom half visible
    eyes =
      // left eye box
      r(5,5,3,2,Wh) + r(5,5,3,1,Br) +  // lid covers top half
      r(5,5,3,2,K) + r(6,5,1,1,Ir) +   // outline + iris
      // right eye box
      r(12,5,3,2,Wh) + r(12,5,3,1,Br) +
      r(12,5,3,2,K) + r(13,5,1,1,Ir) +
      // worried inner brow marks
      r(6,4,1,1,K) + r(13,4,1,1,K);
  } else {
    // idle: open square eyes with iris + blink handled by animation on a group
    eyes =
      // left eye: 3x3 white box with dark outline
      r(4,4,4,1,K) + r(4,5,4,3,K) +  // outline rows
      r(5,5,2,2,Wh) +                 // white fill
      r(5,5,1,1,Ir) + r(6,5,1,1,Pu) +// iris + pupil
      r(6,4,1,1,Wh) +                 // top shine
      // right eye
      r(11,4,4,1,K) + r(11,5,4,3,K) +
      r(12,5,2,2,Wh) +
      r(12,5,1,1,Ir) + r(13,5,1,1,Pu) +
      r(13,4,1,1,Wh);
  }

  // Nose
  const nose = r(9,7,2,1,Pk);

  // Mouth — state dependent
  let mouth = '';
  if (eating) {
    // open O shape
    mouth = r(8,8,1,1,K) + r(9,8,2,1,K) + r(11,8,1,1,K) +
            r(8,9,1,1,K) + r(9,9,2,1,Wh) + r(11,9,1,1,K) +
            r(8,10,1,1,K) + r(9,10,2,1,K) + r(11,10,1,1,K);
  } else if (hungry) {
    // frown
    mouth = r(8,9,1,1,K) + r(9,10,2,1,K) + r(11,9,1,1,K);
  } else {
    // smile
    mouth = r(8,8,1,1,K) + r(9,9,2,1,K) + r(11,8,1,1,K);
  }

  // Whiskers
  const whiskers =
    r(0,6,3,1,Wh) + r(0,7,3,1,Wh) +   // left whiskers
    r(17,6,3,1,Wh) + r(17,7,3,1,Wh);  // right whiskers

  // Blush (eating/happy only)
  const blush = eating
    ? r(3,7,2,1,Rs) + r(15,7,2,1,Rs)
    : '';

  // Head bottom outline (connects to neck)
  const headBottom =
    r(3,9,14,1,K) +  // bottom of head
    r(5,10,10,1,Br); // neck

  // Body (rows 11-20)
  const body =
    r(4,11,12,1,K) +    // shoulder top outline
    r(3,12,1,7,K) + r(16,12,1,7,K) +  // body sides
    r(4,12,12,7,Br) +   // body fur
    r(6,13,8,5,Cr) +    // cream belly
    r(3,19,14,1,K);     // body bottom

  // Front paws (rows 20-22)
  const paws =
    r(4,20,4,2,Br) + r(12,20,4,2,Br) + // paw tops
    r(4,22,4,1,K) + r(12,22,4,1,K) +   // paw bottom outline
    r(5,21,1,1,K) + r(6,21,1,1,K) + r(7,21,1,1,K) +   // left paw toes
    r(13,21,1,1,K) + r(14,21,1,1,K) + r(15,21,1,1,K);  // right paw toes

  // Tail (right side, rows 15-23)
  const tailPixels =
    r(17,15,2,1,Br) + r(18,16,2,1,Br) + r(19,17,2,1,Br) +
    r(19,18,2,1,Br) + r(18,19,2,1,Br) + r(17,20,2,1,Br) +
    r(17,21,3,1,Br) + r(17,22,2,1,Cr); // tip

  const viewW = (24) * S;
  const viewH = (28) * S;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW} ${viewH}" width="${size}" height="${size}"
    style="image-rendering:pixelated;image-rendering:crisp-edges;${glowStyle}">
  ${sparkles}
  <g style="${bodyAnim}">
    <g style="${tailAnim}">${tailPixels}</g>
    ${ears}
    ${headOutline}
    ${headFill}
    ${forehead}
    ${eyes}
    ${nose}
    ${mouth}
    ${whiskers}
    ${blush}
    ${headBottom}
    ${body}
    ${paws}
  </g>
</svg>`;
}

function PetCat({ state, size = 160 }) {
  useEffect(() => { injectPetStyles(); }, []);
  return React.createElement('div', {
    dangerouslySetInnerHTML: { __html: catSVG(state, size) },
    style: { width: size, height: size, display: 'inline-block' }
  });
}

function PetHearts({ calPct }) {
  const filled = calPct <= 0 ? 0 : calPct < 0.25 ? 1 : calPct < 0.5 ? 2 : calPct < 0.75 ? 3 : 4;
  return React.createElement('div', { style: { display: 'flex', gap: 4, marginTop: 6 } },
    [0,1,2,3].map(i =>
      React.createElement('span', {
        key: i,
        style: { fontSize: 18, filter: i < filled ? 'none' : 'grayscale(1) opacity(0.4)' }
      }, '❤️')
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
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', overflow: 'hidden' } },

      // ── Green background layer ──
      React.createElement('div', {
        style: { position: 'absolute', inset: 0, bottom: '44%', backgroundColor: '#22c55e' }
      }),

      // ── Pet name + hearts (top-left) ──
      React.createElement('div', {
        style: { position: 'absolute', top: 48, left: 20, zIndex: 30 }
      },
        React.createElement('div', { style: { color: 'white', fontWeight: 900, fontSize: 28, lineHeight: 1 } }, 'Bagel'),
        React.createElement(PetHearts, { calPct: isToday ? calPct : 0 })
      ),

      // ── Settings gear (top-right) ──
      React.createElement('button', {
        onClick: onOpenSettings,
        style: { position: 'absolute', top: 52, right: 20, zIndex: 30, background: 'none', border: 'none', cursor: 'pointer' }
      }, React.createElement(Icon, { name: 'Settings', size: 22, color: 'white' })),

      // ── Cat (centered, sits at green/white boundary) ──
      React.createElement('div', {
        style: {
          position: 'absolute',
          top: '12%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          pointerEvents: 'none'
        }
      }, React.createElement(PetCat, { state: petState, size: 180 })),

      // ── White scrollable card ──
      React.createElement('div', {
        style: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          top: '44%',
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
    React.createElement('div', { className: 'flex justify-center min-h-screen bg-gray-200' },
      React.createElement('div', { className: 'relative w-full max-w-sm min-h-screen bg-gray-50 flex flex-col overflow-hidden' },

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
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
