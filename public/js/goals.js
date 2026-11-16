// Zielrechner: aus Körperdaten, Aktivität und Ziel werden Mindestwerte für Kalorien und Protein pro Tag.
import { S, patch, esc, nf, chip, toast, openSheet, closeSheet, drawSheet } from './core.js';

export const GOALS = [
  ['lose', 'Abnehmen', 'Etwa 20 % unter dem Bedarf, viel Protein, damit Muskeln bleiben.'],
  ['keep', 'Gewicht halten', 'So viel, wie du verbrauchst.'],
  ['gain', 'Zunehmen', 'Etwa 10 % über dem Bedarf.'],
  ['muscle', 'Muskelaufbau', 'Leichter Überschuss und besonders viel Protein. Wirkt nur mit Krafttraining.']
];
const ACTIVITY = [
  [1, 'Wenig', 'Sitzende Arbeit, kaum Sport', 1.2],
  [2, 'Leicht', '1–2× Sport pro Woche oder viel zu Fuß', 1.4],
  [3, 'Mittel', '3–4× Sport pro Woche', 1.55],
  [4, 'Viel', 'Fast täglich Sport oder körperliche Arbeit', 1.75]
];
const KCAL = { lose: 0.8, keep: 1, gain: 1.1, muscle: 1.1 };
const PROTEIN = { lose: 2.0, keep: 1.4, gain: 1.6, muscle: 2.0 }; // Gramm je kg Körpergewicht

// Grundumsatz nach Mifflin-St Jeor, Gesamtbedarf über den Aktivitätsfaktor.
export function calcGoals(p) {
  const w = +p.weight, h = +p.height, a = +p.age;
  if (!(w >= 30 && w <= 300 && h >= 120 && h <= 230 && a >= 14 && a <= 99)) return null;
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'm' ? 5 : p.sex === 'f' ? -161 : -78);
  const need = bmr * (ACTIVITY.find(x => x[0] === +p.activity) || ACTIVITY[1])[3];
  // Beim Abnehmen nie unter den Grundumsatz
  const kcal = Math.max(p.goal === 'lose' ? bmr : 0, need * KCAL[p.goal]);
  // Protein bezogen auf das Gewicht, bei hohem Gewicht höchstens auf BMI 27 gerechnet
  const ref = Math.min(w, 27 * (h / 100) ** 2);
  return { bmr: Math.round(bmr), need: Math.round(need / 50) * 50, kGoal: Math.round(kcal / 50) * 50, pGoal: Math.round(ref * PROTEIN[p.goal] / 5) * 5 };
}

