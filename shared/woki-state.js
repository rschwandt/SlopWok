// Wokis Verfassung: Woki spiegelt, wie man in den letzten 7 Tagen gegessen hat. Läuft in Browser und Server
// (Server: /api/me und Erinnerungen, Browser: Sprechblase). Ohne Node- und DOM-Abhängigkeiten.

const DAY = 86400000;
const parseD = s => Date.parse(s + 'T00:00:00Z');
const ageOf = (date, today) => Math.round((parseD(today) - parseD(date)) / DAY);

export const WINDOW = 7;      // abgeschlossene Tage, die zählen
const DECAY = 0.85;           // jeder Tag weiter zurück zählt so viel weniger
const TODAY_WEIGHT = 1.15;    // der heutige Tag zählt am meisten, aber nur, wenn er die Wertung hebt
const NEUTRAL = 0.65;         // Tage vor der Registrierung: „gut drauf“, damit neue Konten nicht leiden

// Stufe 1 bis 5, von unten nach oben. min: ab dieser Wertung (0–100)
export const STAGES = [
  null,
  { key: 'wrecked', title: 'Am Ende', min: 0 },
  { key: 'sad', title: 'Schlapp', min: 20 },
  { key: 'meh', title: 'Geht so', min: 40 },
  { key: 'good', title: 'Gut drauf', min: 60 },
  { key: 'top', title: 'In Topform', min: 80 }
];
export const stageOf = score => (score >= 80 ? 5 : score >= 60 ? 4 : score >= 40 ? 3 : score >= 20 ? 2 : 1);

// Kalorien im Rahmen: 85–115 % des Ziels voll, darunter bis 50 % und darüber bis 160 % abfallend
export function kcalFit(r) {
  if (r >= 0.85 && r <= 1.15) return 1;
  return r < 0.85 ? Math.max(0, (r - 0.5) / 0.35) : Math.max(0, (1.6 - r) / 0.45);
}
const kcalOk = r => r >= 0.85 && r <= 1.15;

// Ein Tag, 0 bis 1: eingetragen 20 %, Protein 45 %, Kalorien 35 %. Nichts abgehakt = 0.
export function dayScore(d, pGoal, kGoal) {
  if (!d || !d.eaten) return 0;
  return 0.2 + 0.45 * Math.min(1, d.eatP / pGoal) + 0.35 * kcalFit(d.eatK / kGoal);
}

// Breite des Woks aus dem Kalorienschnitt: schmal bei zu wenig, breit bei zu viel
export function widthOf(r) {
  if (r < 0.85) return Math.max(0.74, 1 - (0.85 - r) * 0.75);
  if (r > 1.15) return Math.min(1.2, 1 + (r - 1.15) * 0.5);
  return 1;
}

/**
 * Wokis Verfassung.
 * @param {{days: {date, eatP, eatK, eaten}[], pGoal: number, kGoal: number, goal?: string, since: string, today: string}} a
 *   days: Fortschritt von today-7 bis today (server/logic.js progress), since: Tag der Registrierung
 */
export function wokiState({ days, pGoal, kGoal, goal = 'keep', since, today }) {
  const byDate = new Map(days.map(d => [d.date, d]));
  const past = [];
  for (let age = WINDOW; age >= 1; age--) {
    const date = new Date(parseD(today) - age * DAY).toISOString().slice(0, 10);
    const d = byDate.get(date) || { date, eatP: 0, eatK: 0, eaten: 0 };
    past.push({ d, age, before: date < since, s: date < since ? NEUTRAL : dayScore(d, pGoal, kGoal) });
  }
  const t = byDate.get(today) || { date: today, eatP: 0, eatK: 0, eaten: 0, planP: 0 };
  const tScore = dayScore(t, pGoal, kGoal);
  let sum = 0, wsum = 0;
  for (const p of past) { const w = DECAY ** (p.age - 1); sum += w * p.s; wsum += w; }
  const without = sum / wsum, withToday = (sum + TODAY_WEIGHT * tScore) / (wsum + TODAY_WEIGHT);
  const score = Math.round(100 * Math.max(without, withToday));
  const stage = stageOf(score);

  // Form: Kalorienschnitt der eingetragenen Tage; heute erst, wenn der Tag schon voll ist
  const counted = past.filter(p => !p.before);
  const ratios = counted.filter(p => p.d.eaten).map(p => p.d.eatK / kGoal);
  if (t.eaten && t.eatK / kGoal >= 0.85) ratios.push(t.eatK / kGoal);
  const ratio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
  const w = Math.round(widthOf(ratio) * 100) / 100;

  return {
    stage, key: STAGES[stage].key, title: STAGES[stage].title, score, w,
    shape: w < 0.93 ? 'thin' : w > 1.07 ? 'round' : null,
    goal: ['lose', 'keep', 'gain', 'muscle'].includes(goal) ? goal : 'keep',
    counts: {
      days: counted.length,
      logged: counted.filter(p => p.d.eaten).length,
      protein: counted.filter(p => p.d.eaten && p.d.eatP >= 0.8 * pGoal).length,
      kcal: counted.filter(p => p.d.eaten && kcalOk(p.d.eatK / kGoal)).length
    },
    bars: [...past.map(p => ({ date: p.d.date, score: p.before ? null : Math.round(100 * p.s) })), { date: today, score: Math.round(100 * tScore), today: true }],
    today: { eatP: Math.round(t.eatP), eatK: Math.round(t.eatK), eaten: t.eaten, planP: Math.round(t.planP || 0) },
    pGoal, kGoal
  };
}

