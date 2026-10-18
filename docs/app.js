import * as E from './engine.js';
import { buildStats } from './stats.js';
import { loadPublished, loadConfig, saveConfig, forgetConfig, getFile, Recorder } from './store.js';

// In the data a tournament is called a "night"; on screen it's always "tournament".
const view = document.getElementById('view');
const dialog = document.getElementById('scoreDialog');
const app = {
  data: null, calc: null, stats: null, prevPos: new Map(), names: new Map(),
  recorder: null, notice: '', draft: null, edit: null,
};

// ---------- helpers ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => app.names.get(id) ?? 'Unknown';
const playerHref = id => `#/player/${encodeURIComponent(id)}`;
const nightHref = id => `#/tournament/${encodeURIComponent(id)}`;
const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', opts);
const shortDate = d => fmtDate(d, { day: 'numeric', month: 'short' });
const dayDate = d => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
const signed = (x, dp = 1) => {
  const v = Number(x.toFixed(dp));
  return v === 0 ? (0).toFixed(dp) : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(dp);
};
const pct = x => `${Math.round(x * 100)}%`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const groupName = (night, label) => (night.groups.length === 1 ? 'Group' : `Group ${label}`);
const stageName = (night, m) => ({ F: 'Final', SF: 'Semi-final', '3P': '3rd place match' }[m.stage] ?? groupName(night, m.stage));
const knockout = night => night.matches.filter(m => !E.isGroupStage(m.stage))
  .sort((x, y) => E.KNOCKOUT_ORDER[x.stage] - E.KNOCKOUT_ORDER[y.stage] || x.id.localeCompare(y.id));
const openNight = () => app.data.nights.find(n => !n.closed);
const findNight = id => app.data.nights.find(n => n.id === id);
const groupMatches = (night, label) => night.matches.filter(m => m.stage === label);
const groupTables = night => night.groups.map((ids, i) => E.standings(ids, groupMatches(night, E.GROUP_LABELS[i])));
const hasResult = m => !!(m.games || m.walkover || m.unfinished);
const newId = prefix => prefix + Math.random().toString(36).slice(2, 8);
const setsOf = (m, id) => m.games.filter(g => (id === m.a ? g[0] > g[1] : g[1] > g[0])).length;
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));

const who = (id, sub = '') => `<span class="nm"><b>${esc(nameOf(id))}</b>${sub ? `<small>${sub}</small>` : ''}</span>`;
const chg = (x, dp = 1) => `<span class="chg ${x > 0.05 ? 'up' : x < -0.05 ? 'down' : 'flat'}">${signed(x, dp)}</span>`;
const formPills = (results, n = 5, big = false) =>
  `<span class="form${big ? ' big' : ''}">${results.slice(-n).map(r => `<i class="${r.won ? 'w' : 'l'}">${r.won ? 'W' : 'L'}</i>`).join('')}</span>`;
// A player's rating at the start of a tournament, small and grey, to show who's playing whom.
const startRating = (info, id) => (info?.start.has(id) ? `<small class="rt">${Math.round(info.start.get(id))}</small>` : '');
const tile = (label, value) => `<div class="tile"><span>${label}</span><b>${value}</b></div>`;
const trophy = (cls = 'trophy') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v2h3v2a4 4 0 0 1-4 4h-.4A6 6 0 0 1 13 13.9V17h3v3H8v-3h3v-3.1A6 6 0 0 1 7.4 11H7a4 4 0 0 1-4-4V5h3V3Zm0 4H5a2 2 0 0 0 1.2 1.8L6 7Zm12 0-.2 1.8A2 2 0 0 0 19 7h-1Z"/></svg>`;
const podiumName = (info, id) => (id === info.champion ? 'winner' : id === info.runnerUp ? 'runner-up' : id === info.third ? '3rd' : '');

// Groups are seeded by table position: Score for players on the table, otherwise rating.
function rankScore() {
  const score = new Map(app.calc.table.map(r => [r.id, r.ladder]));
  return id => score.get(id) ?? app.calc.ratingOf(id);
}
const drawGroups = ids => E.seedGroups(ids, rankScore(), nameOf);

function groupPlan(n) {
  if (n < 4) return 'one group, then a final between the top 2';
  const a = Math.ceil(n / 2), b = Math.floor(n / 2);
  return `two groups (${a === b ? `${a} each` : `${a} and ${b}`}), top 2 of each to the semis`;
}

function refresh() {
  app.names = new Map(app.data.players.map(p => [p.id, p.name]));
  app.calc = E.compute(app.data);
  app.stats = buildStats(app.calc);
  app.prevPos = previousPositions();
  render();
}

// Table positions before the last tournament, for the movement arrows.
function previousPositions() {
  const last = app.calc.closed.at(-1);
  if (!last) return new Map();
  const prev = E.compute({ ...app.data, nights: app.data.nights.filter(n => n.closed && n !== last) });
  return new Map(prev.table.map((r, i) => [r.id, i + 1]));
}

// Every edit goes through here so it's recorded and saved.
function update(message, mutate, { throttle = false } = {}) {
  mutate(app.data);
  app.recorder.change(message, throttle);
  refresh();
}

// ---------- shared pieces ----------

// Playing order for the group stage: round by round, alternating groups (A round 1, B round 1,
// A round 2, ...). Fixtures are stored in round-robin order, so nobody plays twice in a round.
function playOrder(night) {
  const order = [];
  night.groups.forEach((g, gi) => {
    const perRound = Math.max(1, Math.floor(g.length / 2));
    groupMatches(night, E.GROUP_LABELS[gi]).forEach((m, i) => order.push({ m, round: Math.floor(i / perRound), gi, i }));
  });
  order.sort((x, y) => x.round - y.round || x.gi - y.gi || x.i - y.i);
  return order.map(x => x.m);
}

// "Match 7 · Group A": the number is the match's place in the playing order.
function queueLabel(night, order, m) {
  if (!E.isGroupStage(m.stage)) return m.stage === 'SF' ? `Semi-final ${m.id.slice(2)}` : stageName(night, m);
  return `Match ${order.indexOf(m) + 1}${night.groups.length > 1 ? ` · ${groupName(night, m.stage)}` : ''}`;
}

function upNext(night, { editable = false, limit = Infinity, withKnockout = true } = {}) {
  const order = playOrder(night);
  const ko = withKnockout ? knockout(night) : [];
  const todo = [...order, ...ko].filter(m => !E.isSettled(m));
  if (!todo.length) return '';
  const shown = todo.slice(0, limit);
  return `<section class="card"><h2>Up next <small>${plural(todo.length, 'match', 'matches')} to play</small></h2>
    <div class="matches">${shown.map((m, i) => `${i === 0 ? '<div class="stage-label next">Next</div>' : ''}${matchCard(night, m, { editable, prefix: queueLabel(night, order, m) })}`).join('')}</div>
    ${todo.length > shown.length ? `<details class="more"><summary>The rest (${todo.length - shown.length})</summary><div class="matches">${todo.slice(limit).map(m => matchCard(night, m, { prefix: queueLabel(night, order, m) })).join('')}</div></details>` : ''}</section>`;
}

