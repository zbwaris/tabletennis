// Rating engine for the Friday table tennis ranking (rules: agreed-rules.md).
// Nothing here is stored: ratings, bonuses and the table are recomputed from the raw
// results every time, so correcting an old score fixes everything after it.

export const START_RATING = 1000;
export const K_NORMAL = 16;
export const K_NEW = 48;
export const NEW_PLAYER_NIGHTS = 4;
export const BONUS_WINDOW = 8;
export const ATTEND_BONUS = 5;
export const UNBEATEN_BONUS = 10;

export const GROUP_LABELS = ['A', 'B', 'C', 'D'];
export const isGroupStage = stage => stage !== 'SF' && stage !== 'F';

export function expected(rating, opponent) {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// How convincing the win was. 2-0 and 2-1 have separate bands so any 2-0 beats any 2-1.
export function weightFor(gamesLost, share) {
  return gamesLost === 0
    ? clamp(1 + 2 * (share - 0.5), 1, 1.5)
    : clamp(0.75 + (share - 0.5), 0.75, 0.95);
}

// Games are to 11, win by 2.
export function gameError([x, y]) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return 'enter both scores';
  if (x === y) return `${x}-${y}: a game can't finish level`;
  const hi = Math.max(x, y), lo = Math.min(x, y);
  if (hi < 11) return `${x}-${y}: games are played to 11`;
  if (hi === 11 && lo === 10) return `${x}-${y}: from 10-10 someone needs a 2-point lead`;
  if (hi > 11 && hi - lo !== 2) return `${x}-${y}: after 10-10 the game ends as soon as someone leads by 2`;
  return null;
}

// Best of 3: the match stops as soon as someone has 2 games.
export function gamesError(games) {
  if (!games || !games.length) return 'Enter the game scores';
  let a = 0, b = 0;
  for (let i = 0; i < games.length; i++) {
    if (a === 2 || b === 2) return `Game ${i + 1} shouldn't exist: the match was already won`;
    const err = gameError(games[i]);
    if (err) return `Game ${i + 1}: ${err}`;
    games[i][0] > games[i][1] ? a++ : b++;
  }
  if (a < 2 && b < 2) return 'Best of 3: someone needs to win 2 games';
  return null;
}

// What a match settled, or null if it has no result yet (or was left unfinished).
// Walkovers have a winner for the group table but don't change ratings.
export function outcome(m) {
  if (m.walkover) {
    return { winner: m.walkover, loser: m.walkover === m.a ? m.b : m.a, rated: false, walkover: true };
  }
  if (!m.games || gamesError(m.games)) return null;
  let ga = 0, gb = 0, pa = 0, pb = 0;
  for (const [x, y] of m.games) {
    pa += x; pb += y;
    x > y ? ga++ : gb++;
  }
  const aWon = ga > gb;
  return {
    winner: aWon ? m.a : m.b,
    loser: aWon ? m.b : m.a,
    gamesWon: Math.max(ga, gb),
    gamesLost: Math.min(ga, gb),
    pointsWon: aWon ? pa : pb,
    pointsLost: aWon ? pb : pa,
    rated: true,
  };
}

export const isSettled = m => !!m.unfinished || outcome(m) !== null;

// Rating changes for one night, all scored from the ratings players arrived with.
function settleNight(night, ratingOf, kOf) {
  const attendees = new Set(night.attendees);
  for (const m of night.matches) { attendees.add(m.a); attendees.add(m.b); }
  const start = new Map([...attendees].map(id => [id, ratingOf(id)]));
  const k = new Map([...attendees].map(id => [id, kOf(id)]));
  const change = new Map([...attendees].map(id => [id, 0]));
  const details = new Map();
  const lost = new Set();

  for (const m of night.matches) {
    const o = outcome(m);
    if (!o) continue;
    lost.add(o.loser);
    if (!o.rated) continue;
    const share = o.pointsWon / (o.pointsWon + o.pointsLost);
    const weight = weightFor(o.gamesLost, share);
    const exp = expected(start.get(o.winner), start.get(o.loser));
    const gain = k.get(o.winner) * weight * (1 - exp);
    const loss = k.get(o.loser) * weight * (1 - exp);
    change.set(o.winner, change.get(o.winner) + gain);
    change.set(o.loser, change.get(o.loser) - loss);
    details.set(m.id, { ...o, share, weight, expected: exp, gain, loss });
  }

  const final = night.matches.find(m => m.stage === 'F');
  const champion = final ? outcome(final)?.winner ?? null : null;
  const unbeaten = champion && !lost.has(champion) ? champion : null;
  return { attendees, start, k, change, details, champion, unbeaten };
}