const gapOf = st => Math.max(0, Math.round(st.pGoal - st.today.eatP));
const doneToday = st => st.today.eaten > 0 && st.today.eatP >= st.pGoal && kcalOk(st.today.eatK / st.kGoal);

// Was Woki in der Sprechblase sagt (Ich-Form). hour: Stunde auf dem Gerät.
export function wokiLine(st, hour) {
  const gap = gapOf(st);
  if (!st.today.eaten && hour >= 10)
    return st.stage <= 2 ? 'Heute noch nichts eingetragen. Mir ist ganz kalt.'
      : hour < 14 ? 'Heute noch nichts abgehakt. Was gab es zum Frühstück?' : 'Schon ' + hour + ' Uhr und noch nichts eingetragen. Ich hab Hunger!';
  if (doneToday(st)) return st.stage >= 4 ? 'Ziel für heute geschafft! Ich bin stolz auf uns.' : 'Ziel für heute geschafft! So geht es mir gleich besser.';
  if (st.today.eaten && hour >= 17 && gap >= 0.15 * st.pGoal) return 'Noch ' + gap + ' g Protein bis zum Ziel. Wie wär’s mit Tofu?';
  if (st.shape === 'thin') return 'Ich werde ganz dünn. Du isst seit Tagen zu wenig.';
  if (st.shape === 'round') return 'Mir spannt der Henkel. In letzter Zeit war es etwas viel.';
  return [null,
    'Ich hab angefangen zu rauchen. Hilf mir da raus und iss heute nach Plan.',
    'Mir geht es nicht so gut. Hak heute alles ab, was du isst, das hilft mir.',
    'Geht so. Ein paar gute Tage und ich bin wieder fit.',
    'Läuft gut bei uns. Weiter so!',
    'Ich fühl mich stark! So kann es bleiben.'][st.stage];
}

// Was Woki am meisten helfen würde (im Blatt): der schwächste der drei Teile
export function wokiTip(st) {
  const c = st.counts;
  if (!c.days) return 'Hak ab, was du isst. Nach ein paar Tagen zeigt Woki, wie es läuft.';
  if (c.logged < c.days * 0.7) return 'Hak jeden Tag ab, was du gegessen hast, auch Snacks und Auswärtsessen. Tage ohne Eintrag ziehen Woki am meisten runter.';
  if (st.shape === 'thin') return 'Du bleibst oft unter deinem Kalorienziel. Plane größere Portionen oder ein Extra ein.';
  if (st.shape === 'round') return 'Du liegst oft über deinem Kalorienziel. Kleinere Portionen oder weniger Extras helfen Woki.';
  if (c.protein <= c.kcal) return 'Mehr Protein hilft Woki am meisten: Tofu, Seitan, Linsen oder ein Proteinshake als Extra.';
  if (c.kcal < c.days) return 'Bleib näher an deinem Kalorienziel, dann ist Woki bald in Topform.';
  return 'Alles im grünen Bereich. Bleib dran!';
}

// Erinnerung per Push: nur, wenn es etwas zu sagen gibt, sonst null
export function reminderLine(st, streak = 0) {
  const gap = gapOf(st);
  if (!st.today.eaten) return st.stage <= 2 ? 'Mir ist kalt, heute ist noch nichts eingetragen. Hast du gegessen?' : 'Heute ist noch nichts eingetragen. Was hast du gegessen?';
  if (streak > 0 && st.today.eatP < 0.8 * st.pGoal) return 'Deine Serie von ' + streak + (streak === 1 ? ' Tag' : ' Tagen') + ' reißt heute. Noch ' + gap + ' g Protein!';
  if (gap >= 0.25 * st.pGoal) return 'Noch ' + gap + ' g Protein bis zum Ziel. Ich hab Hunger auf Tofu.';
  return null;
}