function matchCard(night, m, { editable = false, stage = false, prefix = '' } = {}) {
  const o = E.outcome(m);
  const info = app.calc.nightInfo.get(night.id);
  const d = info?.details.get(m.id);
  // Under each name: the rating they started the tournament with, then the change from this match.
  const side = (id, pos) => {
    const state = o ? (o.winner === id ? 'win' : 'lose') : '';
    const c = d ? (d.winner === id ? d.gain : -d.loss) : null;
    return `<span class="mc-side ${pos} ${state}"><b>${esc(nameOf(id))}</b>
      <span class="sub">${startRating(info, id)}${c != null ? chg(c) : ''}</span></span>`;
  };
  let score = '<span class="mc-score vs">VS</span>';
  if (o?.rated) score = `<span class="mc-score"><b>${setsOf(m, m.a)}</b><span>–</span><b>${setsOf(m, m.b)}</b></span>`;
  else if (m.walkover) score = '<span class="mc-score vs">W/O</span>';
  let line = m.walkover ? `Walkover to ${esc(nameOf(m.walkover))}`
    : m.unfinished ? 'Unfinished'
    : m.games ? m.games.map(g => g.join('-')).join(' · ')
    : editable ? '<span class="cta">Tap to enter score</span>' : 'Not played yet';
  if (stage && !E.isGroupStage(m.stage)) line = `${stageName(night, m)} · ${line}`;
  if (prefix) line = `<span class="qn">${prefix}</span> · ${line}`;
  const body = `${side(m.a, 'a')}${score}${side(m.b, 'b')}<span class="mc-games">${line}</span>`;
  return editable
    ? `<button class="mc" data-act="score" data-night="${esc(night.id)}" data-match="${esc(m.id)}">${body}</button>`
    : `<div class="mc">${body}</div>`;
}

function groupTable(night, table) {
  const places = night.groups.length === 1 ? (night.attendees.length >= 4 ? 4 : 2) : 2;
  const info = app.calc.nightInfo.get(night.id);
  return `<div class="gt-head"><span>#</span><span>Player</span><span>W</span><span>L</span><span>G±</span><span>P±</span></div>
    ${table.map(r => `<a class="gt-row${r.pos <= places ? ' q' : ''}" href="${playerHref(r.id)}"><span>${r.pos}</span>
      <span class="nm"><b>${esc(nameOf(r.id))} ${startRating(info, r.id)}</b></span>
      <span>${r.won}</span><span>${r.lost}</span><span>${signed(r.gd, 0)}</span><span>${signed(r.pd, 0)}</span></a>`).join('')}
    <div class="legend">${places === 4 ? 'Semi-final places' : night.groups.length === 1 ? 'Final places' : 'Semi-final places'}</div>`;
}

function bracket(night) {
  const semis = night.matches.filter(m => m.stage === 'SF');
  const final = night.matches.find(m => m.stage === 'F');
  const playoff = night.matches.find(m => m.stage === '3P');
  const box = (m, label) => {
    if (!m) return `<div class="bm"><div class="bm-label">${label}</div><div class="bm-row tbd"><b>To be decided</b></div><div class="bm-row tbd"><b>To be decided</b></div></div>`;
    const o = E.outcome(m);
    const info = app.calc.nightInfo.get(night.id);
    const mark = id => (m.games && o ? setsOf(m, id) : m.walkover === id ? 'W/O' : '');
    const row = id => `<a class="bm-row${o?.winner === id ? ' win' : ''}" href="${playerHref(id)}"><b>${esc(nameOf(id))} ${startRating(info, id)}</b><em>${mark(id)}</em></a>`;
    return `<div class="bm"><div class="bm-label">${label}</div>${row(m.a)}${row(m.b)}</div>`;
  };
  if (!semis.length) return box(final, `${trophy()} Final`);
  return `<div class="bracket">
    <div class="br-col semis">${box(semis[0], 'Semi-final 1')}${box(semis[1], 'Semi-final 2')}</div>
    <div class="br-join"></div><div class="br-stem"></div>
    <div class="br-col final">${box(final, `${trophy()} Final`)}</div>
    ${playoff ? `<div class="br-third">${box(playoff, '3rd place')}</div>` : ''}</div>`;
}

function changesList(night) {
  const info = app.calc.nightInfo.get(night.id);
  const ids = [...info.attendees].sort((a, b) => info.change.get(b) - info.change.get(a));
  return ids.map(id => {
    const start = info.start.get(id), c = info.change.get(id);
    const notes = [podiumName(info, id), info.k.get(id) === E.K_NEW ? 'new · changes ×3' : ''].filter(Boolean).join(' · ');
    return `<a class="ch-row" href="${playerHref(id)}">${who(id, notes)}<span class="flow">${Math.round(start)} → <b>${Math.round(start + c)}</b></span>${chg(c)}</a>`;
  }).join('');
}

function progress(night) {
  const done = night.matches.filter(E.isSettled).length;
  return { done, total: night.matches.length, pct: night.matches.length ? Math.round((100 * done) / night.matches.length) : 0 };
}

function liveCard(night) {
  const p = progress(night);
  return `<a class="card live-card" href="${nightHref(night.id)}">
    <div class="row1"><b><span class="dot"></span>Tournament in progress</b><span class="tag live">Live</span></div>
    <p class="muted">${plural(night.attendees.length, 'player')} · ${p.done} of ${p.total} matches played</p>
    <div class="bar"><span style="width:${p.pct}%"></span></div></a>`;
}

function dateStrip(activeId) {
  return `<nav class="strip" id="strip" aria-label="Tournaments">${app.calc.nights.map(n => `<a class="chip${n.id === activeId ? ' active' : ''}" href="${nightHref(n.id)}">
    <small>${n.closed ? fmtDate(n.date, { weekday: 'short' }) : '<span class="dot"></span>Live'}</small><b>${shortDate(n.date)}</b></a>`).join('')}</nav>`;
}

// ---------- views ----------

function viewTable() {
  const { table, inactive, closed } = app.calc;
  const open = openNight();
  const last = closed.at(-1);
  let h = `<section class="page-head"><h1>Table</h1><p class="sub">${last ? `After ${plural(closed.length, 'tournament')} · last ${dayDate(last.date)}` : 'No tournaments played yet'}</p></section>`;
  if (open) h += liveCard(open);
  if (last) h += lastTournamentCard(last);
  if (table.length) {
    h += `<section class="card flush"><div class="lt-head"><span>#</span><span>Player</span><span class="form-col">Form</span><span>Score</span></div>
      ${table.map((r, i) => tableRow(r, i + 1)).join('')}</section>`;
  }
  if (inactive.length) {
    h += `<details class="card"><summary>Not on the table (${inactive.length})</summary>
      <p class="muted">No tournament in the last 8. Ratings are kept.</p>
      ${inactive.map(r => `<a class="list-row" href="${playerHref(r.id)}"><span></span>${who(r.id)}<span class="val">${Math.round(r.rating)}<small>rating</small></span></a>`).join('')}</details>`;
  }
  if (table.length) {
    h += '<p class="foot">Score = rating + attendance bonus (shown under each name): +5 for each of the last 8 tournaments attended, −5 for each one missed. ★ = tournaments won. <a href="#/rules">How it works</a></p>';
  }
  return h;
}

