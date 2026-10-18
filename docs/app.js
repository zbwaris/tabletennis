import * as E from './engine.js';
import { buildStats } from './stats.js';
import { loadPublished, loadConfig, saveConfig, forgetConfig, getFile, Recorder } from './store.js';

const view = document.getElementById('view');
const dialog = document.getElementById('scoreDialog');
const app = {
  data: null, calc: null, stats: null, prevPos: new Map(), names: new Map(),
  recorder: null, notice: '', draft: null,
};

// ---------- helpers ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => app.names.get(id) ?? 'Unknown';
const playerHref = id => `#/player/${encodeURIComponent(id)}`;
const nightHref = id => `#/night/${encodeURIComponent(id)}`;
const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', opts);
const shortDate = d => fmtDate(d, { day: 'numeric', month: 'short' });
const dayDate = d => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
const signed = (x, dp = 1) => {
  const v = Number(x.toFixed(dp));
  return v === 0 ? (0).toFixed(dp) : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(dp);
};
const pct = x => `${Math.round(x * 100)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
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
const setsOf = (m, id) => m.games.filter(g => (id === m.a ? g[0] > g[1] : g[1] > g[0])).length;

// Player "crests": coloured initials, the same colour everywhere.
const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d',
  '#ea580c', '#4f46e5', '#0d9488', '#be123c', '#9333ea', '#0284c7'];
const colorOf = id => {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
const initials = name => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length > 1 ? w[0][0] + w.at(-1)[0] : (w[0] || '?')[0];
};
const avatar = (id, size = 28) =>
  `<span class="av" style="--s:${size}px;background:${colorOf(id)}" aria-hidden="true">${esc(initials(nameOf(id)))}</span>`;
const who = (id, sub = '', size = 28) =>
  `<span class="who">${avatar(id, size)}<span class="nm"><b>${esc(nameOf(id))}</b>${sub ? `<small>${sub}</small>` : ''}</span></span>`;
const chg = (x, dp = 1) => `<span class="chg ${x > 0.05 ? 'up' : x < -0.05 ? 'down' : 'flat'}">${signed(x, dp)}</span>`;
const formPills = (results, n = 5, big = false) =>
  `<span class="form${big ? ' big' : ''}">${results.slice(-n).map(r => `<i class="${r.won ? 'w' : 'l'}">${r.won ? 'W' : 'L'}</i>`).join('')}</span>`;
const tile = (label, value) => `<div class="tile"><span>${label}</span><b>${value}</b></div>`;
const trophy = '<svg class="trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v2h3v2a4 4 0 0 1-4 4h-.4A6 6 0 0 1 13 13.9V17h3v3H8v-3h3v-3.1A6 6 0 0 1 7.4 11H7a4 4 0 0 1-4-4V5h3V3Zm0 4H5a2 2 0 0 0 1.2 1.8L6 7Zm12 0-.2 1.8A2 2 0 0 0 19 7h-1Z"/></svg>';

function groupPlan(n) {
  if (n <= 10) return `one group of ${n}, top 4 to the semis`;
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

// Table positions before the last Friday, for the movement arrows.
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

function matchCard(night, m, { editable = false, stage = false } = {}) {
  const o = E.outcome(m);
  const d = app.calc.nightInfo.get(night.id)?.details.get(m.id);
  const side = (id, pos) => {
    const state = o ? (o.winner === id ? 'win' : 'lose') : '';
    const c = d ? (d.winner === id ? d.gain : -d.loss) : null;
    return `<span class="mc-side ${pos} ${state}">${avatar(id, 26)}<span class="nm"><b>${esc(nameOf(id))}</b>${c != null ? chg(c) : ''}</span></span>`;
  };
  let score = '<span class="mc-score vs">VS</span>';
  if (o?.rated) score = `<span class="mc-score"><b>${setsOf(m, m.a)}</b><span>–</span><b>${setsOf(m, m.b)}</b></span>`;
  else if (m.walkover) score = '<span class="mc-score vs">W/O</span>';
  let line = m.walkover ? `Walkover to ${esc(nameOf(m.walkover))}`
    : m.unfinished ? 'Unfinished'
    : m.games ? m.games.map(g => g.join('-')).join(' · ')
    : editable ? '<span class="cta">Tap to enter score</span>' : 'Not played yet';
  if (stage && !E.isGroupStage(m.stage)) line = `${stageName(night, m)} · ${line}`;
  const body = `${side(m.a, 'a')}${score}${side(m.b, 'b')}<span class="mc-games">${line}</span>`;
  return editable
    ? `<button class="mc" data-act="score" data-night="${esc(night.id)}" data-match="${esc(m.id)}">${body}</button>`
    : `<div class="mc">${body}</div>`;
}

function groupTable(night, table) {
  const places = night.groups.length === 1 ? 4 : 2;
  const marks = night.attendees.length >= 4;
  return `<div class="gt-head"><span>#</span><span>Player</span><span>W</span><span>L</span><span>G±</span><span>P±</span></div>
    ${table.map(r => `<a class="gt-row${marks && r.pos <= places ? ' q' : ''}" href="${playerHref(r.id)}"><span>${r.pos}</span>
      <span class="who">${avatar(r.id, 22)}<b>${esc(nameOf(r.id))}</b></span>
      <span>${r.won}</span><span>${r.lost}</span><span>${signed(r.gd, 0)}</span><span>${signed(r.pd, 0)}</span></a>`).join('')}
    ${marks ? '<div class="legend">Semi-final places</div>' : ''}`;
}

function bracket(night) {
  const semis = night.matches.filter(m => m.stage === 'SF');
  const final = night.matches.find(m => m.stage === 'F');
  const box = (m, label) => {
    if (!m) {
      const tbd = '<div class="bm-row tbd"><span class="av" style="--s:20px;background:var(--line-2)"></span><b>To be decided</b><em></em></div>';
      return `<div class="bm"><div class="bm-label">${label}</div>${tbd}${tbd}</div>`;
    }
    const o = E.outcome(m);
    const mark = id => (m.games && o ? setsOf(m, id) : m.walkover === id ? 'W/O' : '');
    const row = id => `<a class="bm-row${o?.winner === id ? ' win' : ''}" href="${playerHref(id)}">${avatar(id, 20)}<b>${esc(nameOf(id))}</b><em>${mark(id)}</em></a>`;
    return `<div class="bm"><div class="bm-label">${label}</div>${row(m.a)}${row(m.b)}</div>`;
  };
  if (!semis.length) return box(final, 'Final');
  return `<div class="bracket">
    <div class="br-col semis">${box(semis[0], 'Semi-final 1')}${box(semis[1], 'Semi-final 2')}</div>
    <div class="br-join"></div><div class="br-stem"></div>
    <div class="br-col final">${box(final, `${trophy} Final`)}</div></div>`;
}

function changesList(night) {
  const info = app.calc.nightInfo.get(night.id);
  const ids = [...info.attendees].sort((a, b) => info.change.get(b) - info.change.get(a));
  return ids.map(id => {
    const start = info.start.get(id), c = info.change.get(id);
    const notes = [info.unbeaten === id ? 'unbeaten night' : '', info.k.get(id) === E.K_NEW ? 'new · changes ×3' : ''].filter(Boolean).join(' · ');
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
    <div class="row1"><b><span class="dot"></span>Tonight</b><span class="tag live">Live</span></div>
    <p class="muted">${plural(night.attendees.length, 'player')} · ${p.done} of ${p.total} matches played</p>
    <div class="bar"><span style="width:${p.pct}%"></span></div></a>`;
}