export function openGoalSheet({ intro, onDone } = {}) {
  const st = { weight: '', height: '', age: '', sex: 'x', activity: 2, goal: 'keep', ...(S.me.user.settings.profile || {}) };
  const field = (key, label, unit, attrs) => '<div class="field"><label for="g-' + key + '">' + label + '</label><input id="g-' + key + '" data-input="' + key + '" inputmode="decimal" value="' + esc(st[key]) + '" placeholder="' + unit + '" ' + attrs + '></div>';
  const result = () => {
    const r = calcGoals(st);
    if (!r) return '<p class="note">Trag Gewicht, Größe und Alter ein, dann siehst du hier deine Werte.</p>';
    return '<div class="meters"><div class="meter kcal"><span class="eyebrow">Kalorien</span><div class="big num">' + nf(r.kGoal) + ' <small>kcal</small></div><div class="sub">Dein Bedarf liegt bei etwa ' + nf(r.need) + '</div></div>' +
      '<div class="meter"><span class="eyebrow">Protein</span><div class="big num">' + r.pGoal + ' <small>g</small></div><div class="sub">mindestens, pro Tag</div></div></div>' +
      (+st.age < 18 ? '<div class="hint amber"><span>Unter 18 passen diese Formeln nur grob. Sprich größere Änderungen bitte mit Ärztin oder Arzt ab.</span></div>' : '');
  };
  openSheet({
    title: 'Deine Tagesziele',
    render: () => (intro ? '<p>' + intro + '</p>' : '') +
      '<div class="row3">' + field('weight', 'Gewicht', 'kg', '') + field('height', 'Größe', 'cm', '') + field('age', 'Alter', 'Jahre', '') + '</div>' +
      '<div class="field"><span class="lbl">Für die Formel rechnen als</span><div class="chips">' + [['f', 'Frau'], ['m', 'Mann'], ['x', 'Mittelwert']].map(([v, l]) => chip(l, st.sex === v, 'data-act="sex" data-v="' + v + '"')).join('') + '</div></div>' +
      '<div class="field"><span class="lbl">Wie aktiv bist du?</span><div class="seg">' + ACTIVITY.map(([v, t, d]) => '<button data-act="activity" data-v="' + v + '" aria-pressed="' + (+st.activity === v) + '"><b>' + t + '</b><small>' + d + '</small></button>').join('') + '</div></div>' +
      '<div class="field"><span class="lbl">Was willst du erreichen?</span><div class="seg">' + GOALS.map(([v, t, d]) => '<button data-act="goal" data-v="' + v + '" aria-pressed="' + (st.goal === v) + '"><b>' + t + '</b><small>' + d + '</small></button>').join('') + '</div></div>' +
      '<div id="g-result" class="stack">' + result() + '</div>' +
      '<p class="note">Richtwerte aus gängigen Formeln, kein medizinischer Rat. In Schwangerschaft, Stillzeit oder bei Erkrankungen bitte fachlich beraten lassen. Deine Körperdaten sieht außer dir niemand; du kannst die Ziele danach frei anpassen.</p>' +
      '<button class="btn wide" data-act="apply">Als Ziele übernehmen</button>' +
      (onDone ? '<div class="actions"><button class="linkbtn" data-act="skip">Überspringen</button></div>' : ''),
    onInput: el => { st[el.dataset.input] = el.value.replace(',', '.'); document.getElementById('g-result').innerHTML = result(); },
    actions: {
      sex: el => { st.sex = el.dataset.v; drawSheet(); },
      activity: el => { st.activity = +el.dataset.v; drawSheet(); },
      goal: el => { st.goal = el.dataset.v; drawSheet(); },
      skip: () => { closeSheet(); onDone(); },
      apply: async () => {
        const r = calcGoals(st);
        if (!r) return toast('Bitte Gewicht, Größe und Alter eintragen.', true);
        S.me = await patch('/api/me', { settings: { pGoal: r.pGoal, kGoal: r.kGoal, profile: { weight: +st.weight, height: +st.height, age: +st.age, sex: st.sex, activity: st.activity, goal: st.goal } } });
        closeSheet(); toast('Ziele gesetzt: ' + r.pGoal + ' g Protein, ' + nf(r.kGoal) + ' kcal'); S.render();
        if (onDone) onDone();
      }
    }
  });
}

// Wahl zwischen Vorschlägen und selbst planen (beim ersten Start; später in den Einstellungen).
export function openModeSheet() {
  const set = async mode => { S.me = await patch('/api/me', { settings: { mode } }); closeSheet(); await S.refresh(); };
  openSheet({
    title: 'Wie möchtest du planen?',
    render: () => '<div class="seg"><button data-act="auto"><b>Vorschläge bekommen</b><small>Die App füllt deine Tage mit Gerichten aus dem Fundus, passend zu deinem Proteinziel. Was dir nicht passt, tauschst du mit einem Tipp.</small></button>' +
      '<button data-act="manual"><b>Selbst planen</b><small>Du suchst dir jede Mahlzeit selbst aus oder trägst einen fertigen Monatsplan ein.</small></button></div>' +
      '<p class="note">Das lässt sich jederzeit in den Einstellungen umstellen.</p>',
    actions: { auto: () => set('auto'), manual: () => set('manual') }
  });
}