function tableRow(r, pos) {
  const prev = app.prevPos.get(r.id);
  const move = prev == null || prev === pos ? '' : prev > pos ? `<i class="up">▲${prev - pos}</i>` : `<i class="down">▼${pos - prev}</i>`;
  const titles = app.stats.players.get(r.id)?.titles ?? 0;
  const tags = (r.nights < E.NEW_PLAYER_NIGHTS ? ' <span class="tag">new</span>' : '') +
    (titles ? ` <span class="tag gold" title="Tournaments won">★${titles > 1 ? titles : ''}</span>` : '');
  const sub = `${Math.round(r.rating)} ${r.bonus < 0 ? '−' : '+'} ${Math.abs(r.bonus)}`;
  return `<a class="lt-row p${pos}" href="${playerHref(r.id)}"><span class="pos">${pos}${move}</span>
    <span class="nm"><b>${esc(nameOf(r.id))}${tags}</b><small>${sub}</small></span>
    ${formPills(app.stats.players.get(r.id)?.results ?? [])}<span class="pts">${Math.round(r.ladder)}</span></a>`;
}

function lastTournamentCard(night) {
  const info = app.calc.nightInfo.get(night.id);
  if (!info.champion) return '';
  const o = E.outcome(night.matches.find(m => m.stage === 'F'));
  const line = o.rated ? `Beat ${esc(nameOf(o.loser))} ${o.gamesWon}–${o.gamesLost} in the final` : 'Won the final';
  return `<a class="card hero-mini" href="${nightHref(night.id)}"><div class="label">Last tournament · ${dayDate(night.date)}</div>
    <div class="body">${trophy('trophy big')}<div><b>${esc(nameOf(info.champion))}</b><br><small class="muted">${line}</small></div><span class="chev">›</span></div></a>`;
}

function viewTournaments() {
  const latest = app.calc.nights.at(-1);
  return latest ? viewNight(latest.id) : '<section class="page-head"><h1>Tournaments</h1></section><p class="empty">No tournaments recorded yet.</p>';
}

function viewNight(id) {
  const night = findNight(id);
  if (!night) return notFound();
  const info = app.calc.nightInfo.get(id);
  let h = dateStrip(id) + tournamentHero(night, info);
  if (app.recorder) {
    h += night.closed
      ? `<div class="btn-pair"><button data-act="reopenNight" data-night="${esc(id)}">Reopen to correct or edit</button>
         <button class="danger" data-act="deleteNight" data-night="${esc(id)}">Delete</button></div>`
      : '<a class="button primary wide" href="#/record">Record results</a>';
  }
  if (!night.closed) h += upNext(night, { limit: 6 });
  const ko = knockout(night);
  if (ko.length) {
    h += `<section class="card"><h2>Knockout</h2>${bracket(night)}
      <details class="more"><summary>Scores</summary><div class="matches">${ko.map(m => matchCard(night, m, { stage: true })).join('')}</div></details></section>`;
  }
  const order = playOrder(night);
  groupTables(night).forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    const ms = order.filter(m => m.stage === label);
    h += `<section class="card flush"><h2>${groupName(night, label)}</h2>${groupTable(night, t)}
      <div class="pad"><details class="more"><summary>Results (${ms.filter(E.isSettled).length} of ${ms.length})</summary>
      <div class="matches">${ms.map(m => matchCard(night, m, { prefix: queueLabel(night, order, m) })).join('')}</div></details></div></section>`;
  });
  h += `<section class="card"><h2>Rating changes${night.closed ? '' : ' <small>provisional</small>'}</h2>${changesList(night)}</section>`;
  return h;
}

function tournamentHero(night, info) {
  const d = [...info.details.values()];
  const points = d.reduce((s, x) => s + x.pointsWon + x.pointsLost, 0);
  let champ;
  if (info.champion) {
    champ = `<div class="champ">${trophy('trophy hero')}<small>Winner</small>
      <a href="${playerHref(info.champion)}"><b>${esc(nameOf(info.champion))}</b></a>
      <span class="runner">Runner-up <a href="${playerHref(info.runnerUp)}">${esc(nameOf(info.runnerUp))}</a>${info.third ? ` · 3rd <a href="${playerHref(info.third)}">${esc(nameOf(info.third))}</a>` : ''}</span></div>`;
  } else if (night.closed) {
    champ = '<div class="champ"><small>No final recorded</small></div>';
  } else {
    const p = progress(night);
    champ = `<div class="champ"><span class="tag live">Live</span><b>${p.done} of ${p.total} played</b></div>`;
  }
  return `<section class="card night-hero"><div class="date">${fmtDate(night.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
    ${champ}<div class="facts"><div><b>${night.attendees.length}</b><span>Players</span></div><div><b>${d.length}</b><span>Matches</span></div>
    <div><b>${points.toLocaleString('en-GB')}</b><span>Points played</span></div></div></section>`;
}

