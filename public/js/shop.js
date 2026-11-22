// Ansicht „Einkauf": Einkaufsliste je Einkaufstag, wer einkauft, und die gemeinsame Kasse.
import { S, get, post, patch, del, esc, ico, head, chip, avatar, settingsBtn, members, solo, toast, euro, fmtQ, fmtNice,
  todayISO, wdOf, WD, WDL, dateLabel, diffDays } from './core.js';
import { CATEGORIES } from '/shared/dish.js';

let tab = 'list', cursor = null, list = null, money = null, split = null, payer = null, confirmDel = 0;
const myId = () => S.me.user.id;
const nameOf = id => {
  const m = members().find(x => x.id === id) || (money && money.formerMembers.find(x => x.id === id));
  return m ? (m.id === myId() ? 'Du' : m.display) : 'Jemand';
};

async function load() {
  if (tab === 'money') money = await get('/api/money');
  else list = await get('/api/shopping?date=' + (cursor || todayISO()));
}
function enter() { cursor = null; confirmDel = 0; }

const tabs = () => '<div class="seg-tabs"><button data-act="tab" data-v="list" aria-pressed="' + (tab === 'list') + '">Liste</button><button data-act="tab" data-v="money" aria-pressed="' + (tab === 'money') + '">Kasse</button></div>';

