import * as E from './engine.js';
import { loadPublished, loadConfig, saveConfig, forgetConfig, getFile, Recorder } from './store.js';

const view = document.getElementById('view');
const dialog = document.getElementById('scoreDialog');
const app = { data: null, calc: null, names: new Map(), recorder: null, notice: '', draft: null };

// ---------- helpers ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => app.names.get(id) ?? 'Unknown';
const playerLink = id => `<a href="#/player/${encodeURIComponent(id)}">${esc(nameOf(id))}</a>`;
const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', opts);
const shortDate = d => fmtDate(d, { day: 'numeric', month: 'short' });
const signed = (x, dp = 1) => {
  const v = Number(x.toFixed(dp));
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(dp);
};
const trend = x => (x == null ? '<span class="muted">–</span>' : `<span class="${x > 0.05 ? 'up' : x < -0.05 ? 'down' : 'muted'}">${signed(x)}</span>`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const groupName = (night, label) => (night.groups.length === 1 ? 'Group' : `Group ${label}`);
const stageName = (night, m) => (m.stage === 'F' ? 'Final' : m.stage === 'SF' ? 'Semi-final' : groupName(night, m.stage));
const openNight = () => app.data.nights.find(n => !n.closed);
const findNight = id => app.data.nights.find(n => n.id === id);
const groupMatches = (night, label) => night.matches.filter(m => m.stage === label);
const groupTables = night => night.groups.map((ids, i) => E.standings(ids, groupMatches(night, E.GROUP_LABELS[i])));
const newId = prefix => prefix + Math.random().toString(36).slice(2, 8);

function groupPlan(n) {
  if (n <= 10) return `one group of ${n}, top 4 to the semis`;
  const a = Math.ceil(n / 2), b = Math.floor(n / 2);
  return `two groups (${a === b ? `${a} each` : `${a} and ${b}`}), top 2 of each to the semis`;
}

function refresh() {
  app.names = new Map(app.data.players.map(p => [p.id, p.name]));
  app.calc = E.compute(app.data);
  render();
}

// Every edit goes through here so it's recorded and saved.
function update(message, mutate, { throttle = false } = {}) {
  mutate(app.data);
  app.recorder.change(message, throttle);
  refresh();
}

// ---------- shared pieces ----------

function scoreLine(m) {
  if (m.walkover) return `walkover to ${esc(nameOf(m.walkover))}`;
  if (m.unfinished) return 'unfinished';
  if (!m.games) return '';
  return m.games.map(([x, y]) => `${x}-${y}`).join(', ');
}

function matchRow(night, m, editable) {
  const o = E.outcome(m);
  const info = app.calc.nightInfo.get(night.id);
  const d = info?.details.get(m.id);
  const side = (id, pos) => {
    const cls = o ? (o.winner === id ? 'win' : 'lose') : '';
    const chg = d ? (d.winner === id ? d.gain : -d.loss) : null;
    return `<span class="who ${pos} ${cls}">${esc(nameOf(id))}${chg != null ? ` <small class="${chg > 0 ? 'up' : 'down'}">${signed(chg)}</small>` : ''}</span>`;
  };
  let mid = '<span class="vs">v</span>';
  if (o?.rated) mid = `<span class="sets">${m.games.filter(g => g[0] > g[1]).length}–${m.games.filter(g => g[0] < g[1]).length}</span>`;
  const detail = scoreLine(m) || (editable ? '<span class="cta">Tap to enter score</span>' : '<span class="muted">not played yet</span>');
  const body = `${side(m.a, 'a')}${mid}${side(m.b, 'b')}<span class="games">${detail}</span>`;
  return editable
    ? `<li><button class="match" data-act="score" data-night="${esc(night.id)}" data-match="${esc(m.id)}">${body}</button></li>`
    : `<li><div class="match">${body}</div></li>`;
}

function standingsTable(table) {
  return `<table class="grid standings"><thead><tr><th>#</th><th class="l">Player</th><th>W</th><th>L</th><th title="Game difference">Games</th><th title="Points difference">Points</th></tr></thead><tbody>
    ${table.map(r => `<tr><td>${r.pos}</td><td class="l">${playerLink(r.id)}</td><td>${r.won}</td><td>${r.lost}</td><td>${signed(r.gd, 0)}</td><td>${signed(r.pd, 0)}</td></tr>`).join('')}
  </tbody></table>`;
}

function changesTable(night) {
  const info = app.calc.nightInfo.get(night.id);
  const rows = [...info.attendees].sort((a, b) => info.change.get(b) - info.change.get(a));
  return `<table class="grid"><thead><tr><th class="l">Player</th><th>Start</th><th title="K: 48 for a player's first 4 Fridays, then 16">K</th><th>Change</th><th>End</th></tr></thead><tbody>
    ${rows.map(id => `<tr><td class="l">${playerLink(id)}${info.unbeaten === id ? ' <span class="tag gold">unbeaten</span>' : ''}</td>
      <td>${Math.round(info.start.get(id))}</td><td>${info.k.get(id)}</td><td>${trend(info.change.get(id))}</td>
      <td><b>${Math.round(info.start.get(id) + info.change.get(id))}</b></td></tr>`).join('')}
  </tbody></table>`;
}

function nightProgress(night) {
  const done = night.matches.filter(E.isSettled).length;
  return `${plural(night.attendees.length, 'player')}, ${done} of ${night.matches.length} matches played`;
}

// ---------- views ----------

function viewRanking() {
  const { table, inactive, closed } = app.calc;
  const open = openNight();
  let h = '<h1>Ranking</h1>';
  h += closed.length
    ? `<p class="muted">After ${plural(closed.length, 'Friday')} · last played ${fmtDate(closed.at(-1).date)}</p>`
    : '<p class="muted">No Fridays recorded yet.</p>';
  if (open) h += `<a class="banner" href="#/night/${encodeURIComponent(open.id)}"><b>Tonight in progress</b><span>${nightProgress(open)} →</span></a>`;
  if (table.length) {
    h += `<table class="grid ranking"><thead><tr><th>#</th><th class="l">Player</th><th title="Rating + bonus">Score</th><th>Rating</th><th>Bonus</th><th class="opt" title="Change on the last Friday">Last</th></tr></thead><tbody>
      ${table.map((r, i) => `<tr><td>${i + 1}</td>
        <td class="l">${playerLink(r.id)}${r.nights < E.NEW_PLAYER_NIGHTS ? ' <span class="tag">new</span>' : ''}${r.unbeaten ? ` <span class="tag gold" title="Unbeaten nights in the last 8 Fridays">★${r.unbeaten > 1 ? r.unbeaten : ''}</span>` : ''}</td>
        <td><b>${Math.round(r.ladder)}</b></td><td>${Math.round(r.rating)}</td><td>${signed(r.bonus, 0)}</td><td class="opt">${trend(r.lastChange)}</td></tr>`).join('')}
    </tbody></table>`;
  }
  if (inactive.length) {
    h += `<details class="card"><summary>Not on the table: no Friday in the last 8 (${inactive.length})</summary>
      <ul class="plain">${inactive.map(r => `<li>${playerLink(r.id)} <span class="muted">rating ${Math.round(r.rating)}</span></li>`).join('')}</ul></details>`;
  }
  h += `<p class="note">Score = rating + bonus. Bonus counts the last 8 Fridays: +5 for each one attended, −5 for each one missed, +10 for an unbeaten night. <a href="#/rules">How it works</a></p>`;
  return h;
}

function ratingChart(points) {
  const W = 360, H = 170, L = 38, R = 10, T = 12, B = 22;
  const ys = points.map(p => p.rating);
  let lo = Math.min(...ys, E.START_RATING), hi = Math.max(...ys, E.START_RATING);
  const pad = Math.max(10, (60 - (hi - lo)) / 2);
  lo -= pad; hi += pad;
  const x = i => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join('');
  const label = (v, txt = Math.round(v)) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${txt}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating after each Friday">
    <line class="base" x1="${L}" x2="${W - R}" y1="${y(E.START_RATING)}" y2="${y(E.START_RATING)}"/>
    ${label(E.START_RATING)}${hi - pad - E.START_RATING > 15 ? label(hi - pad) : ''}${E.START_RATING - (lo + pad) > 15 ? label(lo + pad) : ''}
    <path d="${path}"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rating).toFixed(1)}" r="${points.length > 30 ? 2 : 3.5}"><title>${esc(p.label)}: ${Math.round(p.rating)}</title></circle>`).join('')}
    <text x="${L}" y="${H - 6}">${esc(points[0].label)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(points.at(-1).label)}</text>
  </svg>`;
}

function viewPlayer(id) {
  const p = app.data.players.find(x => x.id === id);
  if (!p) return notFound();
  const { table, inactive, history, nightsOf } = app.calc;
  const pos = table.findIndex(r => r.id === id);
  const row = table[pos] || inactive.find(r => r.id === id);
  const hist = history.get(id) || [];
  let won = 0, lost = 0, items = '';
  for (const night of [...app.calc.nights].reverse()) {
    const ms = night.matches.filter(m => (m.a === id || m.b === id) && (E.outcome(m) || m.unfinished));
    if (!ms.length) continue;
    for (const m of ms) {
      const o = E.outcome(m);
      if (o) o.winner === id ? won++ : lost++;
    }
    items += `<h3><a href="#/night/${encodeURIComponent(night.id)}">${fmtDate(night.date)}</a>${night.closed ? '' : ' <span class="tag">in progress</span>'}</h3>
      <ul class="matches">${ms.map(m => matchRow(night, m, false)).join('')}</ul>`;
  }
  const left = E.NEW_PLAYER_NIGHTS - nightsOf(id);
  let h = `<p class="crumb"><a href="#/">Ranking</a></p><h1>${esc(p.name)}</h1>`;
  if (!row) return h + '<p class="muted">Hasn\'t played a Friday yet.</p>';
  h += `<div class="stats">
    <div><span>Position</span><b>${pos >= 0 ? pos + 1 : '–'}</b></div>
    <div><span>Score</span><b>${Math.round(row.ladder)}</b></div>
    <div><span>Rating</span><b>${Math.round(row.rating)}</b></div>
    <div><span>Bonus</span><b>${signed(row.bonus, 0)}</b></div>
    <div><span>Fridays</span><b>${row.nights}</b></div>
    <div><span>Won–lost</span><b>${won}–${lost}</b></div>
  </div>`;
  h += `<p class="muted">Bonus over the last 8 Fridays: attended ${row.attended} (${signed(5 * row.attended, 0)}), missed ${row.missed} (${signed(-5 * row.missed, 0)}), unbeaten ${row.unbeaten} (${signed(10 * row.unbeaten, 0)}).`;
  if (left > 0) h += ` New player: rating changes are tripled for ${plural(left, 'more Friday')}.`;
  h += pos < 0 ? ' Not on the table until they play again.</p>' : '</p>';
  if (hist.length) h += ratingChart([{ label: 'Start', rating: E.START_RATING }, ...hist.map(x => ({ label: shortDate(x.date), rating: x.rating }))]);
  return h + '<h2>Matches</h2>' + (items || '<p class="muted">No matches yet.</p>');
}

function viewNights() {
  const nights = [...app.calc.nights].reverse();
  let h = '<h1>Nights</h1>';
  if (!nights.length) return h + '<p class="muted">No Fridays recorded yet.</p>';
  h += '<ul class="cards">';
  for (const n of nights) {
    const info = app.calc.nightInfo.get(n.id);
    const status = n.closed
      ? info.champion ? `Won by ${esc(nameOf(info.champion))}${info.unbeaten ? ' <span class="tag gold">unbeaten</span>' : ''}` : 'No final recorded'
      : '<span class="tag">in progress</span>';
    h += `<li><a class="card link" href="#/night/${encodeURIComponent(n.id)}"><b>${fmtDate(n.date)}</b><span>${plural(n.attendees.length, 'player')} · ${status}</span></a></li>`;
  }
  return h + '</ul>';
}

function viewNight(id) {
  const night = findNight(id);
  if (!night) return notFound();
  const info = app.calc.nightInfo.get(id);
  let h = `<p class="crumb"><a href="#/nights">Nights</a></p><h1>${fmtDate(night.date)}</h1>`;
  h += `<p class="muted">${nightProgress(night)}${night.closed ? '' : ' · <span class="tag">in progress</span>'}</p>`;
  if (info.champion) h += `<p class="champion">Winner: ${playerLink(info.champion)}${info.unbeaten ? ' <span class="tag gold">unbeaten +10</span>' : ''}</p>`;
  if (app.recorder) {
    h += night.closed
      ? `<div class="row"><button data-act="reopenNight" data-night="${esc(id)}">Reopen to correct results</button></div>`
      : '<div class="row"><a class="button primary" href="#/record">Record results</a></div>';
  }
  const ko = night.matches.filter(m => !E.isGroupStage(m.stage));
  if (ko.length) h += `<h2>Knockout</h2><ul class="matches">${ko.map(m => `<li class="stage">${stageName(night, m)}</li>${matchRow(night, m, false)}`).join('')}</ul>`;
  groupTables(night).forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    h += `<h2>${groupName(night, label)}</h2>${standingsTable(t)}
      <details><summary>Results</summary><ul class="matches">${groupMatches(night, label).map(m => matchRow(night, m, false)).join('')}</ul></details>`;
  });
  h += `<h2>${night.closed ? 'Rating changes' : 'Rating changes so far'}</h2>`;
  if (!night.closed) h += '<p class="muted">Provisional: ratings update when the night is closed.</p>';
  return h + changesTable(night);
}

function viewRecord() {
  if (!app.recorder) return '<h1>Record</h1><p>Recording needs a sign-in on this phone. <a href="#/settings">Set it up in Settings</a>.</p>';
  const night = openNight();
  return night ? nightDesk(night) : startForm();
}

function startForm() {
  const { ratingOf, nightsOf } = app.calc;
  if (!app.draft) app.draft = { date: today(), picked: new Set() };
  const players = [...app.data.players].sort((a, b) => a.name.localeCompare(b.name));
  let h = '<h1>Start a Friday</h1>';
  h += `<label class="field">Date <input type="date" id="nightDate" value="${esc(app.draft.date)}"></label>`;
  h += '<h2>Who\'s here?</h2>';
  h += players.length
    ? `<div class="checklist">${players.map(p => `<label><input type="checkbox" data-pick="${esc(p.id)}"${app.draft.picked.has(p.id) ? ' checked' : ''}>
        <span>${esc(p.name)}</span><small>${nightsOf(p.id) ? Math.round(ratingOf(p.id)) : 'new'}</small></label>`).join('')}</div>`
    : '<p class="muted">No players yet. Add everyone who\'s here below.</p>';
  h += `<form class="row" data-form="addPlayer"><input name="name" placeholder="New player's name" autocomplete="off" required><button>Add</button></form>`;
  h += `<p id="plan" class="plan">${planText()}</p>`;
  h += '<button class="primary wide" data-act="startNight">Start night</button>';
  return h;
}

function planText() {
  const n = app.draft.picked.size;
  if (n < 2) return 'Tick at least 2 players.';
  const warn = n < 8 || n > 20 ? ' <span class="warn">(the rules are written for 8–20)</span>' : '';
  return `${plural(n, 'player')}: ${groupPlan(n)}.${warn}`;
}

function nightDesk(night) {
  const tables = groupTables(night);
  let h = `<h1>Tonight</h1><p class="muted">${fmtDate(night.date)} · ${nightProgress(night)}</p>`;
  tables.forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    const ms = groupMatches(night, label);
    const done = ms.filter(E.isSettled), todo = ms.filter(m => !E.isSettled(m));
    h += `<h2>${groupName(night, label)} <small class="muted">${done.length}/${ms.length} played</small></h2>`;
    if (todo.length) h += `<ul class="matches">${todo.map(m => matchRow(night, m, true)).join('')}</ul>`;
    if (done.length) h += `<details><summary>Played (${done.length}): tap one to correct it</summary><ul class="matches">${done.map(m => matchRow(night, m, true)).join('')}</ul></details>`;
    h += standingsTable(t);
  });

  h += '<h2>Knockout</h2>';
  const semis = night.matches.filter(m => m.stage === 'SF');
  const final = night.matches.find(m => m.stage === 'F');
  const fresh = m => !m.games && !m.walkover && !m.unfinished;
  if (semis.length) {
    const expectedPairs = E.semiPairs(tables);
    const same = expectedPairs && semis.every((m, i) => m.a === expectedPairs[i][0] && m.b === expectedPairs[i][1]);
    if (!same && semis.every(fresh) && !final) h += '<p class="warn">Group results changed after the semis were made. Redo them to match the tables.</p>';
    h += `<ul class="matches">${semis.map(m => matchRow(night, m, true)).join('')}</ul>`;
  }
  if (final) h += `<ul class="matches"><li class="stage">Final</li>${matchRow(night, final, true)}</ul>`;
  const buttons = [];
  if (!semis.length && !final) {
    buttons.push(night.attendees.length >= 4
      ? '<button class="primary" data-act="makeSemis">Make semi-finals</button>'
      : '<button class="primary" data-act="makeFinal">Make final</button>');
  }
  if (semis.length && !final) {
    if (semis.every(m => E.outcome(m))) buttons.push('<button class="primary" data-act="makeFinal">Make final</button>');
    if (semis.every(fresh)) buttons.push('<button data-act="redoSemis">Redo semi-finals</button>');
  }
  if (final && fresh(final)) buttons.push('<button data-act="redoFinal">Redo final</button>');
  if (buttons.length) h += `<div class="row">${buttons.join('')}</div>`;

  const absent = app.data.players.filter(p => !night.attendees.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  h += `<details class="card"><summary>Late arrival or someone leaving</summary>
    <form class="stack" data-form="lateArrival">
      <p class="muted">A late arrival joins the smaller group and gets fixtures against everyone in it.</p>
      <select name="id"><option value="">Pick a player…</option>${absent.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <input name="name" placeholder="…or a new player's name" autocomplete="off">
      <button>Add to tonight</button>
    </form>
    <form class="stack" data-form="removePlayer">
      <p class="muted">Remove someone ticked by mistake (only if they have no results tonight). If someone leaves part-way, mark their remaining matches as unfinished instead.</p>
      <select name="id" required><option value="">Pick a player…</option>${night.attendees.map(id => `<option value="${esc(id)}">${esc(nameOf(id))}</option>`).join('')}</select>
      <button>Remove from tonight</button>
    </form>
  </details>`;
  h += `<details class="card"><summary>Rating changes so far</summary><p class="muted">Applied when you close the night.</p>${changesTable(night)}</details>`;
  h += `<div class="row end">
    <button class="danger" data-act="deleteNight" data-night="${esc(night.id)}">Delete night</button>
    <button class="primary" data-act="closeNight">Close night and update ratings</button></div>`;
  return h;
}

function viewRules() {
  return `<h1>How it works</h1>
  <div class="prose">
    <h2>Ratings</h2>
    <p>Everyone starts at 1000. After every match the winner takes points from the loser:</p>
    <pre>Expected = 1/(1 + 10^((L − W)/400))
Change   = K × Weight × (1 − Expected)</pre>
    <p>W and L are the winner's and loser's ratings. <b>Expected</b> is how likely the winner was to win, from the ratings. Beating someone rated higher is worth more. <b>K</b> is 16, or 48 for a player's first 4 Fridays so new players find their level quickly. Ratings update once at the end of the night, using the ratings everyone arrived with.</p>
    <h2>Weight: how convincing the win was</h2>
    <pre>Share = winner's points / all points
2-0: Weight = 1 + 2 × (Share − 0.5)
     kept between 1.0 and 1.5
2-1: Weight = 0.75 + (Share − 0.5)
     kept between 0.75 and 0.95</pre>
    <p>Any 2-0 counts more than any 2-1, and the winner always gains.</p>
    <h2>The table</h2>
    <p>Score = rating + bonus. The bonus counts the last 8 Fridays: +5 for each one attended, −5 for each one missed (only since your first night), +10 for an unbeaten night (every group match, the semi and the final). No Friday in the last 8 takes you off the table, but your rating is kept.</p>
    <h2>A night</h2>
    <p>8–10 players: one group, then semis 1v4 and 2v3. 11–20 players: two groups seeded by rating in a snake, then semis A1 v B2 and B1 v A2. Group places go by matches won, then head-to-head, then game difference, then points difference.</p>
  </div>
  <h2>Try a match</h2>
  <form class="calc" id="calc">
    <label class="field">Player A rating <input name="ra" type="number" value="1000" inputmode="numeric"></label>
    <label class="field">Player B rating <input name="rb" type="number" value="1000" inputmode="numeric"></label>
    <label class="field">A's K <select name="ka"><option>16</option><option>48</option></select></label>
    <label class="field">B's K <select name="kb"><option>16</option><option>48</option></select></label>
    <label class="field span">Score, A's points first <input name="score" value="11-9, 9-11, 11-9" autocomplete="off"></label>
  </form>
  <div id="calcOut" class="working">${calcWorking(new FormData())}</div>`;
}

function calcWorking(fd) {
  const num = (k, d) => (Number.isFinite(parseFloat(fd.get(k))) ? parseFloat(fd.get(k)) : d);
  const ra = num('ra', 1000), rb = num('rb', 1000), ka = num('ka', 16), kb = num('kb', 16);
  const games = [...String(fd.get('score') ?? '11-9, 9-11, 11-9').matchAll(/(\d+)\s*[-–:]\s*(\d+)/g)].map(g => [+g[1], +g[2]]);
  const err = E.gamesError(games);
  if (err) return `<p class="warn">${esc(err)}</p>`;
  const o = E.outcome({ a: 'A', b: 'B', games });
  const [rw, rl, kw, kl] = o.winner === 'A' ? [ra, rb, ka, kb] : [rb, ra, kb, ka];
  const exp = E.expected(rw, rl);
  const share = o.pointsWon / (o.pointsWon + o.pointsLost);
  const w = E.weightFor(o.gamesLost, share);
  const raw = o.gamesLost ? 0.75 + (share - 0.5) : 1 + 2 * (share - 0.5);
  const f = (x, dp = 3) => x.toFixed(dp);
  const weightLine = o.gamesLost
    ? `0.75 + (${f(share)} − 0.5) = ${f(raw)}`
    : `1 + 2 × (${f(share)} − 0.5) = ${f(raw)}`;
  const kept = Math.abs(raw - w) > 1e-9 ? ` → kept within ${o.gamesLost ? '0.75–0.95' : '1.0–1.5'} = ${f(w)}` : '';
  return `<p><b>${o.winner === 'A' ? 'A' : 'B'} wins ${o.gamesWon}-${o.gamesLost}</b></p>
  <pre>Expected = 1/(1 + 10^((${rl} − ${rw})/400)) = ${f(exp)}
Share    = ${o.pointsWon} / ${o.pointsWon + o.pointsLost} = ${f(share)}
Weight   = ${weightLine}${kept}
Winner   = ${kw} × ${f(w)} × (1 − ${f(exp)}) = <span class="up">${signed(kw * w * (1 - exp))}</span>
Loser    = ${kl} × ${f(w)} × (1 − ${f(exp)}) = <span class="down">${signed(-kl * w * (1 - exp))}</span></pre>`;
}

function viewSettings() {
  const r = app.recorder;
  let h = '<h1>Settings</h1>';
  if (r) {
    h += `<section class="card"><h2>Recorder</h2>
      <p>This phone records results to <b>${esc(r.cfg.repo)}</b>.</p>
      <p>${syncText()}${r.detail ? `<br><span class="muted">${esc(r.detail)}</span>` : ''}</p>
      <div class="row">
        ${r.dirty ? '<button class="primary" data-act="syncNow">Upload now</button>' : ''}
        ${r.status === 'conflict' ? '<button data-act="overwrite">Overwrite GitHub</button><button data-act="discard">Discard this phone\'s changes</button>' : ''}
        <button data-act="signOut">Sign out on this phone</button>
      </div></section>`;
    const players = [...app.data.players].sort((a, b) => a.name.localeCompare(b.name));
    h += `<section class="card"><h2>Players</h2><ul class="plain">${players.map(p => `<li class="between"><span>${esc(p.name)}</span>
      <span><button class="small" data-act="rename" data-id="${esc(p.id)}">Rename</button>${playerUsed(p.id) ? '' : ` <button class="small danger" data-act="deletePlayer" data-id="${esc(p.id)}">Delete</button>`}</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul></section>`;
  } else {
    const guess = guessRepo();
    h += `<section class="card"><h2>Recorder sign-in</h2>
      <p class="muted">Only the person recording results needs this. Viewing the ranking needs nothing.</p>
      <form class="stack" data-form="signIn">
        <label class="field">GitHub repository (owner/name) <input name="repo" value="${esc(guess)}" placeholder="yourname/table_tennis_ranking" required autocomplete="off" autocapitalize="off"></label>
        <label class="field">Branch <input name="branch" value="main" required autocapitalize="off"></label>
        <label class="field">Data file <input name="path" value="docs/data.json" required autocapitalize="off"></label>
        <label class="field">Access token <input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
        <p class="muted">The token is kept only on this phone. Make it a fine-grained token limited to this one repository with "Contents: read and write" permission.</p>
        <button class="primary">Sign in</button>
        <p id="signInError" class="warn"></p>
      </form></section>`;
  }
  if (app.data) h += '<section class="card"><h2>Backup</h2><p class="muted">GitHub keeps every version, but you can also download the data.</p><button data-act="download">Download data.json</button></section>';
  return h;
}

const playerUsed = id => app.data.nights.some(n => n.attendees.includes(id) || n.matches.some(m => m.a === id || m.b === id));

function guessRepo() {
  const host = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return host && repo ? `${host[1]}/${repo}` : '';
}

const notFound = () => '<h1>Not found</h1><p><a href="#/">Back to the ranking</a></p>';

// ---------- rendering ----------

const routes = [
  [/^#?\/?$/, viewRanking],
  [/^#\/player\/(.+)$/, viewPlayer],
  [/^#\/nights$/, viewNights],
  [/^#\/night\/(.+)$/, viewNight],
  [/^#\/record$/, viewRecord],
  [/^#\/rules$/, viewRules],
  [/^#\/settings$/, viewSettings],
];

function render() {
  const hash = location.hash || '#/';
  document.querySelectorAll('[data-nav]').forEach(a => {
    a.toggleAttribute('aria-current', hash === a.getAttribute('href') || (a.getAttribute('href') !== '#/' && hash.startsWith(a.getAttribute('href').replace(/s$/, ''))));
  });
  document.querySelector('[data-nav="record"]').hidden = !app.recorder;
  renderSync();
  const notice = app.notice ? `<p class="banner warn">${esc(app.notice)}</p>` : '';
  if (!app.data && hash !== '#/settings') {
    view.innerHTML = notice || '<p class="muted">Loading…</p>';
    return;
  }
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) { view.innerHTML = notice + fn(...m.slice(1).map(decodeURIComponent)); return; }
  }
  view.innerHTML = notFound();
}

function syncText() {
  const r = app.recorder;
  return {
    saved: 'All results uploaded.',
    pending: 'Saved on this phone. Uploads within 5 minutes (tap to upload now).',
    saving: 'Uploading…',
    offline: 'Offline: saved on this phone.',
    conflict: 'Not uploaded: GitHub has a newer version.',
    error: 'Not uploaded: GitHub refused the save.',
  }[r.status];
}

function renderSync() {
  const pill = document.getElementById('sync');
  const r = app.recorder;
  pill.hidden = !r;
  if (!r) return;
  pill.dataset.state = r.status;
  pill.textContent = { saved: 'Saved', pending: 'Upload', saving: 'Saving…', offline: 'Offline', conflict: 'Save problem', error: 'Save problem' }[r.status];
  pill.title = syncText();
}

// ---------- score entry ----------

function openScore(nightId, matchId) {
  const night = findNight(nightId);
  const m = night.matches.find(x => x.id === matchId);
  const g = i => m.games?.[i] ?? ['', ''];
  dialog.dataset.night = nightId;
  dialog.dataset.match = matchId;
  dialog.innerHTML = `<form method="dialog" class="score" autocomplete="off">
    <h2>${stageName(night, m)}</h2>
    <div class="score-grid">
      <span></span><b>${esc(nameOf(m.a))}</b><b>${esc(nameOf(m.b))}</b>
      ${[0, 1, 2].map(i => `<span>Game ${i + 1}</span>
        <input data-g="${i}" data-s="0" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[0]}" aria-label="Game ${i + 1} ${esc(nameOf(m.a))}">
        <input data-g="${i}" data-s="1" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[1]}" aria-label="Game ${i + 1} ${esc(nameOf(m.b))}">`).join('')}
    </div>
    <p class="preview" id="scorePreview"></p>
    <div class="row end reverse"><button class="primary" data-act="saveScore">Save</button><button value="cancel" formnovalidate>Cancel</button></div>
    <details><summary>Walkover, unfinished or clear</summary>
      <p class="muted">Walkovers and unfinished matches don't change ratings. A walkover counts as a win in the group table.</p>
      <div class="row wrap">
        <button data-act="walkover" data-id="${esc(m.a)}">Walkover to ${esc(nameOf(m.a))}</button>
        <button data-act="walkover" data-id="${esc(m.b)}">Walkover to ${esc(nameOf(m.b))}</button>
        <button data-act="unfinished">Unfinished</button>
        <button class="danger" data-act="clearScore">Clear result</button>
      </div>
    </details>
  </form>`;
  dialog.showModal();
  scorePreview();
  if (!m.games) dialog.querySelector('input').focus();
}

function readGames() {
  const games = [];
  let gap = false;
  for (let i = 0; i < 3; i++) {
    const [x, y] = [0, 1].map(s => dialog.querySelector(`[data-g="${i}"][data-s="${s}"]`).value.trim());
    if (x === '' && y === '') { gap = true; continue; }
    if (x === '' || y === '') return { error: `Game ${i + 1}: enter both scores` };
    if (gap) return { error: 'Fill the games in order' };
    games.push([+x, +y]);
  }
  return { games, error: E.gamesError(games) };
}

function dialogMatch() {
  const night = findNight(dialog.dataset.night);
  return { night, m: night.matches.find(x => x.id === dialog.dataset.match) };
}

function scorePreview(showError = false) {
  const out = dialog.querySelector('#scorePreview');
  const { games, error } = readGames();
  const { night, m } = dialogMatch();
  if (error) {
    out.className = showError ? 'preview warn' : 'preview muted';
    out.textContent = showError || games?.length >= 2 ? error : 'Enter each game, first player\'s score on the left.';
    return;
  }
  const o = E.outcome({ ...m, games });
  const info = app.calc.nightInfo.get(night.id);
  const share = o.pointsWon / (o.pointsWon + o.pointsLost);
  const w = E.weightFor(o.gamesLost, share);
  const base = w * (1 - E.expected(info.start.get(o.winner), info.start.get(o.loser)));
  out.className = 'preview';
  out.innerHTML = `<b>${esc(nameOf(o.winner))} wins ${o.gamesWon}-${o.gamesLost}</b> · points ${o.pointsWon}–${o.pointsLost} (${(share * 100).toFixed(1)}%) · weight ${w.toFixed(2)}<br>
    ${esc(nameOf(o.winner))} <span class="up">${signed(info.k.get(o.winner) * base)}</span>, ${esc(nameOf(o.loser))} <span class="down">${signed(-info.k.get(o.loser) * base)}</span>`;
}

function setResult(describe, apply) {
  const { night, m } = dialogMatch();
  update(`${night.date} ${stageName(night, m)}: ${nameOf(m.a)} v ${nameOf(m.b)} ${describe}`, () => {
    delete m.games; delete m.walkover; delete m.unfinished;
    apply(m);
  }, { throttle: true });
  dialog.close();
}

// ---------- actions ----------

function addPlayer(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (app.data.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    alert(`There's already a player called ${name}. Add a surname or initial to tell them apart.`);
    return null;
  }
  let id;
  do id = newId('p'); while (app.data.players.some(p => p.id === id));
  app.data.players.push({ id, name });
  app.names.set(id, name);
  return id;
}

function addMatches(night, label, pairs) {
  let n = Math.max(0, ...groupMatches(night, label).map(m => parseInt(m.id.slice(label.length), 10) || 0));
  for (const [a, b] of pairs) night.matches.push({ id: `${label}${++n}`, stage: label, a, b });
}

const actions = {
  score: el => openScore(el.dataset.night, el.dataset.match),

  saveScore: () => {
    const { games, error } = readGames();
    if (error) { scorePreview(true); return; }
    const o = E.outcome({ ...dialogMatch().m, games });
    setResult(`${o.gamesWon}-${o.gamesLost} to ${nameOf(o.winner)} (${games.map(g => g.join('-')).join(', ')})`, m => { m.games = games; });
  },
  walkover: el => setResult(`walkover to ${nameOf(el.dataset.id)}`, m => { m.walkover = el.dataset.id; }),
  unfinished: () => setResult('unfinished', m => { m.unfinished = true; }),
  clearScore: () => setResult('result cleared', () => {}),

  startNight: () => {
    const date = document.getElementById('nightDate').value;
    const ids = [...app.draft.picked];
    if (!date) return alert('Pick the date.');
    if (app.data.nights.some(n => n.date === date)) return alert(`There's already a night on ${fmtDate(date)}.`);
    if (ids.length < 2) return alert('Tick at least 2 players.');
    if ((ids.length < 8 || ids.length > 20) && !confirm(`The rules are written for 8–20 players. Start with ${ids.length} anyway?`)) return;
    const groups = E.seedGroups(ids, app.calc.ratingOf, nameOf);
    const night = { id: date, date, closed: false, attendees: ids, groups, matches: [] };
    groups.forEach((g, i) => addMatches(night, E.GROUP_LABELS[i], E.roundRobin(g)));
    app.draft = null;
    update(`Start night ${date} (${ids.length} players)`, d => d.nights.push(night));
  },

  makeSemis: () => {
    const night = openNight();
    const pending = night.matches.filter(m => E.isGroupStage(m.stage) && !E.isSettled(m)).length;
    if (pending && !confirm(`${plural(pending, 'group match')} still have no result. Make the semis from the tables as they are now?`)) return;
    const pairs = E.semiPairs(groupTables(night));
    if (!pairs) return alert('Not enough players in the groups for semi-finals.');
    update(`${night.date}: semi-finals made`, () => {
      pairs.forEach(([a, b], i) => night.matches.push({ id: `SF${i + 1}`, stage: 'SF', a, b }));
    }, { throttle: true });
  },
  redoSemis: () => {
    const night = openNight();
    update(`${night.date}: semi-finals removed`, () => { night.matches = night.matches.filter(m => m.stage !== 'SF'); }, { throttle: true });
  },
  makeFinal: () => {
    const night = openNight();
    const semis = night.matches.filter(m => m.stage === 'SF');
    const [a, b] = semis.length ? semis.map(m => E.outcome(m).winner) : groupTables(night)[0].map(r => r.id);
    update(`${night.date}: final made`, () => night.matches.push({ id: 'F', stage: 'F', a, b }), { throttle: true });
  },
  redoFinal: () => {
    const night = openNight();
    update(`${night.date}: final removed`, () => { night.matches = night.matches.filter(m => m.stage !== 'F'); }, { throttle: true });
  },

  closeNight: () => {
    const night = openNight();
    const pending = night.matches.filter(m => !E.isSettled(m)).length;
    const msg = `Close ${fmtDate(night.date)} and update everyone's ratings?` +
      (pending ? `\n\n${plural(pending, 'match')} have no result and won't count.` : '') +
      (night.matches.some(m => m.stage === 'F') ? '' : '\n\nThere is no final, so nobody gets the unbeaten bonus.');
    if (!confirm(msg)) return;
    update(`Close night ${night.date}`, () => { night.closed = true; });
    location.hash = `#/night/${encodeURIComponent(night.id)}`;
  },
  reopenNight: el => {
    if (openNight()) return alert('Another night is still open. Close it first.');
    const night = findNight(el.dataset.night);
    if (!confirm(`Reopen ${fmtDate(night.date)}? Its rating changes are taken back until you close it again.`)) return;
    update(`Reopen night ${night.date}`, () => { night.closed = false; });
    location.hash = '#/record';
  },
  deleteNight: el => {
    const night = findNight(el.dataset.night);
    if (!confirm(`Delete ${fmtDate(night.date)} and all its results? This can't be undone here (GitHub keeps the old version).`)) return;
    update(`Delete night ${night.date}`, d => { d.nights = d.nights.filter(n => n !== night); });
  },

  syncNow: () => {
    if (app.recorder.status === 'conflict' || app.recorder.status === 'error') location.hash = '#/settings';
    else app.recorder.saveNow();
  },
  overwrite: async () => {
    if (!confirm('Replace the version on GitHub with this phone\'s version?')) return;
    try { await app.recorder.overwrite(); } catch (e) { alert(e.message); }
    render();
  },
  discard: async () => {
    if (!confirm('Throw away the changes on this phone and load the version on GitHub?')) return;
    try { app.data = await app.recorder.discard(); refresh(); } catch (e) { alert(e.message); }
  },
  signOut: async () => {
    if (app.recorder.dirty && !confirm('Some results haven\'t been uploaded yet and will be lost. Sign out anyway?')) return;
    forgetConfig();
    app.recorder = null;
    try { app.data = await loadPublished(); } catch { /* keep what we have */ }
    refresh();
  },
  rename: el => {
    const p = app.data.players.find(x => x.id === el.dataset.id);
    const name = prompt('New name', p.name)?.trim().replace(/\s+/g, ' ');
    if (!name || name === p.name) return;
    if (app.data.players.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) return alert(`There's already a player called ${name}.`);
    update(`Rename ${p.name} to ${name}`, () => { p.name = name; });
  },
  deletePlayer: el => {
    const p = app.data.players.find(x => x.id === el.dataset.id);
    if (!confirm(`Delete ${p.name}? They have no results.`)) return;
    update(`Delete player ${p.name}`, d => { d.players = d.players.filter(x => x !== p); });
  },
  download: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(app.data, null, 1)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `table-tennis-data-${today()}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

const forms = {
  addPlayer: form => {
    const id = addPlayer(form.name.value);
    if (!id) return;
    app.draft.picked.add(id);
    update(`Add player ${nameOf(id)}`, () => {}, { throttle: true });
  },
  lateArrival: form => {
    const night = openNight();
    let id = form.id.value;
    if (!id && form.name.value.trim()) id = addPlayer(form.name.value);
    if (!id) return;
    const sizes = night.groups.map(g => g.length);
    const gi = sizes.indexOf(Math.min(...sizes));
    const label = E.GROUP_LABELS[gi];
    update(`${night.date}: ${nameOf(id)} joins ${groupName(night, label)}`, () => {
      addMatches(night, label, night.groups[gi].map(other => [other, id]));
      night.groups[gi].push(id);
      night.attendees.push(id);
    }, { throttle: true });
  },
  removePlayer: form => {
    const night = openNight();
    const id = form.id.value;
    if (night.matches.some(m => (m.a === id || m.b === id) && (m.games || m.walkover || m.unfinished))) {
      return alert(`${nameOf(id)} already has results tonight. Mark their other matches as unfinished instead.`);
    }
    if (night.matches.some(m => !E.isGroupStage(m.stage))) return alert('Redo the knockout matches first.');
    if (!confirm(`Remove ${nameOf(id)} from tonight?`)) return;
    update(`${night.date}: ${nameOf(id)} removed`, () => {
      night.attendees = night.attendees.filter(x => x !== id);
      night.groups = night.groups.map(g => g.filter(x => x !== id));
      night.matches = night.matches.filter(m => m.a !== id && m.b !== id);
    }, { throttle: true });
  },
  signIn: async form => {
    const cfg = {
      repo: form.repo.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''),
      branch: form.branch.value.trim(), path: form.path.value.trim().replace(/^\//, ''), token: form.token.value.trim(),
    };
    const err = document.getElementById('signInError');
    err.textContent = 'Checking…';
    try {
      await getFile(cfg);
    } catch (e) {
      err.textContent = e.status === 404
        ? `Couldn't find ${cfg.path} in ${cfg.repo} (branch ${cfg.branch}), or the token can't see that repository.`
        : `GitHub said: ${e.message}`;
      return;
    }
    saveConfig(cfg);
    await startRecorder(cfg);
    location.hash = '#/record';
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el);
});

document.addEventListener('submit', e => {
  const name = e.target.dataset.form;
  if (!name) return;
  e.preventDefault();
  forms[name](e.target);
});

document.addEventListener('input', e => {
  if (e.target.closest('#scoreDialog')) return scorePreview();
  if (e.target.closest('#calc')) {
    document.getElementById('calcOut').innerHTML = calcWorking(new FormData(document.getElementById('calc')));
  }
  if (e.target.id === 'nightDate') app.draft.date = e.target.value;
});

document.addEventListener('change', e => {
  const id = e.target.dataset?.pick;
  if (id === undefined) return;
  e.target.checked ? app.draft.picked.add(id) : app.draft.picked.delete(id);
  document.getElementById('plan').innerHTML = planText();
});

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- start-up ----------

async function startRecorder(cfg) {
  const recorder = new Recorder(cfg, () => {
    renderSync();
    if (location.hash === '#/settings' && app.recorder) render();
  });
  app.data = await recorder.load(() => confirm(
    'This phone has results that were never uploaded, but GitHub has changed since.\n\n' +
    'OK: keep this phone\'s version (it will replace GitHub\'s).\nCancel: discard this phone\'s changes.'));
  app.recorder = recorder;
  app.notice = '';
  refresh();
}

async function start() {
  const cfg = loadConfig();
  if (cfg) {
    try { await startRecorder(cfg); return; } catch (e) {
      app.notice = `Couldn't open GitHub as the recorder (${e.message}). Showing the published results; check Settings.`;
    }
  }
  try {
    app.data = await loadPublished();
    refresh();
  } catch (e) {
    app.notice = e.message;
    render();
  }
}

start();