function ratingChart(points) {
  const W = 340, H = 160, L = 34, R = 10, T = 10, B = 20;
  const ys = points.map(p => p.rating);
  let lo = Math.min(...ys, E.START_RATING), hi = Math.max(...ys, E.START_RATING);
  const pad = Math.max(8, (50 - (hi - lo)) / 2);
  lo -= pad; hi += pad;
  const x = i => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${H - B}L${x(0).toFixed(1)},${H - B}Z`;
  const label = v => `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
  const top = Math.max(...ys), bottom = Math.min(...ys);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating after each tournament">
    <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00a464" stop-opacity="0.22"/><stop offset="1" stop-color="#00a464" stop-opacity="0"/></linearGradient></defs>
    <line class="base" x1="${L}" x2="${W - R}" y1="${y(E.START_RATING).toFixed(1)}" y2="${y(E.START_RATING).toFixed(1)}"/>
    ${label(E.START_RATING)}${top - E.START_RATING > 14 ? label(top) : ''}${E.START_RATING - bottom > 14 ? label(bottom) : ''}
    <path class="area" d="${area}"/><path class="line" d="${line}"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rating).toFixed(1)}" r="${points.length > 24 ? 2 : 3.5}"><title>${esc(p.label)}: ${Math.round(p.rating)}</title></circle>`).join('')}
    <text x="${L}" y="${H - 4}">${esc(points[0].label)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(points.at(-1).label)}</text></svg>`;
}

function viewPlayer(id) {
  const p = app.data.players.find(x => x.id === id);
  if (!p) return notFound();
  const { table, inactive, history, nightsOf } = app.calc;
  const pos = table.findIndex(r => r.id === id);
  const row = table[pos] || inactive.find(r => r.id === id);
  const s = app.stats.players.get(id);
  const sub = row ? `${pos >= 0 ? `${ordinal(pos + 1)} in the table` : 'Not on the table'} · ${plural(row.nights, 'tournament')}` : 'No tournaments yet';
  let h = `<section class="card profile"><div><h1>${esc(p.name)}</h1><p class="sub">${sub}</p></div>
    ${row ? `<div class="rating-badge"><b>${Math.round(row.rating)}</b><small>Rating</small></div>` : ''}</section>`;
  if (!row) return h;

  h += `<div class="tiles">${tile('Score', Math.round(row.ladder))}${tile('Bonus', signed(row.bonus, 0))}${tile('Won–lost', s ? `${s.won}–${s.lost}` : '0–0')}
    ${tile('Win rate', s?.played ? pct(s.winPct) : '–')}${tile('Titles', s?.titles ?? 0)}${tile('Best streak', s?.bestStreak ?? 0)}</div>`;
  const left = E.NEW_PLAYER_NIGHTS - nightsOf(id);
  h += `<p class="foot">Attendance bonus over the last 8 tournaments: ${row.attended} attended (${signed(5 * row.attended, 0)}), ${row.missed} missed (${signed(-5 * row.missed, 0)}).${left > 0 ? ` New player: rating changes are tripled for ${plural(left, 'more tournament')}.` : ''}</p>`;

  if (s?.results.length) h += `<section class="card"><h2>Form <small>last ${Math.min(10, s.results.length)}</small></h2>${formPills(s.results, 10, true)}</section>`;
  const hist = history.get(id) || [];
  if (hist.length) {
    h += `<section class="card"><h2>Rating</h2>${ratingChart([{ label: 'Start', rating: E.START_RATING }, ...hist.map(x => ({ label: shortDate(x.date), rating: x.rating }))])}</section>`;
  }
  if (s?.played) h += highlights(s) + headToHead(s);
  return h + playerMatches(id);
}

function highlights(s) {
  const rows = [];
  const hl = (id, k, v, right = '') => `<a class="hl" href="${playerHref(id)}"><div><div class="k">${k}</div><div class="v">${v}</div></div>${right}</a>`;
  if (s.bestWin) {
    const r = s.bestWin;
    rows.push(hl(r.opp, 'Best win', `Beat ${esc(nameOf(r.opp))} ${r.d.gamesWon}–${r.d.gamesLost} · ${pct(r.d.expected)} chance`, chg(r.change)));
  }
  if (s.nemesis) {
    const [opp, rec] = s.nemesis;
    rows.push(hl(opp, 'Toughest opponent', `${esc(nameOf(opp))} · won ${rec.w}, lost ${rec.l}`));
  }
  const fav = [...s.h2h].filter(([, r]) => r.w > 0).sort(([, a], [, b]) => (b.w - b.l) - (a.w - a.l) || b.w - a.w)[0];
  if (fav) rows.push(hl(fav[0], 'Favourite opponent', `${esc(nameOf(fav[0]))} · won ${fav[1].w}, lost ${fav[1].l}`));
  return rows.length ? `<section class="card"><h2>Highlights</h2><div class="highlights">${rows.join('')}</div></section>` : '';
}

function headToHead(s) {
  const opps = [...s.h2h].sort(([, a], [, b]) => (b.w + b.l) - (a.w + a.l) || b.w - a.w);
  const row = ([opp, r]) => `<a class="h2h-row" href="${playerHref(opp)}">${who(opp, plural(r.w + r.l, 'match', 'matches'))}
    <span class="rec">${r.w}–${r.l}</span><span class="split"><span style="width:${(100 * r.w) / (r.w + r.l)}%"></span></span></a>`;
  const rest = opps.slice(6);
  return `<section class="card"><h2>Head-to-head <small>won–lost</small></h2>${opps.slice(0, 6).map(row).join('')}
    ${rest.length ? `<details class="more"><summary>All opponents (${opps.length})</summary>${rest.map(row).join('')}</details>` : ''}</section>`;
}

function playerMatches(id) {
  const blocks = [];
  for (const night of [...app.calc.nights].reverse()) {
    const ms = night.matches.filter(m => (m.a === id || m.b === id) && (E.outcome(m) || m.unfinished));
    if (!ms.length) continue;
    blocks.push(`<div class="night-sub"><a href="${nightHref(night.id)}">${dayDate(night.date)}</a>${night.closed ? '' : '<span class="tag live">Live</span>'}</div>
      <div class="matches">${ms.map(m => matchCard(night, m, { stage: true })).join('')}</div>`);
  }
  if (!blocks.length) return '';
  return `<section class="card"><h2>Matches</h2>${blocks[0]}
    ${blocks.length > 1 ? `<details class="more"><summary>Earlier tournaments (${blocks.length - 1})</summary>${blocks.slice(1).join('')}</details>` : ''}</section>`;
}

function viewStats() {
  const { players, upsets, nightGains, totals } = app.stats;
  let h = '<section class="page-head"><h1>Stats</h1>';
  if (!totals.fridays) return h + '</section><p class="empty">Stats appear after the first tournament.</p>';
  h += `<p class="sub">${plural(totals.fridays, 'tournament')} so far</p></section>`;
  h += `<div class="tiles">${tile('Matches', totals.matches)}${tile('Games', totals.games)}${tile('Points', totals.points.toLocaleString('en-GB'))}</div>`;
  const all = [...players.values()];
  const regular = all.filter(s => s.played >= 8);
  h += leaderCard('Tournament wins', all, s => s.titles, v => v);
  h += leaderCard('Most wins', all, s => s.won, v => v);
  h += leaderCard('Win rate', regular, s => s.winPct, pct, 'min. 8 matches');
  h += leaderCard('Longest winning streak', all, s => s.bestStreak, v => v);
  h += leaderCard('Share of points won', regular, s => s.avgShare, pct, 'min. 8 matches');
  if (upsets.length) {
    h += `<section class="card"><h2>Biggest upsets <small>chance of winning</small></h2>${upsets.slice(0, 5).map((u, i) => `
      <a class="list-row upset${i === 0 ? ' lead' : ''}" href="${nightHref(u.night.id)}"><span class="rk">${i + 1}</span>
      ${who(u.d.winner, `beat ${esc(nameOf(u.d.loser))} ${u.d.gamesWon}–${u.d.gamesLost} · ${shortDate(u.night.date)}`)}
      <span class="val">${pct(u.d.expected)}<small>${signed(u.d.gain)}</small></span></a>`).join('')}</section>`;
  }
  if (nightGains.length) {
    h += `<section class="card"><h2>Best tournaments <small>rating gained</small></h2>${nightGains.slice(0, 5).map((g, i) => `
      <a class="list-row${i === 0 ? ' lead' : ''}" href="${nightHref(g.night.id)}"><span class="rk">${i + 1}</span>
      ${who(g.id, dayDate(g.night.date))}<span class="val up">${signed(g.change)}</span></a>`).join('')}</section>`;
  }
  h += leaderCard('Finals reached', all, s => s.finals, v => v);
  h += leaderCard('Most 2-0 wins', all, s => s.twoNil, v => v);
  h += leaderCard('Most tournaments played', all, s => s.nights, v => v);
  return h;
}

function leaderCard(title, list, value, fmt, note = '') {
  const top = list.filter(s => value(s) > 0).sort((a, b) => value(b) - value(a)).slice(0, 5);
  if (!top.length) return '';
  return `<section class="card"><h2>${title}${note ? ` <small>${note}</small>` : ''}</h2>${top.map((s, i) => `
    <a class="list-row${i === 0 ? ' lead' : ''}" href="${playerHref(s.id)}"><span class="rk">${i + 1}</span>${who(s.id)}
    <span class="val">${fmt(value(s))}</span></a>`).join('')}</section>`;
}

function viewRules() {
  return `<section class="page-head"><h1>How it works</h1></section>
  <section class="card prose"><h2>Ratings</h2>
    <p>Everyone starts at 1000. After every match the winner takes points from the loser:</p>
    <pre class="formula">Expected = 1/(1 + 10^((L − W)/400))