function dateStrip(activeId) {
  return `<nav class="strip" id="strip" aria-label="Fridays">${app.calc.nights.map(n => `<a class="chip${n.id === activeId ? ' active' : ''}" href="${nightHref(n.id)}">
    <small>${n.closed ? fmtDate(n.date, { weekday: 'short' }) : '<span class="dot"></span>Live'}</small><b>${shortDate(n.date)}</b></a>`).join('')}</nav>`;
}

// ---------- views ----------

function viewTable() {
  const { table, inactive, closed } = app.calc;
  const open = openNight();
  const last = closed.at(-1);
  let h = `<section class="page-head"><h1>Table</h1><p class="sub">${last ? `After ${plural(closed.length, 'Friday')} · last played ${dayDate(last.date)}` : 'No Fridays played yet'}</p></section>`;
  if (open) h += liveCard(open);
  if (last) h += lastFridayCard(last);
  if (table.length) {
    h += `<section class="card flush"><div class="lt-head"><span>#</span><span>Player</span><span class="form-col">Form</span><span>Score</span></div>
      ${table.map((r, i) => tableRow(r, i + 1)).join('')}</section>`;
  }
  if (inactive.length) {
    h += `<details class="card"><summary>Not on the table (${inactive.length})</summary>
      <p class="muted">No Friday in the last 8. Ratings are kept.</p>
      ${inactive.map(r => `<a class="list-row" href="${playerHref(r.id)}"><span></span>${who(r.id)}<span class="val">${Math.round(r.rating)}<small>rating</small></span></a>`).join('')}</details>`;
  }
  if (table.length) h += '<p class="foot">Score = rating + bonus (shown under each name). The bonus counts the last 8 Fridays: +5 for each one attended, −5 for each one missed, +10 for an unbeaten night. <a href="#/rules">How it works</a></p>';
  return h;
}