function buyRow(act, attrs, on, name, why, qty) {
  return '<button class="buy' + (on ? ' got' : '') + '" data-act="' + act + '" ' + attrs + ' role="checkbox" aria-checked="' + on + '"><span class="check" aria-hidden="true">' + ico.tick + '</span>' +
    '<div><span class="nm">' + esc(name) + '</span>' + (why ? '<span class="why">' + why + '</span>' : '') + '</div><span class="qty">' + qty + '</span></button>';
}
function renderList() {
  if (!list) return head('Einkauf', 'Einkaufsliste', settingsBtn()) + tabs();
  const L = list, days = diffDays(L.from, L.to) + 1, today = todayISO(), current = L.from <= today && today <= L.to;
  let h = head('Einkauf am', WDL[wdOf(L.from)] + ',<br>' + dateLabel(L.from),
    '<button class="iconbtn" data-act="trip" data-d="' + L.prev + '" aria-label="Vorheriger Einkauf">' + ico.prev + '</button>' + chip('Aktuell', current, 'data-act="trip" data-d=""') +
    '<button class="iconbtn" data-act="trip" data-d="' + L.next + '" aria-label="Nächster Einkauf">' + ico.next + '</button>' + settingsBtn());
  h += tabs();
  const span = days > 1 ? 'Reicht für ' + WD[wdOf(L.from)] + '–' + WD[wdOf(L.to)] + ' (' + days + ' Tage)' : 'Reicht für diesen Tag';

  // Wer kauft ein
  if (L.doneAt) {
    h += '<div class="card"><div class="split"><h2>Erledigt</h2>' + (L.expense ? '<span class="amount">' + euro(L.expense.cents) + '</span>' : '') + '</div>' +
      '<p class="note">' + esc(nameOf(L.shopperId)) + (L.shopperId === myId() ? ' hast' : ' hat') + ' eingekauft.' + (L.expense && !solo() ? ' Der Betrag steht in der Kasse.' : '') + '</p>' +
      '<div class="actions"><button class="linkbtn" data-act="reopen">Wieder öffnen</button></div></div>';
  } else if (!solo()) {
    const sug = L.suggestion && !L.shopperId ? '<p class="note">' + (L.suggestion === myId() ? '<b>Du</b> wärst dran – du warst' : 'Dran wäre <b>' + esc(nameOf(L.suggestion)) + '</b> – war') + ' zuletzt am seltensten einkaufen.</p>' : '';
    h += '<div class="card"><div class="split"><h2>Wer kauft ein?</h2><span class="note">' + span + '</span></div>' + sug +
      '<div class="chips">' + members().map(m => chip(esc(m.id === myId() ? 'Ich' : m.display), L.shopperId === m.id, 'data-act="shopper" data-id="' + m.id + '"')).join('') + '</div></div>';
  }

  // Liste
  const stores = [...new Set(L.items.map(i => i.store))].sort((a, b) => (a !== '') - (b !== '') || a.localeCompare(b, 'de'));
  if (!L.items.length && !L.manual.length) {
    h += '<div class="card"><h2>Nichts zu kaufen</h2><p class="note">' + (L.mealCount ? 'Für diese Tage sind nur Reste geplant.' : 'Für ' + (days > 1 ? 'diese Tage' : 'diesen Tag') + ' ist noch nichts geplant. Sobald Mahlzeiten im Plan stehen, erscheint hier die Liste.') + '</p></div>';
  }
  for (const store of stores) {
    const items = L.items.filter(i => i.store === store);
    h += '<div class="card"><div class="split"><h2>' + esc(store || (stores.length > 1 ? 'Supermarkt' : 'Einkaufsliste')) + '</h2><span class="muted num">' + items.filter(i => i.got).length + ' / ' + items.length + '</span></div>';
    if (store === stores[0] && solo()) h += '<p class="note">' + span + '. Mengen sind auf alle Esser und Reste fürs Mittag hochgerechnet.</p>';
    for (const [c, cname] of CATEGORIES) {
      const rows = items.filter(i => i.category === c);
      if (!rows.length) continue;
      h += '<div class="aisle"><h3>' + cname + '</h3>';
      for (const it of rows) {
        const qty = it.packs ? it.packs + '×<small>' + (it.pack.label ? esc(it.pack.label) : fmtQ(it.pack.size, it.unit)) + '</small>' : fmtNice(it.need, it.unit);
        const why = (it.packs ? 'brauchst ' + fmtNice(it.need, it.unit) + ' · ' : '') + esc(it.why.slice(0, 3).join(', ')) + (it.why.length > 3 ? ' …' : '');
        h += buyRow('check', 'data-key="' + esc(it.key) + '"', it.got, it.name, why, qty);
      }
      h += '</div>';
    }
    h += '</div>';
  }
  h += '<div class="card"><h2>Außerdem</h2><div class="rows">' + L.manual.map(m =>
    '<div class="row' + (m.got ? ' got' : '') + '"><button class="check" role="checkbox" aria-checked="' + m.got + '" aria-label="' + esc(m.text) + ' gekauft" data-act="manual" data-id="' + m.id + '">' + ico.tick + '</button>' +
    '<span class="grow"><span class="nm">' + esc(m.text) + '</span></span><button class="addbtn x" data-act="delManual" data-id="' + m.id + '" aria-label="' + esc(m.text) + ' entfernen">' + ico.close + '</button></div>').join('') + '</div>' +
    '<form class="inline" data-form="item"><input class="input" name="text" maxlength="80" required placeholder="z. B. Spülmittel" aria-label="Weiteren Artikel hinzufügen"><button class="btn" aria-label="Hinzufügen">' + ico.plus + '</button></form></div>';

  if (L.basics.length) {
    const onList = new Set(L.manual.map(m => m.text));
    h += '<div class="card"><h2>Vorrat prüfen</h2><p class="note">Gewürze, Öl und Soßen für diese Tage. Fehlt etwas, setz es mit <b>+</b> auf die Liste.</p><div class="rows">' +
      L.basics.map(b => '<div class="row"><span class="grow"><span class="nm">' + esc(b.name) + '</span><span class="why">' + esc(['für ' + b.why.slice(0, 2).join(', ') + (b.why.length > 2 ? ' u. a.' : ''), b.info, b.store].filter(Boolean).join(' · ')) + '</span></span>' +
        (onList.has(b.name) ? '<span class="pill">auf der Liste</span>' : '<button class="addbtn" data-act="basic" data-n="' + esc(b.name) + '" aria-label="' + esc(b.name) + ' auf die Einkaufsliste">' + ico.plus + '</button>') + '</div>').join('') + '</div></div>';
  }

  if (!L.doneAt && (L.items.length || L.manual.length)) {
    const mode = split || S.me.household.settings.split;
    h += '<form class="card" data-form="done"><h2>Einkauf abschließen</h2>' +
      '<div class="field"><label for="d-amount">Was hat es gekostet? (€)</label><input id="d-amount" name="amount" inputmode="decimal" placeholder="' + (solo() ? 'optional' : '0,00') + '" autocomplete="off"' + (solo() ? '' : ' required') + '></div>' +
      (solo() ? '' : '<div class="field"><span class="lbl">Aufteilen</span><div class="chips">' + chip('Gleichmäßig', mode === 'equal', 'data-act="split" data-v="equal"') + chip('Nach Verbrauch', mode === 'usage', 'data-act="split" data-v="usage"') + '</div>' +
        '<span class="note">' + (mode === 'usage' ? 'Wer in diesen Tagen mehr mitisst, trägt mehr – gerechnet nach geplanten Kalorien.' : 'Alle im Haushalt zahlen gleich viel.') + ' ' + (L.shopperId && L.shopperId !== myId() ? esc(nameOf(L.shopperId)) + ' hat bezahlt.' : 'Du hast bezahlt.') + '</span></div>') +
      '<button class="btn wide">' + ico.tick + 'Erledigt</button></form>';
  }
  return h;
}