Change   = K × Weight × (1 − Expected)</pre>
    <p>W and L are the winner's and loser's ratings. <b>Expected</b> is how likely the winner was to win, so beating someone rated higher is worth more. <b>K</b> is 16, or 48 for a player's first 4 tournaments so new players find their level quickly. Ratings update once at the end of the tournament, using the ratings everyone arrived with.</p></section>
  <section class="card prose"><h2>Weight: how convincing the win was</h2>
    <pre class="formula">Share = winner's points / all points
2-0: Weight = 1 + 2 × (Share − 0.5)
     kept between 1.0 and 1.5
2-1: Weight = 0.75 + (Share − 0.5)
     kept between 0.75 and 0.95</pre>
    <p>Any 2-0 counts more than any 2-1, and the winner always gains.</p></section>
  <section class="card prose"><h2>The table</h2>
    <p>Score = rating + attendance bonus. The bonus counts the last 8 tournaments: +5 for each one attended, −5 for each one missed (only since your first one), so it runs from −40 to +40.</p>
    <p>Your rating never drops while you're away; it just stops being tested. The bonus is what moves regulars above equally good players who come less often. No tournament in the last 8 takes you off the table, but your rating is kept for when you return.</p>
    <p>Finishing places (winner, runner-up, 3rd) are honours, shown as ★ titles and on each tournament. They don't add points: the rating already counts every match it took to get there.</p></section>
  <section class="card prose"><h2>A tournament</h2>
    <p>From 4 players: two groups, seeded by the table in a snake (1st, 4th, 5th, 8th… in A; 2nd, 3rd, 6th, 7th… in B) so both are equally strong. Then semis A1 v B2 and B1 v A2, a 3rd place match between the semi losers, and the final. Every match is rated the same way. With fewer than 4 players: one group, then a final between the top 2. Group places go by matches won, then head-to-head, then game difference, then points difference.</p></section>
  <section class="card"><h2>Try a match</h2>
    <form class="calc" id="calc">
      <label class="field">Player A rating <input name="ra" type="number" value="1000" inputmode="numeric"></label>
      <label class="field">Player B rating <input name="rb" type="number" value="1000" inputmode="numeric"></label>
      <label class="field">A's K <select name="ka"><option>16</option><option>48</option></select></label>
      <label class="field">B's K <select name="kb"><option>16</option><option>48</option></select></label>
      <label class="field span">Score, A's points first <input name="score" value="11-9, 9-11, 11-9" autocomplete="off"></label>
    </form>
    <div id="calcOut" class="working">${calcWorking(new FormData())}</div></section>
  <p class="foot"><a href="#/settings">Recorder sign-in</a></p>`;
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
  const weightLine = o.gamesLost ? `0.75 + (${f(share)} − 0.5) = ${f(raw)}` : `1 + 2 × (${f(share)} − 0.5) = ${f(raw)}`;
  const kept = Math.abs(raw - w) > 1e-9 ? `\n         kept within ${o.gamesLost ? '0.75–0.95' : '1.0–1.5'} = ${f(w)}` : '';
  return `<p class="result">${o.winner} wins ${o.gamesWon}-${o.gamesLost}</p>
  <pre class="formula">Expected = 1/(1 + 10^((${rl} − ${rw})/400)) = ${f(exp)}
