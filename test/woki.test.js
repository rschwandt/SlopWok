import test from 'node:test';
import assert from 'node:assert/strict';
import { wokiState, wokiLine, reminderLine, wokiTip, dayScore, widthOf, stageOf } from '../shared/woki-state.js';

const today = '2026-11-27';
const iso = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// 8 Tage (today-7 … today), jeder Tag aus f(age) → {eatP, eatK, eaten}
const days = f => Array.from({ length: 8 }, (_, i) => ({ date: iso(i - 7), eatP: 0, eatK: 0, eaten: 0, ...f(7 - i) }));
const goals = { pGoal: 100, kGoal: 2000, since: '2026-01-01', today };
const good = { eatP: 110, eatK: 2000, eaten: 4 };

test('Tageswertung: nichts abgehakt ist 0, alles im Ziel ist 1', () => {
  assert.equal(dayScore({ eatP: 0, eatK: 0, eaten: 0 }, 100, 2000), 0);
  assert.equal(dayScore(good, 100, 2000), 1);
  assert.ok(dayScore({ eatP: 50, eatK: 1000, eaten: 2 }, 100, 2000) < 0.6);
  assert.equal(widthOf(1), 1);
  assert.ok(widthOf(0.5) < 0.8 && widthOf(1.6) > 1.15);
  assert.deepEqual([0, 19, 20, 59, 60, 80, 100].map(stageOf), [1, 1, 2, 3, 4, 5, 5]);
});

test('Gute Woche: Topform, Form normal, Ziel-Zubehör aus dem Profil', () => {
  const st = wokiState({ ...goals, goal: 'muscle', days: days(age => (age ? good : {})) });
  assert.equal(st.stage, 5);
  assert.equal(st.key, 'top');
  assert.equal(st.shape, null);
  assert.equal(st.goal, 'muscle');
  assert.deepEqual(st.counts, { days: 7, logged: 7, protein: 7, kcal: 7 });
  assert.equal(st.bars.length, 8);
});

test('Nichts eingetragen: Woki ist am Ende', () => {
  const st = wokiState({ ...goals, days: days(() => ({})) });
  assert.equal(st.stage, 1);
  assert.equal(st.key, 'wrecked');
  assert.match(wokiLine(st, 12), /kalt/);
  assert.match(reminderLine(st), /noch nichts eingetragen/);
});

test('Der heutige Tag zählt nur, wenn er die Wertung hebt', () => {
  const base = wokiState({ ...goals, days: days(age => (age ? good : {})) });
  const bad = wokiState({ ...goals, days: days(age => (age ? good : { eatP: 5, eatK: 200, eaten: 1 })) });
  assert.equal(bad.score, base.score);
  const low = wokiState({ ...goals, days: days(age => (age ? {} : good)) });
  const lower = wokiState({ ...goals, days: days(() => ({})) });
  assert.ok(low.score > lower.score);
});

test('Zu wenig gegessen macht Woki dünn, zu viel breit', () => {
  const thin = wokiState({ ...goals, days: days(age => (age ? { eatP: 60, eatK: 1100, eaten: 3 } : {})) });
  assert.equal(thin.shape, 'thin');
  assert.ok(thin.w < 0.9);
  assert.match(wokiLine(thin, 9), /dünn/);
  assert.match(wokiTip(thin), /Kalorienziel/);
  const round = wokiState({ ...goals, days: days(age => (age ? { eatP: 120, eatK: 3200, eaten: 5 } : {})) });
  assert.equal(round.shape, 'round');
  assert.ok(round.w > 1.07);
});

test('Neues Konto: Tage vor der Registrierung zählen neutral, nicht als verpasst', () => {
  const st = wokiState({ ...goals, since: today, days: days(() => ({})) });
  assert.equal(st.stage, 4);
  assert.equal(st.counts.days, 0);
  assert.ok(st.bars.slice(0, 7).every(b => b.score === null));
  assert.match(wokiTip(st), /Nach ein paar Tagen/);
});

test('Erinnerung nur, wenn es etwas zu sagen gibt', () => {
  const done = wokiState({ ...goals, days: days(() => good) });
  assert.equal(reminderLine(done, 5), null);
  assert.match(wokiLine(done, 20), /geschafft/);
  const gap = wokiState({ ...goals, days: days(age => (age ? good : { eatP: 40, eatK: 900, eaten: 2 })) });
  assert.match(reminderLine(gap, 4), /Serie von 4 Tagen reißt heute\. Noch 60 g/);
  assert.match(reminderLine(gap, 0), /Noch 60 g Protein/);
  assert.match(wokiLine(gap, 18), /Noch 60 g Protein/);
});