function renderMoney() {
  let h = head('Einkauf', 'Kasse', settingsBtn()) + tabs();
  if (!money) return h;
  const M = money;
  if (solo() && !M.formerMembers.length) {
    h += '<div class="card"><div class="split"><h2>Letzte 30 Tage</h2><span class="amount">' + euro(M.total) + '</span></div><p class="note">Du bist allein in deinem Haushalt. Sobald jemand beitritt (unter <b>Leute</b>), seht ihr hier, wer wie viel ausgelegt hat und wer wem etwas schuldet.</p></div>';
  } else {
    h += '<div class="card"><div class="split"><h2>Stand</h2><span class="note">' + euro(M.total) + ' in 30 Tagen</span></div><div class="rows">' +
      Object.keys(M.balances).map(Number).map(id => {
        const c = M.balances[id], u = members().find(m => m.id === id) || M.formerMembers.find(m => m.id === id) || {};
        return '<div class="row">' + avatar(u) + '<span class="grow"><span class="nm">' + esc(nameOf(id)) + '</span><span class="why">' +
          (id in M.trips ? M.trips[id] + '× eingekauft in 8 Wochen' : 'nicht mehr im Haushalt') + '</span></span>' +
          '<span class="amount ' + (c > 0 ? 'pos' : c < 0 ? 'neg' : '') + '">' + (c > 0 ? '+' : '') + euro(c) + '</span></div>';
      }).join('') + '</div><p class="note">Plus heißt: hat mehr ausgelegt als verbraucht und bekommt Geld zurück.</p></div>';
    h += '<div class="card"><h2>Ausgleichen</h2>' + (M.transfers.length ? '<div class="rows">' + M.transfers.map(t =>
      '<div class="row"><span class="grow"><span class="nm">' + esc(nameOf(t.from)) + ' → ' + esc(nameOf(t.to)) + '</span><span class="why">' + (t.from === myId() ? 'Du schuldest' : esc(nameOf(t.from)) + ' schuldet') + ' ' + euro(t.cents) + '</span></span>' +
      '<button class="linkbtn" data-act="paid" data-from="' + t.from + '" data-to="' + t.to + '" data-c="' + t.cents + '">' + ico.tick + 'Bezahlt</button></div>').join('') + '</div>'
      : '<p class="note">Alles ausgeglichen. Niemand schuldet jemandem etwas.</p>') + '</div>';
  }
  const mode = split || S.me.household.settings.split, who = payer || myId();
  h += '<form class="card" data-form="expense"><h2>Ausgabe eintragen</h2><div class="row2"><div class="field"><label for="e-amount">Betrag (€)</label><input id="e-amount" name="amount" inputmode="decimal" required placeholder="0,00" autocomplete="off"></div>' +
    '<div class="field"><label for="e-note">Wofür?</label><input id="e-note" name="note" maxlength="80" placeholder="z. B. Wochenmarkt"></div></div>' +
    (solo() ? '' : '<div class="field"><span class="lbl">Bezahlt von</span><div class="chips">' + members().map(m => chip(esc(m.id === myId() ? 'Mir' : m.display), who === m.id, 'data-act="payer" data-id="' + m.id + '"')).join('') + '</div></div>' +
      '<div class="field"><span class="lbl">Aufteilen</span><div class="chips">' + chip('Gleichmäßig', mode === 'equal', 'data-act="split" data-v="equal"') + chip('Nach Verbrauch', mode === 'usage', 'data-act="split" data-v="usage"') + '</div></div>') +
    '<button class="btn wide">Eintragen</button></form>';
  if (M.expenses.length) {
    h += '<div class="card"><h2>Verlauf</h2><div class="rows">' + M.expenses.map(e => {
      const d = e.date.split('-');
      const sub = e.kind === 'transfer' ? 'an ' + esc(nameOf(+Object.keys(e.shares)[0])) : (e.split === 'usage' ? 'nach Verbrauch' : 'gleichmäßig') + (solo() ? '' : ' · dein Anteil ' + euro(e.shares[myId()] || 0));
      return '<div class="row"><span class="grow"><span class="nm">' + esc(e.note) + ' · ' + esc(nameOf(e.payerId)) + '</span><span class="why">' + d[2] + '.' + d[1] + '. · ' + sub + '</span></span><span class="amount">' + euro(e.cents) + '</span>' +
        (confirmDel === e.id ? '<button class="linkbtn danger" data-act="delExpenseYes" data-id="' + e.id + '">Löschen</button>' : '<button class="addbtn x" data-act="delExpense" data-id="' + e.id + '" aria-label="Eintrag löschen">' + ico.trash + '</button>') + '</div>';
    }).join('') + '</div></div>';
  }
  return h;
}
const render = () => (tab === 'money' ? renderMoney() : renderList());