Share    = ${o.pointsWon} / ${o.pointsWon + o.pointsLost} = ${f(share)}
Weight   = ${weightLine}${kept}
Winner   = ${kw} × ${f(w)} × (1 − ${f(exp)}) = <span class="up">${signed(kw * w * (1 - exp))}</span>
Loser    = ${kl} × ${f(w)} × (1 − ${f(exp)}) = <span class="down">${signed(-kl * w * (1 - exp))}</span></pre>`;
}

// ---------- recording ----------

function viewRecord() {
  if (!app.recorder) {
    return '<section class="page-head"><h1>Record</h1></section><p class="empty">Recording needs a sign-in on this phone. <a href="#/settings">Set it up in Settings</a>.</p>';
  }
  const night = openNight();
  if (!night) return startForm();
  return app.edit?.nightId === night.id ? editForm(night) : desk(night);
}

function playerChecklist(picked, attr) {
  const { ratingOf, nightsOf } = app.calc;
  const players = [...app.data.players].sort((a, b) => a.name.localeCompare(b.name));
  if (!players.length) return '<p class="muted">No players yet. Add everyone who\'s here below.</p>';
  return `<div class="checklist">${players.map(p => `<label><input type="checkbox" ${attr}="${esc(p.id)}"${picked.has(p.id) ? ' checked' : ''}>
    <span>${esc(p.name)}</span><small>${nightsOf(p.id) ? Math.round(ratingOf(p.id)) : 'new'}</small></label>`).join('')}</div>`;
}

function startForm() {
  if (!app.draft) app.draft = { date: today(), picked: new Set() };
  return `<section class="page-head"><h1>Start a tournament</h1><p class="sub">Tick who's playing. You can change players and groups later.</p></section>
    <section class="card"><label class="field">Date <input type="date" id="nightDate" value="${esc(app.draft.date)}"></label></section>
    <section class="card"><h2>Who's playing?</h2>${playerChecklist(app.draft.picked, 'data-pick')}
      <form class="row add-row" data-form="addPlayer"><input name="name" placeholder="New player's name" autocomplete="off" required><button>Add</button></form></section>
    <p id="plan" class="plan foot">${planText(app.draft.picked.size)}</p>
    <button class="primary wide" data-act="startNight">Start tournament</button>`;
}

function planText(n) {
  if (n < 2) return 'Tick at least 2 players.';
  return `${plural(n, 'player')}: ${groupPlan(n)}.`;
}

function desk(night) {
  const tables = groupTables(night);
  const p = progress(night);
  let h = `<section class="page-head head-row"><div><h1>Live tournament</h1><p class="sub">${dayDate(night.date)} · ${plural(night.attendees.length, 'player')}</p></div>
    <button data-act="editStart">Edit</button></section>
    <section class="card"><div class="between"><b>${p.done} of ${p.total} matches played</b><span class="tag live">Live</span></div>
    <div class="bar"><span style="width:${p.pct}%"></span></div></section>`;
  h += upNext(night, { editable: true, withKnockout: false });
  const order = playOrder(night);
  tables.forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    const ms = groupMatches(night, label);
    const done = order.filter(m => m.stage === label && E.isSettled(m));
    h += `<section class="card flush"><h2>${groupName(night, label)} <small>${done.length}/${ms.length} played</small></h2>${groupTable(night, t)}
      ${done.length ? `<div class="pad"><details class="more"><summary>Played (${done.length}) · tap one to correct it</summary><div class="matches">${done.map(m => matchCard(night, m, { editable: true, prefix: queueLabel(night, order, m) })).join('')}</div></details></div>` : ''}</section>`;
  });

  const semis = night.matches.filter(m => m.stage === 'SF');
  const final = night.matches.find(m => m.stage === 'F');
  const fresh = m => !hasResult(m);
  let ko = '';
  if (semis.length) {
    const want = E.semiPairs(tables);
    const same = want && semis.every((m, i) => m.a === want[i][0] && m.b === want[i][1]);
    if (!same && semis.every(fresh) && !final) ko += '<p class="notice">Group results changed after the semis were made. Redo them to match the tables.</p>';
    ko += `<div class="matches">${semis.map((m, i) => `<div class="stage-label">Semi-final ${i + 1}</div>${matchCard(night, m, { editable: true })}`).join('')}</div>`;
  }
  const playoff = night.matches.find(m => m.stage === '3P');
  if (playoff) ko += `<div class="matches"><div class="stage-label">3rd place match</div>${matchCard(night, playoff, { editable: true })}</div>`;
  if (final) ko += `<div class="matches"><div class="stage-label">Final</div>${matchCard(night, final, { editable: true })}</div>`;
  const buttons = [];
  const canSemis = E.semiPairs(tables);
  if (!semis.length && !final) {
    buttons.push(canSemis
      ? '<button class="primary" data-act="makeSemis">Make semi-finals</button>'
      : '<button class="primary" data-act="makeFinal">Make final</button>');
  }
  if (semis.length && !final) {
    if (semis.every(m => E.outcome(m))) buttons.push('<button class="primary" data-act="makeFinal">Make final and 3rd place match</button>');
    if (semis.every(fresh)) buttons.push('<button data-act="redoSemis">Redo semi-finals</button>');
  }
  if (final && fresh(final) && (!playoff || fresh(playoff))) buttons.push(`<button data-act="redoFinal">Redo final${playoff ? ' and 3rd place match' : ''}</button>`);
  if (buttons.length) ko += `<div class="row ko-buttons">${buttons.join('')}</div>`;
  h += `<section class="card"><h2>Knockout</h2>${ko || ''}</section>`;
  h += `<details class="card"><summary>Rating changes so far</summary><p class="muted">Applied when you finish the tournament.</p>${changesList(night)}</details>`;
  h += '<button class="primary wide" data-act="closeNight">Finish tournament and update ratings</button>';
  return h;
}

// ----- editing a live tournament: date, players, groups -----

function startEdit(night) {
  app.edit = {
    nightId: night.id, date: night.date,
    picked: new Set(night.attendees),
    groups: night.groups.map(g => [...g]),
  };
}

// New fixtures for the edited groups. A result already entered is kept whenever the same
// two players are still in the same group; the knockout is reset if anything changed.
function planRebuild(night, groups) {
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const played = new Map(night.matches.filter(m => E.isGroupStage(m.stage) && hasResult(m)).map(m => [key(m.a, m.b), m]));
  const kept = new Set();
  const matches = [];
  groups.forEach((g, gi) => {
    const label = E.GROUP_LABELS[gi];
    E.roundRobin(g).forEach(([a, b], i) => {
      const prev = played.get(key(a, b));
      if (prev) kept.add(key(a, b));
      matches.push(prev ? { ...prev, id: `${label}${i + 1}`, stage: label } : { id: `${label}${i + 1}`, stage: label, a, b });
    });
  });
  const ko = night.matches.filter(m => !E.isGroupStage(m.stage));
  const same = JSON.stringify(groups.map(g => [...g].sort())) === JSON.stringify(night.groups.map(g => [...g].sort()));
  return { same, matches, dropped: played.size - kept.size, koResults: ko.filter(hasResult).length, koCount: ko.length };
}

function editForm(night) {
  const e = app.edit;
  const two = e.groups.length === 2;
  const plan = planRebuild(night, e.groups);
  let impact;
  if (plan.same) impact = 'Groups unchanged.';
  else {
    impact = `${plural(plan.matches.length, 'group match', 'group matches')} after saving.`;
    if (plan.dropped) impact += ` <b>${plural(plan.dropped, 'result')} will be removed</b> (players no longer in the same group).`;
    if (plan.koCount) impact += ` The knockout will be reset${plan.koResults ? ` and its ${plural(plan.koResults, 'result')} removed` : ''}.`;
  }
  const groupRows = two
    ? [...e.picked].sort(byName).map(id => {
      const g = e.groups[0].includes(id) ? 0 : 1;
      return `<div class="grp-row"><span>${esc(nameOf(id))}</span><span class="seg small">
        <button class="${g === 0 ? 'on' : ''}" data-act="editMove" data-id="${esc(id)}" data-g="0">A</button>
        <button class="${g === 1 ? 'on' : ''}" data-act="editMove" data-id="${esc(id)}" data-g="1">B</button></span></div>`;
    }).join('')
    : '';
  return `<section class="page-head"><h1>Edit tournament</h1><p class="sub">Nothing changes until you tap Save.</p></section>
    <section class="card"><label class="field">Date <input type="date" id="editDate" value="${esc(e.date)}"></label></section>
    <section class="card"><h2>Players <small>${plural(e.picked.size, 'playing', 'playing')}</small></h2>${playerChecklist(e.picked, 'data-edit-pick')}
      <form class="row add-row" data-form="editAddPlayer"><input name="name" placeholder="New player's name" autocomplete="off" required><button>Add</button></form></section>
    <section class="card"><h2>Groups <small>${two ? `A: ${e.groups[0].length} · B: ${e.groups[1].length}` : `${e.groups[0].length} players`}</small></h2>
      <div class="seg wide-seg"><button class="${two ? 'on' : ''}" data-act="editFormat" data-n="2">Two groups</button><button class="${two ? '' : 'on'}" data-act="editFormat" data-n="1">One group</button></div>
      ${two ? `<div class="grp-list">${groupRows}</div>` : '<p class="muted">Everyone plays everyone. With 4 or more players the top 4 go to the semis (1v4, 2v3).</p>'}
      <button class="small redraw" data-act="editRedraw">Redraw groups from the table</button></section>
    <p class="notice">${impact}</p>
    <div class="btn-pair"><button data-act="editCancel">Cancel</button><button class="primary" data-act="editSave">Save changes</button></div>
    <section class="card"><h2>Delete tournament</h2><p class="muted">Removes this tournament and all its results.</p>
      <button class="danger wide" data-act="deleteNight" data-night="${esc(night.id)}">Delete tournament</button></section>`;
}

function editTogglePlayer(id, on) {
  const e = app.edit;
  if (on) {
    e.picked.add(id);
    const sizes = e.groups.map(g => g.length);
    e.groups[sizes.indexOf(Math.min(...sizes))].push(id);
  } else {
    e.picked.delete(id);
    e.groups = e.groups.map(g => g.filter(x => x !== id));
  }
}

function viewSettings() {
  const r = app.recorder;
  let h = '<section class="page-head"><h1>Settings</h1></section>';
  if (r) {
    h += `<section class="card stack"><h2>Recorder</h2>
      <p>This phone records results to <b>${esc(r.cfg.repo)}</b>.</p>
      <p>${syncText()}${r.detail ? `<br><span class="muted">${esc(r.detail)}</span>` : ''}</p>
      <div class="row">
        ${r.dirty ? '<button class="primary" data-act="syncNow">Upload now</button>' : ''}
        ${r.status === 'conflict' ? '<button data-act="overwrite">Overwrite GitHub</button><button data-act="discard">Discard this phone\'s changes</button>' : ''}
        <button data-act="signOut">Sign out on this phone</button>
      </div></section>`;
    const players = [...app.data.players].sort((a, b) => a.name.localeCompare(b.name));
    h += `<section class="card"><h2>Players</h2><ul class="plain">${players.map(x => `<li class="between">${who(x.id)}
      <span class="row nowrap-row"><button class="small" data-act="rename" data-id="${esc(x.id)}">Rename</button>${playerUsed(x.id) ? '' : `<button class="small danger" data-act="deletePlayer" data-id="${esc(x.id)}">Delete</button>`}</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul></section>`;
  } else {
    h += `<section class="card"><h2>Recorder sign-in</h2>
      <p class="muted" style="margin-bottom:12px">Only the person recording results needs this. Viewing the ranking needs nothing.</p>
      <form class="stack" data-form="signIn">
        <label class="field">GitHub repository (owner/name) <input name="repo" value="${esc(guessRepo())}" placeholder="yourname/tabletennis" required autocomplete="off" autocapitalize="off"></label>
        <label class="field">Branch <input name="branch" value="main" required autocapitalize="off"></label>
        <label class="field">Data file <input name="path" value="docs/data.json" required autocapitalize="off"></label>
        <label class="field">Access token <input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
        <p class="muted">The token is kept only on this phone. Make it a fine-grained token limited to this one repository with "Contents: read and write" permission.</p>
        <button class="primary">Sign in</button>
        <p id="signInError" class="warn"></p>
      </form></section>`;
  }
  if (app.data) h += '<section class="card stack"><h2>Backup</h2><p class="muted">GitHub keeps every version, but you can also download the data.</p><div><button data-act="download">Download data.json</button></div></section>';
  return h;
}

