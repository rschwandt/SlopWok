// Ansicht „Leute": Fortschritt im Haushalt und von Leuten, denen man folgt, Anstupsen, Nachrichten, Haushalt verwalten.
import { S, get, post, patch, del, esc, ico, nf, head, avatar, settingsBtn, toast, copyText, ago, loadDishes, WD, wdOf, dateLabel, openSheet, closeSheet, drawSheet } from './core.js';

let data = null, results = null, query = '';

async function load() {
  data = await get('/api/people');
  if (data.notifications.some(n => !n.read)) { post('/api/notifications/read').catch(() => {}); S.me.unread = 0; }
}

function personCard(p) {
  let h = '<article class="card person"><div class="person-top">' + avatar(p, 'big') + '<div><span class="nm">' + esc(p.display) + (p.self ? ' <span class="muted">(du)</span>' : '') + '</span>' +
    '<span class="why muted">@' + esc(p.name) + '</span></div>' + (p.visible && p.streak ? '<span class="streak" title="Tage in Folge mit mindestens 80 % des Proteinziels">' + ico.flame + p.streak + (p.streak === 1 ? ' Tag' : ' Tage') + '</span>' : '') + '</div>';
  if (!p.visible) return h + '<p class="note">Teilt den eigenen Fortschritt nicht.</p></article>';
  const t = p.today, pct = Math.min(100, t.eatP / p.pGoal * 100);
  h += '<div><div class="split"><span><b class="num">' + nf(t.eatP) + '</b> <span class="muted">/ ' + p.pGoal + ' g Protein heute</span></span><span class="muted num">' + t.eaten + ' / ' + t.meals + ' Mahlzeiten</span></div>' +
    '<div class="bar" role="img" aria-label="' + Math.round(pct) + ' Prozent des Proteinziels"><i class="eaten" style="width:' + pct.toFixed(1) + '%"></i></div></div>';
  h += '<div class="dots">' + p.week.map(d => '<span class="dot-day' + (d.hit ? ' hit' : '') + '" title="' + dateLabel(d.date) + ': ' + Math.round(d.pct * 100) + ' %"><i style="--p:' + Math.round(d.pct * 100) + '"></i>' + WD[wdOf(d.date)] + '</span>').join('') + '</div>';
  const acts = [];
  if (!p.self) {
    if (p.canNudge) acts.push(p.nudgeWait > 0 ? '<button class="linkbtn" disabled>' + ico.hand + 'Angestupst</button>' : '<button class="linkbtn" data-act="nudge" data-id="' + p.id + '">' + ico.hand + 'Anstupsen</button>');
    else acts.push('<span class="note">Möchte nicht angestupst werden.</span>');
    if (!p.sameHousehold) acts.push('<button class="linkbtn" data-act="unfollow" data-id="' + p.id + '">Nicht mehr folgen</button>');
  }
  acts.push('<button class="linkbtn" data-act="history" data-id="' + p.id + '">Verlauf</button>');
  return h + '<div class="actions">' + acts.join('') + '</div></article>';
}

function render() {
  const hh = S.me.household;
  let h = head(hh.members.length > 1 ? hh.members.length + ' im Haushalt' : 'Gemeinsam dranbleiben', 'Leute', settingsBtn());
  if (!data) return h;
  if (data.notifications.length) {
    h += '<div class="card"><h2>Neuigkeiten</h2><div>' + data.notifications.slice(0, 6).map(n =>
      '<div class="notif' + (n.read ? '' : ' unread') + '"><span>' + esc(n.text) + '</span><time>' + ago(n.created) + '</time></div>').join('') + '</div></div>';
  }
  h += '<div class="split"><h2>' + esc(hh.name) + '</h2></div>' + data.household.map(personCard).join('');
  if (hh.members.length < 2) h += '<div class="hint">' + ico.info + '<span>Du bist noch allein. Schick den Einladungslink unten an deine Mitbewohner – dann plant, kocht und kauft ihr gemeinsam.</span></div>';

  h += '<div class="split"><h2>Freunde</h2></div>' + (data.friends.length ? data.friends.map(personCard).join('') : '<p class="note">Folge anderen, die ihren Fortschritt für alle freigegeben haben, und stupst euch gegenseitig an.</p>');
  h += '<div class="card"><form class="inline" data-form="search"><input class="input" name="q" minlength="2" maxlength="24" required placeholder="Benutzername suchen" value="' + esc(query) + '" autocapitalize="none" aria-label="Benutzername suchen"><button class="btn">Suchen</button></form>' +
    (results ? (results.length ? '<div class="rows">' + results.map(u => '<div class="row">' + avatar(u) + '<span class="grow"><span class="nm">' + esc(u.display) + '</span><span class="why">@' + esc(u.name) + '</span></span>' +
      (u.followed ? '<span class="pill">folgst du</span>' : '<button class="linkbtn" data-act="follow" data-id="' + u.id + '">Folgen</button>') + '</div>').join('') + '</div>'
      : '<p class="note">Niemand gefunden. Zu sehen ist nur, wer in den Einstellungen „Alle“ gewählt hat.</p>') : '') + '</div>';

  const link = location.origin + '/#join=' + hh.invite;
  h += '<div class="card"><h2>Haushalt</h2><form class="inline" data-form="hhName"><input class="input" name="name" maxlength="60" required value="' + esc(hh.name) + '" aria-label="Name des Haushalts"><button class="linkbtn">Umbenennen</button></form>' +
    '<div class="field"><span class="lbl">Einladungscode</span><div class="actions"><span class="code">' + esc(hh.invite) + '</span><button class="linkbtn" data-act="copyInvite" data-link="' + esc(link) + '">' + ico.copy + 'Link kopieren</button>' +
    (navigator.share ? '<button class="linkbtn" data-act="shareInvite" data-link="' + esc(link) + '">Teilen</button>' : '') + '</div>' +
    '<span class="note">Wer den Code kennt, kann beitreten und sieht Plan, Einkauf und Kasse. <button class="linkbtn" data-act="newInvite" style="margin-top:6px">Neuen Code erzeugen</button></span></div>' +
    '<form class="field" data-form="join"><label for="j-code">Einem anderen Haushalt beitreten</label><div class="inline"><input class="input" id="j-code" name="code" maxlength="16" required placeholder="Code" autocapitalize="characters" autocomplete="off"><button class="linkbtn">Beitreten</button></div></form>' +
    (hh.members.length > 1 ? '<div class="actions"><button class="linkbtn danger" data-act="leave">Haushalt verlassen</button></div>' : '') + '</div>';
  return h;
}