const actions = {
  tab: el => { tab = el.dataset.v; confirmDel = 0; S.render(); S.refresh(); },
  trip: el => { cursor = el.dataset.d || null; S.refresh(); },
  shopper: async el => { const id = +el.dataset.id; list = await post('/api/shopping/' + list.from + '/shopper', { userId: list.shopperId === id ? null : id }); S.render(); },
  check: async el => {
    const it = list.items.find(i => i.key === el.dataset.key);
    it.got = !it.got; S.render();
    try { await post('/api/shopping/' + list.from + '/check', { key: it.key, on: it.got }); } catch (e) { it.got = !it.got; S.render(); throw e; }
  },
  manual: async el => { const m = list.manual.find(x => x.id === +el.dataset.id); m.got = !m.got; S.render(); await patch('/api/shopping/items/' + m.id, { got: m.got }); },
  delManual: async el => { list = await del('/api/shopping/items/' + el.dataset.id); S.render(); },
  basic: async el => { list = await post('/api/shopping/' + list.from + '/items', { text: el.dataset.n }); S.render(); },
  split: el => { split = el.dataset.v; S.render(); },
  payer: el => { payer = +el.dataset.id; S.render(); },
  reopen: async () => { list = await post('/api/shopping/' + list.from + '/reopen'); S.render(); },
  paid: async el => { await post('/api/transfers', { fromId: +el.dataset.from, toId: +el.dataset.to, amount: +el.dataset.c / 100 }); toast('Ausgleich eingetragen'); await S.refresh(); },
  delExpense: el => { confirmDel = +el.dataset.id; S.render(); },
  delExpenseYes: async el => { await del('/api/expenses/' + el.dataset.id); confirmDel = 0; await S.refresh(); }
};
const submit = {
  item: async data => { list = await post('/api/shopping/' + list.from + '/items', { text: data.text }); S.render(); },
  done: async data => {
    list = await post('/api/shopping/' + list.from + '/done', { amount: data.amount, split: split || S.me.household.settings.split });
    toast('Einkauf erledigt'); S.render(); window.scrollTo(0, 0);
  },
  expense: async data => {
    await post('/api/expenses', { amount: data.amount, note: data.note, payerId: payer || myId(), split: split || S.me.household.settings.split });
    toast('Eingetragen'); await S.refresh();
  }
};
export default { load, render, actions, submit, enter };
