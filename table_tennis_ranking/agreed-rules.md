# Friday Table Tennis Ranking – Agreed Rules

Notes for writing the rulebook later. Agreed on 2026-10-18.

## Ratings (Elo)

- Everyone starts at 1000. No upper or lower limit.
- Every match moves points from the loser to the winner (equal and opposite).
- Ratings update once, at the end of the night. Every match that night is scored
  using the ratings players arrived with; the changes are added up and applied after the final.

```
Expected = 1 / (1 + 10^((opponent rating − your rating) / 400))
Change   = K × Weight × (1 − winner's Expected)
```

- K = 16 normally.
- K = 48 (tripled) for a player's first 4 Fridays. This applies to every newcomer, and to
  everyone when the ranking first starts. It applies only to that player's own change;
  their opponent still uses 16.

## Weight (how convincing the win was)

Matches are best of 3 games to 11. A 2-0 has no third game.

```
Winner's share = winner's total points / all points played

2-0 win: Weight = 1.0  + 2 × (share − 0.5), kept between 1.0 and 1.5
2-1 win: Weight = 0.75 + (share − 0.5),     kept between 0.75 and 0.95
```

- Any 2-0 counts more than any 2-1 (the ranges don't overlap).
- The winner always gains; the score only changes how much.

Examples for 1000 vs 1000 (change = 8 × Weight):

| Match            | Points | Share | Weight | Winner gains |
|------------------|--------|-------|--------|--------------|
| 11-9, 9-11, 11-9 | 31–29  | 52%   | 0.77   | +6.1         |
| 11-1, 9-11, 11-1 | 31–13  | 70%   | 0.95   | +7.6         |
| 11-9, 11-9       | 22–18  | 55%   | 1.10   | +8.8         |
| 11-7, 11-6       | 22–13  | 63%   | 1.26   | +10.1        |
| 11-0, 11-0       | 22–0   | 100%  | 1.50   | +12.0        |

## Bonus points and the ranking table

- Ranking table is sorted by **ladder score = rating + bonus points**. Bonuses never go into the rating itself.
- Attended a Friday: +5. Missed a Friday: −5. Counted over the last 8 Fridays (range −40 to +40).
- Unbeaten night (won every group match, the semi and the final): +10, counted over the last 8 Fridays.
- Only Fridays since a player's first night count as missed. Cancelled sessions don't count.
- No attendance in the last 8 Fridays: off the table, rating kept.
- No "most improved" award.

## Match night format

| Players | Group stage                      | Knockout                                    |
|---------|----------------------------------|---------------------------------------------|
| 8–10    | One group, round robin           | Top 4 to semis: 1v4, 2v3, then final        |
| 11–20   | Two groups, round robin          | Top 2 of each: A1 v B2, B1 v A2, then final |

- Groups seeded by rating in a snake: ranked 1–8 → A gets 1, 4, 5, 8; B gets 2, 3, 6, 7.
- Group placings: matches won, then head-to-head, then game difference, then points difference.

## What to record each night

1. Who attended.
2. Every match: the two players, the stage, and each game's score. Any order.

A walkover or unfinished match is recorded but doesn't change ratings.

## Still open

- Season length for standings (month or longer).
- On 20-player nights: two groups of 10, or four groups of 5?
- Should known strong players start above 1000?
- Unbeaten bonus mostly goes to the top two players – accept, or limit it?