const playerUsed = id => app.data.nights.some(n => n.attendees.includes(id) || n.matches.some(m => m.a === id || m.b === id));

function guessRepo() {
  const host = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return host && repo ? `${host[1]}/${repo}` : '';
}

const notFound = () => '<p class="empty">Not found. <a href="#/">Back to the table</a></p>';

// ---------- rendering ----------

const routes = [
  [/^#?\/?$/, viewTable, 'table'],
  [/^#\/player\/(.+)$/, viewPlayer, 'table'],
  [/^#\/(?:tournaments|fridays|nights)$/, () => viewTournaments(), 'tournaments'],
  [/^#\/(?:tournament|night)\/(.+)$/, viewNight, 'tournaments'],
  [/^#\/stats$/, viewStats, 'stats'],
  [/^#\/record$/, viewRecord, 'record'],
  [/^#\/rules$/, viewRules, 'rules'],
  [/^#\/settings$/, viewSettings, ''],
];

function render() {
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash));
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', route?.[2] === a.dataset.nav));
  document.querySelector('[data-nav="record"]').hidden = !app.recorder;
  renderSync();
  const notice = app.notice ? `<p class="notice">${esc(app.notice)}</p>` : '';
  if (!app.data && hash !== '#/settings') {
    view.innerHTML = notice || '<p class="empty">Loading…</p>';
    return;
  }
  view.innerHTML = notice + (route ? route[1](...hash.match(route[0]).slice(1).map(decodeURIComponent)) : notFound());
  const strip = document.getElementById('strip');
  const active = strip?.querySelector('.active');
  if (active) strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
}

function syncText() {
  return {
    saved: 'All results uploaded.',
    pending: 'Saved on this phone. Uploads within 5 minutes (tap to upload now).',
    saving: 'Uploading…',
    offline: 'Offline: saved on this phone.',
    conflict: 'Not uploaded: GitHub has a newer version.',
    error: 'Not uploaded: GitHub refused the save.',
  }[app.recorder.status];
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
// A compact box pinned to the top of the screen, so it stays above the phone keyboard.

function openScore(nightId, matchId) {
  const night = findNight(nightId);
  const m = night.matches.find(x => x.id === matchId);
  const g = i => m.games?.[i] ?? ['', ''];
  const info = app.calc.nightInfo.get(nightId);
  dialog.dataset.night = nightId;
  dialog.dataset.match = matchId;
  dialog.innerHTML = `<form method="dialog" class="sheet" autocomplete="off">
    <div class="sheet-bar"><button class="primary small" data-act="saveScore">Save</button><b>${stageName(night, m)}</b><button class="small plain-btn" value="cancel" formnovalidate>Cancel</button></div>
    <div class="score-grid">
      <span></span><b>${esc(nameOf(m.a))}${startRating(info, m.a)}</b><b>${esc(nameOf(m.b))}${startRating(info, m.b)}</b>
      ${[0, 1, 2].map(i => `<span>G${i + 1}</span>
        <input data-g="${i}" data-s="0" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[0]}" aria-label="Game ${i + 1} ${esc(nameOf(m.a))}">
        <input data-g="${i}" data-s="1" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[1]}" aria-label="Game ${i + 1} ${esc(nameOf(m.b))}">`).join('')}
    </div>
    <p class="preview" id="scorePreview"></p>
    <details><summary>Walkover, unfinished or clear</summary>
      <div class="row">
        <button class="small" data-act="walkover" data-id="${esc(m.a)}">W/O to ${esc(nameOf(m.a))}</button>
        <button class="small" data-act="walkover" data-id="${esc(m.b)}">W/O to ${esc(nameOf(m.b))}</button>
        <button class="small" data-act="unfinished">Unfinished</button>
        <button class="small danger" data-act="clearScore">Clear</button>
      </div>
      <p class="muted tiny">Walkovers and unfinished matches don't change ratings. A walkover counts as a win in the group table.</p>
    </details>
  </form>`;
  dialog.showModal();
  scorePreview();
  if (!m.games) dialog.querySelector('input').focus({ preventScroll: true });
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
    out.textContent = showError || games?.length >= 2 ? error : 'Each game: left player\'s points on the left.';
    return;
  }
  const o = E.outcome({ ...m, games });
  const info = app.calc.nightInfo.get(night.id);
  const share = o.pointsWon / (o.pointsWon + o.pointsLost);
  const w = E.weightFor(o.gamesLost, share);
  const base = w * (1 - E.expected(info.start.get(o.winner), info.start.get(o.loser)));
  out.className = 'preview';
  out.innerHTML = `<b>${esc(nameOf(o.winner))} wins ${o.gamesWon}-${o.gamesLost}</b> · ${esc(nameOf(o.winner))} ${chg(info.k.get(o.winner) * base)} ${esc(nameOf(o.loser))} ${chg(-info.k.get(o.loser) * base)}`;
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

function fixtures(groups) {
  return groups.flatMap((g, gi) => E.roundRobin(g).map(([a, b], i) => ({ id: `${E.GROUP_LABELS[gi]}${i + 1}`, stage: E.GROUP_LABELS[gi], a, b })));
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
    if (app.data.nights.some(n => n.date === date)) return alert(`There's already a tournament on ${fmtDate(date)}.`);
    if (ids.length < 2) return alert('Tick at least 2 players.');
    const groups = drawGroups(ids);
    const night = { id: date, date, closed: false, attendees: ids, groups, matches: fixtures(groups) };
    app.draft = null;
    update(`Start tournament ${date} (${ids.length} players)`, d => d.nights.push(night));
  },

  makeSemis: () => {
    const night = openNight();
    const pending = night.matches.filter(m => E.isGroupStage(m.stage) && !E.isSettled(m)).length;
    if (pending && !confirm(`${plural(pending, 'group match', 'group matches')} still ${pending === 1 ? 'has' : 'have'} no result. Make the semis from the tables as they are now?`)) return;
    const pairs = E.semiPairs(groupTables(night));
    if (!pairs) return alert('Each group needs at least 2 players for semi-finals.');
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
    if (!semis.length) {
      const [a, b] = groupTables(night).flat().slice(0, 2).map(r => r.id);
      update(`${night.date}: final made`, () => night.matches.push({ id: 'F', stage: 'F', a, b }), { throttle: true });
      return;
    }
    const results = semis.map(m => E.outcome(m));
    update(`${night.date}: final and 3rd place match made`, () => {
      night.matches.push({ id: '3P', stage: '3P', a: results[0].loser, b: results[1].loser });
      night.matches.push({ id: 'F', stage: 'F', a: results[0].winner, b: results[1].winner });
    }, { throttle: true });
  },
  redoFinal: () => {
    const night = openNight();
    update(`${night.date}: final removed`, () => { night.matches = night.matches.filter(m => m.stage !== 'F' && m.stage !== '3P'); }, { throttle: true });
  },

  closeNight: () => {
    const night = openNight();
    const pending = night.matches.filter(m => !E.isSettled(m)).length;
    const msg = `Finish the ${fmtDate(night.date)} tournament and update everyone's ratings?` +
      (pending ? `\n\n${plural(pending, 'match', 'matches')} with no result won't count.` : '') +
      (night.matches.some(m => m.stage === 'F') ? '' : '\n\nThere is no final yet, so there will be no winner.');
    if (!confirm(msg)) return;
    update(`Finish tournament ${night.date}`, () => { night.closed = true; });
    location.hash = nightHref(night.id);
  },
  reopenNight: el => {
    if (openNight()) return alert('Another tournament is still in progress. Finish or delete it first.');
    const night = findNight(el.dataset.night);
    if (!confirm(`Reopen the ${fmtDate(night.date)} tournament? Its rating changes are taken back until you finish it again.`)) return;
    update(`Reopen tournament ${night.date}`, () => { night.closed = false; });
    location.hash = '#/record';
  },
  deleteNight: el => {
    const night = findNight(el.dataset.night);
    if (!confirm(`Delete the ${fmtDate(night.date)} tournament and all its results? This can't be undone here (GitHub keeps the old version).`)) return;
    app.edit = null;
    update(`Delete tournament ${night.date}`, d => { d.nights = d.nights.filter(n => n !== night); });
    location.hash = night.closed ? '#/tournaments' : '#/record';
  },

  editStart: () => { startEdit(openNight()); render(); window.scrollTo(0, 0); },
  editCancel: () => { app.edit = null; render(); window.scrollTo(0, 0); },
  editMove: el => {
    const e = app.edit, id = el.dataset.id, g = +el.dataset.g;
    e.groups = e.groups.map(x => x.filter(y => y !== id));
    e.groups[g].push(id);
    render();
  },
  editFormat: el => {
    const e = app.edit;
    const ids = [...e.picked];
    const score = rankScore();
    if (+el.dataset.n === 1) e.groups = [ids.sort((a, b) => score(b) - score(a))];
    else if (ids.length < 4) return alert('Two groups need at least 4 players.');
    else e.groups = drawGroups(ids);
    render();
  },
  editRedraw: () => {
    const e = app.edit;
    const score = rankScore();
    e.groups = e.groups.length === 2 && e.picked.size >= 4
      ? drawGroups([...e.picked])
      : [[...e.picked].sort((a, b) => score(b) - score(a))];
    render();
  },
  editSave: () => {
    const e = app.edit;
    const night = findNight(e.nightId);
    if (!e.date) return alert('Pick the date.');
    if (app.data.nights.some(n => n !== night && n.date === e.date)) return alert(`There's already a tournament on ${fmtDate(e.date)}.`);
    if (e.picked.size < 2) return alert('A tournament needs at least 2 players.');
    if (e.groups.length === 2 && e.groups.some(g => g.length < 2)) return alert('Each group needs at least 2 players.');
    const plan = planRebuild(night, e.groups);
    const losses = [plan.dropped ? plural(plan.dropped, 'group result') : '', !plan.same && plan.koResults ? plural(plan.koResults, 'knockout result') : ''].filter(Boolean);
    if (losses.length && !confirm(`Saving removes ${losses.join(' and ')}. Continue?`)) return;
    const added = [...e.picked].filter(id => !night.attendees.includes(id)).length;
    const removed = night.attendees.filter(id => !e.picked.has(id)).length;
    update(`Edit tournament ${e.date}${added ? ` +${added}` : ''}${removed ? ` −${removed}` : ''}${plan.same ? '' : ', groups changed'}`, () => {
      night.date = e.date;
      night.attendees = [...e.picked];
      if (!plan.same) {
        night.groups = e.groups.map(g => [...g]);
        night.matches = plan.matches;
      }
    });
    app.edit = null;
    render();
    window.scrollTo(0, 0);
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
  editAddPlayer: form => {
    const id = addPlayer(form.name.value);
    if (!id) return;
    editTogglePlayer(id, true);
    update(`Add player ${nameOf(id)}`, () => {}, { throttle: true });
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
  if (e.target.id === 'editDate') app.edit.date = e.target.value;
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset?.pick !== undefined) {
    t.checked ? app.draft.picked.add(t.dataset.pick) : app.draft.picked.delete(t.dataset.pick);
    document.getElementById('plan').innerHTML = planText(app.draft.picked.size);
  }
  if (t.dataset?.editPick !== undefined) {
    editTogglePlayer(t.dataset.editPick, t.checked);
    render();
  }
});

// Tapping the dimmed area around the score box closes it.
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

window.addEventListener('hashchange', () => {
  if (location.hash !== '#/record') app.edit = null;
  render();
  window.scrollTo(0, 0);
});

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