function tableRow(r, pos) {
  const prev = app.prevPos.get(r.id);
  const move = prev == null || prev === pos ? '' : prev > pos ? `<i class="up">▲${prev - pos}</i>` : `<i class="down">▼${pos - prev}</i>`;
  const tags = (r.nights < E.NEW_PLAYER_NIGHTS ? ' <span class="tag">new</span>' : '') +
    (r.unbeaten ? ` <span class="tag gold">★${r.unbeaten > 1 ? r.unbeaten : ''}</span>` : '');
  const sub = `${Math.round(r.rating)} ${r.bonus < 0 ? '−' : '+'} ${Math.abs(r.bonus)}`;
  return `<a class="lt-row p${pos}" href="${playerHref(r.id)}"><span class="pos">${pos}${move}</span>
    <span class="who">${avatar(r.id)}<span class="nm"><b>${esc(nameOf(r.id))}${tags}</b><small>${sub}</small></span></span>
    ${formPills(app.stats.players.get(r.id)?.results ?? [])}<span class="pts">${Math.round(r.ladder)}</span></a>`;
}

function lastFridayCard(night) {
  const info = app.calc.nightInfo.get(night.id);
  if (!info.champion) return '';
  const final = night.matches.find(m => m.stage === 'F');
  const o = E.outcome(final);
  const line = o.rated ? `Beat ${esc(nameOf(o.loser))} ${o.gamesWon}–${o.gamesLost} in the final` : 'Won the final';
  return `<a class="card hero-mini" href="${nightHref(night.id)}"><div class="label">Last Friday · ${dayDate(night.date)}</div>
    <div class="body">${avatar(info.champion, 44)}<div><b>${esc(nameOf(info.champion))}</b> ${trophy}${info.unbeaten ? ' <span class="tag gold">unbeaten</span>' : ''}
    <br><small class="muted">${line}</small></div><span class="chev">›</span></div></a>`;
}

function viewFridays() {
  const latest = app.calc.nights.at(-1);
  return latest ? viewNight(latest.id) : '<section class="page-head"><h1>Fridays</h1></section><p class="empty">No Fridays recorded yet.</p>';
}

function viewNight(id) {
  const night = findNight(id);
  if (!night) return notFound();
  const info = app.calc.nightInfo.get(id);
  let h = dateStrip(id) + nightHero(night, info);
  if (app.recorder) {
    h += night.closed
      ? `<button class="wide" data-act="reopenNight" data-night="${esc(id)}">Reopen to correct results</button>`
      : '<a class="button primary wide" href="#/record">Record results</a>';
  }
  const ko = night.matches.filter(m => !E.isGroupStage(m.stage));
  if (ko.length) {
    h += `<section class="card"><h2>Knockout</h2>${bracket(night)}
      <details class="more"><summary>Scores</summary><div class="matches">${ko.map(m => matchCard(night, m, { stage: true })).join('')}</div></details></section>`;
  }
  groupTables(night).forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    const ms = groupMatches(night, label);
    h += `<section class="card flush"><h2>${groupName(night, label)}</h2>${groupTable(night, t)}
      <div class="pad"><details class="more"><summary>Results (${ms.filter(E.isSettled).length})</summary>
      <div class="matches">${ms.map(m => matchCard(night, m)).join('')}</div></details></div></section>`;
  });
  h += `<section class="card"><h2>Rating changes${night.closed ? '' : ' <small>provisional</small>'}</h2>${changesList(night)}</section>`;
  return h;
}