export function compute(data) {
  const nights = [...data.nights].sort((x, y) => x.date.localeCompare(y.date));
  const rating = new Map(), played = new Map(), first = new Map(), history = new Map();
  const nightInfo = new Map();
  const closed = [];
  const ratingOf = id => rating.get(id) ?? START_RATING;
  const nightsOf = id => played.get(id) ?? 0;
  const kOf = id => (nightsOf(id) < NEW_PLAYER_NIGHTS ? K_NEW : K_NORMAL);

  for (const night of nights) {
    const info = settleNight(night, ratingOf, kOf);
    nightInfo.set(night.id, info);
    if (!night.closed) continue; // an open night shows provisional changes only
    for (const id of info.attendees) {
      const r = ratingOf(id) + info.change.get(id);
      rating.set(id, r);
      played.set(id, nightsOf(id) + 1);
      if (!first.has(id)) first.set(id, closed.length);
      if (!history.has(id)) history.set(id, []);
      history.get(id).push({ night: night.id, date: night.date, rating: r, change: info.change.get(id) });
    }
    closed.push(night);
  }

  // Bonuses over the last 8 Fridays. Fridays before a player's first night aren't missed.
  const windowStart = Math.max(0, closed.length - BONUS_WINDOW);
  const latest = closed.at(-1);
  const table = [], inactive = [];
  for (const p of data.players) {
    if (!first.has(p.id)) continue;
    let attended = 0, missed = 0, unbeaten = 0;
    for (let i = Math.max(windowStart, first.get(p.id)); i < closed.length; i++) {
      const info = nightInfo.get(closed[i].id);
      info.attendees.has(p.id) ? attended++ : missed++;
      if (info.unbeaten === p.id) unbeaten++;
    }
    const bonus = ATTEND_BONUS * (attended - missed) + UNBEATEN_BONUS * unbeaten;
    const lastInfo = latest && nightInfo.get(latest.id);
    const row = {
      id: p.id, name: p.name, rating: ratingOf(p.id), nights: nightsOf(p.id),
      attended, missed, unbeaten, bonus, ladder: ratingOf(p.id) + bonus,
      lastChange: lastInfo?.attendees.has(p.id) ? lastInfo.change.get(p.id) : null,
    };
    (attended ? table : inactive).push(row);
  }
  table.sort((x, y) => y.ladder - x.ladder || y.rating - x.rating || x.name.localeCompare(y.name));
  inactive.sort((x, y) => y.rating - x.rating);

  return { nights, closed, nightInfo, table, inactive, history, ratingOf, nightsOf, kOf };
}

// Group placings: matches won, then head-to-head, then game difference, then points difference.
// Head-to-head among 3 or more tied players means matches won among just those players.
export function standings(ids, matches) {
  const s = new Map(ids.map(id => [id, { id, played: 0, won: 0, lost: 0, gf: 0, ga: 0, pf: 0, pa: 0 }]));
  const decided = [];
  for (const m of matches) {
    if (!s.has(m.a) || !s.has(m.b)) continue;
    const o = outcome(m);
    if (!o) continue;
    decided.push(o);
    const w = s.get(o.winner), l = s.get(o.loser);
    w.played++; l.played++; w.won++; l.lost++;
    if (o.rated) {
      w.gf += o.gamesWon; w.ga += o.gamesLost; l.gf += o.gamesLost; l.ga += o.gamesWon;
      w.pf += o.pointsWon; w.pa += o.pointsLost; l.pf += o.pointsLost; l.pa += o.pointsWon;
    }
  }
  const gd = id => s.get(id).gf - s.get(id).ga;
  const pd = id => s.get(id).pf - s.get(id).pa;
  const order = block => {
    if (block.length < 2) return block;
    const inBlock = new Set(block);
    const wins = new Map(block.map(id => [id, 0]));
    for (const o of decided) {
      if (inBlock.has(o.winner) && inBlock.has(o.loser)) wins.set(o.winner, wins.get(o.winner) + 1);
    }
    const levels = [...new Set(wins.values())].sort((x, y) => y - x);
    if (levels.length > 1) return levels.flatMap(v => order(block.filter(id => wins.get(id) === v)));
    return [...block].sort((x, y) => gd(y) - gd(x) || pd(y) - pd(x));
  };
  return order(ids).map((id, i) => ({ ...s.get(id), pos: i + 1, gd: gd(id), pd: pd(id) }));
}

// Snake seeding by rating: ranked 1-8 -> A gets 1, 4, 5, 8; B gets 2, 3, 6, 7.
export function seedGroups(ids, ratingOf, nameOf) {
  const ranked = [...ids].sort((a, b) => ratingOf(b) - ratingOf(a) || nameOf(a).localeCompare(nameOf(b)));
  if (ranked.length <= 10) return [ranked];
  const A = [], B = [];
  ranked.forEach((id, i) => ((Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? A : B).push(id));
  return [A, B];
}

// Round robin in rounds (circle method), so nobody plays twice in a row early on.
export function roundRobin(ids) {
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length, pairs = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) pairs.push([a, b]);
    }
    list.splice(1, 0, list.pop());
  }
  return pairs;
}

// One group: 1v4 and 2v3. Two groups: A1 v B2 and B1 v A2.
export function semiPairs(groupTables) {
  if (groupTables.length === 1) {
    const t = groupTables[0];
    return t.length >= 4 ? [[t[0].id, t[3].id], [t[1].id, t[2].id]] : null;
  }
  const [A, B] = groupTables;
  return A.length >= 2 && B.length >= 2 ? [[A[0].id, B[1].id], [B[0].id, A[1].id]] : null;
}
