// Season statistics for player pages and the Stats tab. Built from closed Fridays only and
// from rated matches only (walkovers and unfinished matches are left out).

export function buildStats(calc) {
  const players = new Map();
  const get = id => {
    if (!players.has(id)) {
      players.set(id, {
        id, played: 0, won: 0, lost: 0, twoNil: 0, pf: 0, pa: 0, shareSum: 0, nights: 0, unbeaten: 0,
        streak: 0, bestStreak: 0, results: [], h2h: new Map(),
      });
    }
    return players.get(id);
  };
  const upsets = [], nightGains = [];
  const totals = { fridays: calc.closed.length, matches: 0, games: 0, points: 0 };

  for (const night of calc.closed) {
    const info = calc.nightInfo.get(night.id);
    for (const id of info.attendees) {
      get(id).nights++;
      nightGains.push({ id, night, change: info.change.get(id) });
    }
    if (info.unbeaten) get(info.unbeaten).unbeaten++;
    for (const m of night.matches) {
      const d = info.details.get(m.id);
      if (!d) continue;
      totals.matches++;
      totals.games += m.games.length;
      totals.points += d.pointsWon + d.pointsLost;
      if (d.gamesLost === 0) get(d.winner).twoNil++;
      if (d.expected < 0.5) upsets.push({ night, m, d });
      for (const [id, opp, won] of [[d.winner, d.loser, true], [d.loser, d.winner, false]]) {
        const s = get(id);
        s.played++;
        won ? s.won++ : s.lost++;
        s.pf += won ? d.pointsWon : d.pointsLost;
        s.pa += won ? d.pointsLost : d.pointsWon;
        s.shareSum += won ? d.share : 1 - d.share;
        s.streak = won ? s.streak + 1 : 0;
        s.bestStreak = Math.max(s.bestStreak, s.streak);
        s.results.push({ won, opp, night, m, d, change: won ? d.gain : -d.loss });
        const h = s.h2h.get(opp) ?? { w: 0, l: 0 };
        won ? h.w++ : h.l++;
        s.h2h.set(opp, h);
      }
    }
  }

  for (const s of players.values()) {
    s.winPct = s.played ? s.won / s.played : 0;
    s.avgShare = s.played ? s.shareSum / s.played : 0;
    // Best win: the least likely one, by the rating-based Expected at the time.
    s.bestWin = s.results.filter(r => r.won).sort((a, b) => a.d.expected - b.d.expected)[0] ?? null;
    // Nemesis: most losses against, then worst record.
    s.nemesis = [...s.h2h].filter(([, h]) => h.l > 0)
      .sort(([, a], [, b]) => b.l - a.l || (a.w - a.l) - (b.w - b.l))[0] ?? null;
  }
  upsets.sort((a, b) => a.d.expected - b.d.expected);
  nightGains.sort((a, b) => b.change - a.change);
  return { players, upsets, nightGains, totals };
}
