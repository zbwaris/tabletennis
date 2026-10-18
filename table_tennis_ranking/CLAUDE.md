# Friday Table Tennis Ranking – Project Context

A ranking system for a weekly Friday table tennis club. 8–20 people attend; nights are a
group stage, then semis and a final. The rules are agreed and **locked**. A website for
recording results and showing the ranking is built (see "The website" below). A rulebook is
still to be written (format not decided yet).

- The full agreed rules are in [agreed-rules.md](agreed-rules.md). Treat them as the source
  of truth; don't change a rule unless the user asks.
- This project was designed in a chat that ran from the `zaid_ecalc` folder (an unrelated
  project). Keep table tennis work in this folder only.

## How the user likes to work

- Explain the logic and the maths behind rules, with worked numbers, not just the result.
- Material for the club is the user's to share. Don't write group-chat messages unless asked.
- The user tests ideas by asking "what happens if…", so simulations are welcome.

## The system in one paragraph

Elo rating starting at 1000 with no limits. Change = K × Weight × (1 − winner's Expected),
where Expected = 1 / (1 + 10^((opponent − you) / 400)). K is 16, or 48 for a player's first
4 Fridays (also for everyone at launch). Weight comes from the score: a 2-0 gets 1.0–1.5,
and a 2-1 gets 0.75–0.95, with the position set by the winner's share of all points played.
Ratings update once at the end of the night, scored from start-of-night ratings. The ranking
table uses rating + bonus points: ±5 for attending or missing a Friday, +10 for an unbeaten
night, both counted over the last 8 Fridays.

## Why each rule is the way it is

| Rule | Reason |
|---|---|
| Elo, not placement points | Group chat options were placement points summed, best-N-of-M, or a rolling window. Elo was chosen because the loser loses what the winner gains, and beating a stronger player is automatically worth more. |
| Start 1000, no 0–100 limits | The user first proposed 0–100 starting at 50, then dropped it. Hard limits break the zero-sum exchange, and gains shrink with the gap anyway. |
| Expected and Weight are separate | Expected (from ratings) says how surprising a win was; Weight (from score) says how convincing it was. They are multiplied together. |
| Weight multiplies, never replaces the win | If the points share were used as the result, a favourite winning narrowly could lose rating. Multiplying means the winner always gains. |
| Separate bands for 2-0 and 2-1 | User requirement: any 2-0 must beat any 2-1. An earlier single formula let a lopsided 2-1 outscore a close 2-0. |
| Points share, not difference | It is fair across match lengths: a 2-1 has more points, and deuce games run longer. |
| 2-0 slope 2, 2-1 slope 1 | A 2-1 includes a lost game, so its points share says less about dominance. |
| Bonuses kept out of the rating | Attendance inside the rating would inflate regulars and distort the Elo maths. |
| Bonuses counted over 8 Fridays | Keeps them bounded (attendance −40 to +40) so turning up never outweighs results. |
| No "most improved" | Hard to define fairly; it favours low-rated players and returners. |
| Tripled for 4 Fridays, not per match | User's choice. It is faster than doubled-for-20-matches and simpler to track by night. |
| Updated at end of night | User's choice, to make recording simple: results can be written down in any order. |

## Simulation findings (for reference)

The scripts were deleted to keep things tidy. To rebuild them, use this model:

- Each player has a skill θ. P(win a point) = 1 / (1 + e^−(θi − θj)).
- Games are to 11, win by 2, and matches are best of 3.
- 12 players play two snake-seeded groups of 6, then semis A1–B2, B1–A2, and a final.
- Results come from 300 simulated seasons of 40 Fridays.

**Rating spread with 12 players after 40 Fridays (typical ratings):**

| Scenario | Top two | Places 3–12 | Top to bottom |
|---|---|---|---|
| All close in level | 1171, 1143 | 1106 → 832 | ~340 |
| Two clearly stronger (beat #3 ~70%) | 1337, 1280 | 1103 → 768 | ~570 |
| Two much stronger (beat #3 ~90%) | 1485, 1433 | 1068 → 741 | ~745 |

- Neighbouring places are ~35 points apart, and each rating wobbles ~±20 week to week.
- The final order is on average ~0.5 places off the true order. The truly best player
  finishes first ~85% of the time.
- The other players drop slightly when two strong players pull away, because the
  ratings always sum to 1000 × the number of players.
- The unbeaten bonus nearly always goes to the top two players (still an open question).

**A newcomer starting at 1000 whose true level is ~790** (Fridays until within 50 / within
25 of their true level):

| Rule | 13-player nights | 20-player nights |
|---|---|---|
| Old: live updates, doubled for 20 matches | 7 / 10 | 5 / 7 |
| **Agreed: end of night, tripled for 4 Fridays** | **4 / 5** | **2 / 3** |
| End of night, doubled for 4 Fridays | 6 / 9 | 4 / 4 |

- The agreed rule has the lowest average error. Its cost is larger first-night swings
  (worst 1 in 10: about −130 on 13-player nights, about −180 on 20-player nights).
- On 20-player nights about 1 in 3 newcomers temporarily dips more than 50 points below
  their true level, then recovers.
- A ±100 per-night cap was tested and rejected: it trims the extremes without improving
  accuracy. Resetting a newcomer to their performance rating after 2 Fridays was also
  rejected: it is too noisy, and 1 in 10 land 200+ points too low.
- At launch, tripled for 4 Fridays spreads the table faster with the same accuracy.
- Known small side effects: newcomers' asymmetric K slowly shifts the pool average (harmless,
  only gaps matter), and score weighting gives favourites a slight extra gain over time.

## Quick reference: gains between equal players (1000 vs 1000)

The base change is 8 (16 × 0.5), and the actual change is 8 × Weight. A close 2-1 such as
11-9, 9-11, 11-9 gives +6.1. A whitewash 11-0, 11-0 gives +12.0.

## The website

Static site in `docs/`, hosted free on GitHub Pages; setup steps are in [SETUP.md](SETUP.md).
The user asked for something free with a UI and didn't mind how the backend works. One person
(or a helper) records on a phone.

| File | Role |
|---|---|
| `docs/engine.js` | All the rules: Elo, weight, bonuses, group standings, snake seeding, fixtures, semis. Pure functions. |
| `docs/store.js` | Loads `data.json`; the recorder reads/writes it through the GitHub contents API with a fine-grained token. |
| `docs/app.js` | The screens: Ranking, Player, Nights, Night, Record, Rules (with a "try a match" calculator), Settings. |
| `docs/data.json` | The only stored data: players, and per night the attendees, groups and matches (game scores, walkover winner, or unfinished). |

- Ratings, bonuses and the table are never stored. They're recalculated from all raw results
  on every load, so correcting an old score fixes everything after it.
- The data lives in the repo, not a database: no extra account, and git history is the backup.
  The user has a VM running 24/7; it was not used, to avoid exposing a home PC and running a server.
- During an open night, uploads are throttled to one every 5 minutes, because GitHub Pages
  allows about 10 builds an hour. The phone keeps a working copy in localStorage, so nothing
  is lost if it's offline.
- Choices not in the rules: a walkover counts as a match won in the group table (no rating
  change); unbeaten = won the final and lost no match that night; a cancelled Friday is just
  not recorded; a late arrival joins the smaller group.
- Tested by an independent Python reimplementation over a simulated 13-Friday season (ratings
  matched to 1e-12), unit checks against the rules' worked examples, and a scripted recorder
  run against a fake GitHub API in headless Edge. These test scripts were not kept. Node and
  git aren't installed; Python and Edge are.

## Open questions

See the "Still open" list in agreed-rules.md: season length, how to split groups on
20-player nights, starting ratings for known strong players, and the unbeaten bonus
favouring the top two.