function nightHero(night, info) {
  const d = [...info.details.values()];
  const points = d.reduce((s, x) => s + x.pointsWon + x.pointsLost, 0);
  let champ;
  if (info.champion) {
    champ = `<a class="champ" href="${playerHref(info.champion)}">${avatar(info.champion, 64)}<small>${trophy} Winner</small>
      <b>${esc(nameOf(info.champion))}</b>${info.unbeaten ? '<span class="tag gold">Unbeaten · +10 bonus</span>' : ''}</a>`;
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating after each Friday">
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
  const sub = row ? `${pos >= 0 ? `${ordinal(pos + 1)} in the table` : 'Not on the table'} · ${plural(row.nights, 'Friday')}` : 'No Fridays yet';
  let h = `<section class="card profile">${avatar(id, 60)}<div><h1>${esc(p.name)}</h1><p class="sub">${sub}</p></div>
    ${row ? `<div class="rating-badge"><b>${Math.round(row.rating)}</b><small>Rating</small></div>` : ''}</section>`;
  if (!row) return h;

  h += `<div class="tiles">${tile('Score', Math.round(row.ladder))}${tile('Bonus', signed(row.bonus, 0))}${tile('Won–lost', s ? `${s.won}–${s.lost}` : '0–0')}
    ${tile('Win rate', s?.played ? pct(s.winPct) : '–')}${tile('Points won', s?.played ? pct(s.avgShare) : '–')}${tile('Best streak', s?.bestStreak ?? 0)}</div>`;
  const left = E.NEW_PLAYER_NIGHTS - nightsOf(id);
  h += `<p class="foot">Bonus over the last 8 Fridays: ${row.attended} attended (${signed(5 * row.attended, 0)}), ${row.missed} missed (${signed(-5 * row.missed, 0)}), ${row.unbeaten} unbeaten (${signed(10 * row.unbeaten, 0)}).${left > 0 ? ` New player: rating changes are tripled for ${plural(left, 'more Friday')}.` : ''}</p>`;

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
  const hl = (id, k, v, right = '') => `<a class="hl" href="${playerHref(id)}">${avatar(id, 36)}<div><div class="k">${k}</div><div class="v">${v}</div></div>${right}</a>`;
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
  const row = ([opp, r]) => `<a class="h2h-row" href="${playerHref(opp)}">${who(opp, `${r.w + r.l} ${r.w + r.l === 1 ? 'match' : 'matches'}`)}
    <span class="rec">${r.w}–${r.l}</span><span class="split"><span style="width:${(100 * r.w) / (r.w + r.l)}%"></span></span></a>`;
  const first = opps.slice(0, 6).map(row).join('');
  const rest = opps.slice(6);
  return `<section class="card"><h2>Head-to-head <small>won–lost</small></h2>${first}
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
    ${blocks.length > 1 ? `<details class="more"><summary>Earlier Fridays (${blocks.length - 1})</summary>${blocks.slice(1).join('')}</details>` : ''}</section>`;
}

function viewStats() {
  const { players, upsets, nightGains, totals } = app.stats;
  let h = '<section class="page-head"><h1>Stats</h1>';
  if (!totals.fridays) return h + '</section><p class="empty">Stats appear after the first Friday.</p>';
  h += `<p class="sub">${plural(totals.fridays, 'Friday')} so far</p></section>`;
  h += `<div class="tiles">${tile('Matches', totals.matches)}${tile('Games', totals.games)}${tile('Points', totals.points.toLocaleString('en-GB'))}</div>`;
  const all = [...players.values()];
  const regular = all.filter(s => s.played >= 8);
  h += leaderCard('Most wins', all, s => s.won, v => v);
  h += leaderCard('Win rate', regular, s => s.winPct, pct, 'min. 8 matches');
  h += leaderCard('Longest winning streak', all, s => s.bestStreak, v => v);
  h += leaderCard('Share of points won', regular, s => s.avgShare, pct, 'min. 8 matches');

  if (upsets.length) {
    h += `<section class="card"><h2>Biggest upsets <small>chance of winning</small></h2>${upsets.slice(0, 5).map((u, i) => `
      <a class="list-row upset${i === 0 ? ' lead' : ''}" href="${nightHref(u.night.id)}"><span class="rk">${i + 1}</span>
      ${who(u.d.winner, `beat ${esc(nameOf(u.d.loser))} ${u.d.gamesWon}–${u.d.gamesLost} · ${shortDate(u.night.date)}`, i === 0 ? 40 : 28)}
      <span class="val">${pct(u.d.expected)}<small>${signed(u.d.gain)}</small></span></a>`).join('')}</section>`;
  }
  if (nightGains.length) {
    h += `<section class="card"><h2>Best single nights <small>rating gained</small></h2>${nightGains.slice(0, 5).map((g, i) => `
      <a class="list-row${i === 0 ? ' lead' : ''}" href="${nightHref(g.night.id)}"><span class="rk">${i + 1}</span>
      ${who(g.id, dayDate(g.night.date), i === 0 ? 40 : 28)}<span class="val up">${signed(g.change)}</span></a>`).join('')}</section>`;
  }
  h += leaderCard('Most 2-0 wins', all, s => s.twoNil, v => v);
  h += leaderCard('Unbeaten nights', all, s => s.unbeaten, v => v);
  h += leaderCard('Most Fridays played', all, s => s.nights, v => v);
  return h;
}

function leaderCard(title, list, value, fmt, note = '') {
  const top = list.filter(s => value(s) > 0).sort((a, b) => value(b) - value(a)).slice(0, 5);
  if (!top.length) return '';
  return `<section class="card"><h2>${title}${note ? ` <small>${note}</small>` : ''}</h2>${top.map((s, i) => `
    <a class="list-row${i === 0 ? ' lead' : ''}" href="${playerHref(s.id)}"><span class="rk">${i + 1}</span>${who(s.id, '', i === 0 ? 40 : 28)}
    <span class="val">${fmt(value(s))}</span></a>`).join('')}</section>`;
}

function viewRules() {
  return `<section class="page-head"><h1>How it works</h1></section>
  <section class="card prose"><h2>Ratings</h2>
    <p>Everyone starts at 1000. After every match the winner takes points from the loser:</p>
    <pre class="formula">Expected = 1/(1 + 10^((L − W)/400))
Change   = K × Weight × (1 − Expected)</pre>
    <p>W and L are the winner's and loser's ratings. <b>Expected</b> is how likely the winner was to win, so beating someone rated higher is worth more. <b>K</b> is 16, or 48 for a player's first 4 Fridays so new players find their level quickly. Ratings update once at the end of the night, using the ratings everyone arrived with.</p></section>
  <section class="card prose"><h2>Weight: how convincing the win was</h2>
    <pre class="formula">Share = winner's points / all points
2-0: Weight = 1 + 2 × (Share − 0.5)
     kept between 1.0 and 1.5
2-1: Weight = 0.75 + (Share − 0.5)
     kept between 0.75 and 0.95</pre>
    <p>Any 2-0 counts more than any 2-1, and the winner always gains.</p></section>
  <section class="card prose"><h2>The table</h2>
    <p>Score = rating + bonus. The bonus counts the last 8 Fridays: +5 for each one attended, −5 for each one missed (only since your first night), +10 for an unbeaten night (every group match, the semi and the final). No Friday in the last 8 takes you off the table, but your rating is kept.</p></section>
  <section class="card prose"><h2>A night</h2>
    <p>8–10 players: one group, then semis 1v4 and 2v3. 11–20 players: two groups seeded by rating in a snake, then semis A1 v B2 and B1 v A2. Group places go by matches won, then head-to-head, then game difference, then points difference.</p></section>
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
  return night ? nightDesk(night) : startForm();
}

function startForm() {
  const { ratingOf, nightsOf } = app.calc;
  if (!app.draft) app.draft = { date: today(), picked: new Set() };
  const players = [...app.data.players].sort((a, b) => a.name.localeCompare(b.name));
  let h = '<section class="page-head"><h1>Start a Friday</h1><p class="sub">Tick who\'s here, then start the night</p></section>';
  h += `<section class="card"><label class="field">Date <input type="date" id="nightDate" value="${esc(app.draft.date)}"></label></section>`;
  h += '<section class="card"><h2>Who\'s here?</h2>';
  h += players.length
    ? `<div class="checklist">${players.map(p => `<label><input type="checkbox" data-pick="${esc(p.id)}"${app.draft.picked.has(p.id) ? ' checked' : ''}>
        ${avatar(p.id, 22)}<span>${esc(p.name)}</span><small>${nightsOf(p.id) ? Math.round(ratingOf(p.id)) : 'new'}</small></label>`).join('')}</div>`
    : '<p class="muted">No players yet. Add everyone who\'s here below.</p>';
  h += `<form class="row" data-form="addPlayer" style="margin-top:10px"><input name="name" placeholder="New player's name" autocomplete="off" required><button>Add</button></form></section>`;
  h += `<p id="plan" class="plan foot">${planText()}</p>`;
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
  const p = progress(night);
  let h = `<section class="page-head"><h1>Tonight</h1><p class="sub">${dayDate(night.date)} · ${plural(night.attendees.length, 'player')}</p></section>
    <section class="card"><div class="between"><b>${p.done} of ${p.total} matches played</b><span class="tag live">Live</span></div>
    <div class="bar"><span style="width:${p.pct}%"></span></div></section>`;
  tables.forEach((t, i) => {
    const label = E.GROUP_LABELS[i];
    const ms = groupMatches(night, label);
    const done = ms.filter(E.isSettled), todo = ms.filter(m => !E.isSettled(m));
    h += `<section class="card flush"><h2>${groupName(night, label)} <small>${done.length}/${ms.length} played</small></h2><div class="pad">
      ${todo.length ? `<div class="matches">${todo.map(m => matchCard(night, m, { editable: true })).join('')}</div>` : '<p class="muted">All group matches played.</p>'}
      ${done.length ? `<details class="more"><summary>Played (${done.length}) · tap one to correct it</summary><div class="matches">${done.map(m => matchCard(night, m, { editable: true })).join('')}</div></details>` : ''}
      </div><div class="sub-h">Table</div>${groupTable(night, t)}</section>`;
  });

  const semis = night.matches.filter(m => m.stage === 'SF');
  const final = night.matches.find(m => m.stage === 'F');
  const fresh = m => !m.games && !m.walkover && !m.unfinished;
  let ko = '';
  if (semis.length) {
    const want = E.semiPairs(tables);
    const same = want && semis.every((m, i) => m.a === want[i][0] && m.b === want[i][1]);
    if (!same && semis.every(fresh) && !final) ko += '<p class="notice">Group results changed after the semis were made. Redo them to match the tables.</p>';
    ko += `<div class="matches">${semis.map((m, i) => `<div class="stage-label">Semi-final ${i + 1}</div>${matchCard(night, m, { editable: true })}`).join('')}</div>`;
  }
  if (final) ko += `<div class="matches"><div class="stage-label">Final</div>${matchCard(night, final, { editable: true })}</div>`;
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
  if (buttons.length) ko += `<div class="row" style="margin-top:10px">${buttons.join('')}</div>`;
  h += `<section class="card"><h2>Knockout</h2>${ko || '<p class="muted">Semi-finals are made from the group tables.</p>'}</section>`;

  const absent = app.data.players.filter(x => !night.attendees.includes(x.id)).sort((a, b) => a.name.localeCompare(b.name));
  h += `<details class="card"><summary>Late arrival or someone leaving</summary>
    <form class="stack" data-form="lateArrival">
      <p class="muted">A late arrival joins the smaller group and gets fixtures against everyone in it.</p>
      <select name="id"><option value="">Pick a player…</option>${absent.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
      <input name="name" placeholder="…or a new player's name" autocomplete="off">
      <button>Add to tonight</button>
    </form>
    <form class="stack" data-form="removePlayer" style="margin-top:16px">
      <p class="muted">Remove someone ticked by mistake (only if they have no results tonight). If someone leaves part-way, mark their remaining matches as unfinished instead.</p>
      <select name="id" required><option value="">Pick a player…</option>${night.attendees.map(id => `<option value="${esc(id)}">${esc(nameOf(id))}</option>`).join('')}</select>
      <button>Remove from tonight</button>
    </form></details>`;
  h += `<details class="card"><summary>Rating changes so far</summary><p class="muted">Applied when you close the night.</p>${changesList(night)}</details>`;
  h += `<button class="primary wide" data-act="closeNight">Close night and update ratings</button>
    <button class="danger wide" data-act="deleteNight" data-night="${esc(night.id)}">Delete night</button>`;
  return h;
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
      <span class="row" style="flex-wrap:nowrap"><button class="small" data-act="rename" data-id="${esc(x.id)}">Rename</button>${playerUsed(x.id) ? '' : `<button class="small danger" data-act="deletePlayer" data-id="${esc(x.id)}">Delete</button>`}</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul></section>`;
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
  [/^#\/(fridays|nights)$/, () => viewFridays(), 'fridays'],
  [/^#\/night\/(.+)$/, viewNight, 'fridays'],
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

function openScore(nightId, matchId) {
  const night = findNight(nightId);
  const m = night.matches.find(x => x.id === matchId);
  const g = i => m.games?.[i] ?? ['', ''];
  dialog.dataset.night = nightId;
  dialog.dataset.match = matchId;
  dialog.innerHTML = `<form method="dialog" class="sheet" autocomplete="off">
    <div class="grabber"></div>
    <h2>${stageName(night, m)}</h2>
    <div class="score-grid">
      <span></span>
      <span class="head">${avatar(m.a, 36)}<b>${esc(nameOf(m.a))}</b></span>
      <span class="head">${avatar(m.b, 36)}<b>${esc(nameOf(m.b))}</b></span>
      ${[0, 1, 2].map(i => `<span>Game ${i + 1}</span>
        <input data-g="${i}" data-s="0" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[0]}" aria-label="Game ${i + 1} ${esc(nameOf(m.a))}">
        <input data-g="${i}" data-s="1" type="number" inputmode="numeric" min="0" max="99" value="${g(i)[1]}" aria-label="Game ${i + 1} ${esc(nameOf(m.b))}">`).join('')}
    </div>
    <p class="preview" id="scorePreview"></p>
    <div class="sheet-actions"><button class="primary" data-act="saveScore">Save</button><button value="cancel" formnovalidate>Cancel</button></div>
    <details><summary>Walkover, unfinished or clear</summary>
      <p class="muted" style="margin-top:8px">Walkovers and unfinished matches don't change ratings. A walkover counts as a win in the group table.</p>
      <div class="row">
        <button class="small" data-act="walkover" data-id="${esc(m.a)}">Walkover to ${esc(nameOf(m.a))}</button>
        <button class="small" data-act="walkover" data-id="${esc(m.b)}">Walkover to ${esc(nameOf(m.b))}</button>
        <button class="small" data-act="unfinished">Unfinished</button>
        <button class="small danger" data-act="clearScore">Clear result</button>
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
    out.textContent = showError || games?.length >= 2 ? error : 'Enter each game, left player\'s score on the left.';
    return;
  }
  const o = E.outcome({ ...m, games });
  const info = app.calc.nightInfo.get(night.id);
  const share = o.pointsWon / (o.pointsWon + o.pointsLost);
  const w = E.weightFor(o.gamesLost, share);
  const base = w * (1 - E.expected(info.start.get(o.winner), info.start.get(o.loser)));
  out.className = 'preview';
  out.innerHTML = `<b>${esc(nameOf(o.winner))} wins ${o.gamesWon}-${o.gamesLost}</b> · points ${o.pointsWon}–${o.pointsLost} (${(share * 100).toFixed(1)}%) · weight ${w.toFixed(2)}<br>
    ${esc(nameOf(o.winner))} ${chg(info.k.get(o.winner) * base)} &nbsp; ${esc(nameOf(o.loser))} ${chg(-info.k.get(o.loser) * base)}`;
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
    location.hash = nightHref(night.id);
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

// Tapping the dimmed area above the score sheet closes it.
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

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