async function openHistory(id) {
  const r = await get('/api/progress/' + id + '?days=28');
  const hits = r.days.filter(d => d.hit).length;
  openSheet({
    title: 'Verlauf: ' + r.user.display,
    render: () => '<div class="meters"><div class="meter"><span class="eyebrow">In Folge</span><div class="big num">' + r.streak + ' <small>' + (r.streak === 1 ? 'Tag' : 'Tage') + '</small></div></div>' +
      '<div class="meter"><span class="eyebrow">4 Wochen</span><div class="big num">' + hits + ' <small>/ 28 Tage geschafft</small></div></div></div>' +
      '<div class="card"><span class="note">Geschafft heißt: mindestens 80 % von ' + r.pGoal + ' g Protein gegessen und abgehakt.</span>' +
      [0, 1, 2, 3].map(w => '<div class="dots">' + r.days.slice(w * 7, w * 7 + 7).map(d => '<span class="dot-day' + (d.hit ? ' hit' : '') + '"><i style="--p:' + Math.round(Math.min(1, d.eatP / r.pGoal) * 100) + '"></i>' + new Date(d.date + 'T00:00:00Z').getUTCDate() + '.</span>').join('') + '</div>').join('') + '</div>' +
      '<div class="card"><div class="rows">' + r.days.slice(-7).reverse().map(d => '<div class="row"><span class="grow"><span class="nm">' + WD[wdOf(d.date)] + ', ' + dateLabel(d.date) + '</span><span class="why">' + d.eaten + ' von ' + d.meals + ' Mahlzeiten</span></span>' +
        '<span class="pill">' + nf(d.eatP) + ' g</span><span class="pill k">' + nf(d.eatK) + ' kcal</span></div>').join('') + '</div></div>'
  });
}

const actions = {
  nudge: async el => { await post('/api/nudge', { userId: +el.dataset.id }); toast('Angestupst'); await S.refresh(); },
  history: el => openHistory(+el.dataset.id),
  follow: async el => { await post('/api/follows', { userId: +el.dataset.id }); results = null; query = ''; await S.refresh(); },
  unfollow: async el => { await del('/api/follows/' + el.dataset.id); await S.refresh(); },
  copyInvite: el => copyText(el.dataset.link, 'Einladungslink kopiert'),
  shareInvite: el => navigator.share({ title: 'Kochrunde', text: 'Komm in unseren Haushalt bei Kochrunde:', url: el.dataset.link }).catch(() => {}),
  newInvite: async () => { S.me = await post('/api/household/invite'); toast('Neuer Code. Der alte gilt nicht mehr.'); S.render(); },
  leave: () => {
    openSheet({
      title: 'Haushalt verlassen?',
      render: () => '<p>Du planst danach wieder allein. Aus künftigen gemeinsamen Mahlzeiten wirst du ausgetragen. Offene Beträge in der Kasse bleiben für die anderen sichtbar.</p>' +
        '<div class="actions"><button class="linkbtn danger" data-act="yes">Ja, verlassen</button><button class="linkbtn" data-act="closeSheet">Abbrechen</button></div>',
      actions: { yes: async () => { S.me = await post('/api/household/leave'); closeSheet(); await loadDishes(); await S.refresh(); } }
    });
  }
};
const submit = {
  search: async d => { query = d.q; results = (await get('/api/users/search?q=' + encodeURIComponent(d.q))).users; S.render(); },
  hhName: async d => { S.me = await patch('/api/household', { name: d.name }); toast('Umbenannt'); S.render(); },
  join: async d => { S.me = await post('/api/household/join', { code: d.code }); await loadDishes(); toast('Willkommen im Haushalt „' + S.me.household.name + '“'); await S.refresh(); }
};
export default { load, render, actions, submit, enter: () => { results = null; query = ''; } };
