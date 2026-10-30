# Golf Tour App – Scoring Engine (stage 1)

Pure calculation code (TypeScript, no UI, no database). Run the tests with Node 22+: `npm test`.

## Files
- `src/core.ts` – course/hole model, strokes per hole, Stableford points, Gross Stableford, Ambrose team handicap
- `src/matchplay.ts` – singles and 4-ball match play, front or back of the card, live status and result text
- `src/leaderboard.ts` – single-day leaderboards with countback, net stroke with DQ, multi-day aggregate, points to win
- `src/ambrose.ts` – Ambrose team card (2, 3, 4-man), net and DQ, 2-man Ambrose match play
- `test/engine.test.ts` – 19 tests on rules and Graham's 4-ball mockup (`test/fixtures/woolooware-4ball.json`, front and back of the card, extracted cell by cell from GolfAppMockups.xlsx, 29 Oct)
- `test/barnbougle.test.ts` – 5 tests against the Barnbougle tour results (`test/fixtures/barnbougle-2026.json`): aggregate ranks, Gross Stableford, Ambrose net and order, session totals
- `test/mockup2.test.ts` – 11 tests on the 29 Oct mockup: stroke net and DQ, stroke countback values, Ambrose card and match, singles and 2 v 1, playing the 18th 1 up
- Validation tracker: https://claude.ai/artifact/Mu4j9wR95H6rXEscqV982H

## Rules implemented (agreed 28–29 Oct 2026)
| Rule | Implementation |
|---|---|
| Strokes per hole | Count of the hole's printed index tiers (1-18, 19-36, 37-54) that are ≤ playing handicap. **All three tiers are stored per hole** because the printed 19-36 order is not always index+18 (Woolooware hole 5: 9 / 23 / 41). Plus handicaps give shots back from index 18 down. |
| Stableford points | `MAX(2 + par + strokes − gross, 0)`; `P` (pickup) = 0 |
| Gross Stableford | `Course Par + Handicap + (36 − Points)`. Per hole this is `par + strokes + 2 − points` (a pickup counts as net double bogey). |
| Ambrose team handicap | Team total ÷ 4 / 6 / 8 for 2 / 3 / 4 players |
| Match play – front of card | Each player's full playing handicap on the stroke index; best Stableford points per side wins the hole |
| Match play – back of card | Each player gets (own handicap − lowest handicap in the match) on the match play index (tiers 19-36 / 37-54 = index + 18 / + 36, confirmed); best points per side wins the hole |
| Wiped holes | Equal best points halve the hole, so both sides wiping (pickup / 0 points) = halved |
| Match closure | Decided when holes up > holes remaining → "3 and 2"; going the distance → "1 up" / "2 up"; level after 18 → "Halved". Status freezes once decided; players keep scoring for Stableford. |
| Match points | Win = match value (1 or 0.5); halved = half the value each |
| Points to win | Entered by the administrator for the tour. A helper suggests a figure (32 available → 16.5) for later automation. |
| Stableford countback (individual, single day only) | Back 9, last 6, last 3, then hole 18, 17 … 10; then front 9, holes 4-9, holes 7-9, then hole 9, 8 … 1; still level → shared rank (T2) |
| Net stroke (individual) | Net = gross − playing handicap; any pickup = DQ (listed at the bottom) |
| Ambrose stroke | One team score per hole; net = gross − team handicap (kept fractional, e.g. 59.25); any pickup = DQ; ties shared (T9), no countback |
| Ambrose match play (2-man) | Higher-handicap team receives the team handicap difference rounded to the nearest stroke (2.75 → 3), on the stroke index; administrator can override; holes won on Stableford points from the team score |
| 2 v 1 threesome | Two singles matches in one group; the single player's card counts in both; administrator sets points per match |
| Stroke countback (individual net, single day only) | Back 9 − ½H, last 6 − ⅓H, last 3 − ⅙H, then hole by hole − H/18; then the same on the front 9 |
| Gross Stableford leaderboard | Lower is better; **no tie-breakers** – equal scores show T2 |
| Multi-day aggregate | No countback; equal totals share the rank (T2); anyone who missed a round goes to the bottom |
| Live match text | "x up with n to play"; dormie when the lead equals the holes left |
| Live leaderboards | Stableford points and net to par through the holes played; partial rounds sit below the finished players they are level with and share their rank; countback note sits with the player ahead; identical cards = tied on all countbacks |
| Not built yet | Foursomes; novelty events (multipliers, 2-ball best-ball Stableford). Ambrose countback not needed. |

### Novelty stats (added 29 Oct, `novelty.ts`)
- Gross scores against par. Top 3 shown, with everyone level on 3rd place included (shared ranks show as T).
- **Bogey train**: longest run of consecutive holes at bogey or worse; a pickup (P) counts. **Par train**: longest run at par or better; a pickup breaks it.
- A run stays within one round (it does not carry from the 18th into the next session). Only each player's longest run per round is listed, with its hole range.
- **Birdies** counts birdie or better; **Pars** counts pars exactly.
- Shown per session or for the event to date. Ambrose groups are not included.

### Sessions (29 Oct)
- An Event has Sessions. "Tour" is a switch on the event; only a Tour shows teams, team colours and the Cup.
- Each session sets individual scoring: Stableford (default), Stableford + Net, or Net only. Leaders shows only the tabs that apply.
- Each session is "View and edit" or "View only". In View only, players cannot change scores (enforced in the database rules too); administrators still can.

### People, roles and events (Phase 2, 30 Oct)
- **Player directory**: one list for all events. Full name, nickname, mobile, usual handicap. Mobiles are only visible to administrators.
- **Per event**: each player's nickname and handicap start from the directory and can be changed for that event only.
- **Personal link**: one per person, for every event. Opening it links that phone to the person. After that, an event link (e.g. posted in WhatsApp) opens the event with the right view. A phone that has never opened a personal link is asked to open it first.
- **Roles**: Owner (first Google sign-in; also by personal link) > App administrator (set in the directory) > Event administrator (set per event by Owner or app admins; can set up that event but not change its status or administrators) > Player.
- **Event status**: Planning (administrators only) · Active (players can see and score) · Complete (players can see) · Archived (hidden from players) · Delete (Owner and app admins).
- **Bottom tabs**: Order of Play · Scores · Leaders · Cup (Tours only) · Setup (administrators).

### Side matches and cut throat (30 Oct)
- A group playing individual scoring can set up its own **side match** (any player in the group, or an administrator): 4-ball (2 v 2), singles (pairs, first left v first right) or **cut throat** (3 or 4 players). Front or back of card for 4-ball and singles. Side matches never count towards a Cup.
- **Cut throat**: each player's Stableford points with full handicap. The best score on a hole wins it outright; a shared best score halves it; no carry-overs. A hole counts once every player has scored. Most holes won wins (ties shared). (`cutthroat.ts`)
- Individual scoring is now called **Stroke** (net stroke play): Stableford, Stableford + Stroke, or Stroke only. A Stroke-only session lists its individual group type as "Individual stroke".
- **Grades** for Novelty stats: A grade = event handicap up to the event's threshold (default 16); B grade = above it.
- Groups can be moved up or down; tee times stay with the slot in the order of play. Tee times use the phone's time picker and show as 12-hour (7:30 AM).

### Team Multiplier, trains and courses (30 Oct)
- **Team Multiplier Stableford** (a session option): on each hole, everyone in the group's Stableford points (full handicap) are multiplied together; any 0 or pickup makes the hole 0. Group total = sum of the hole products. A hole counts once everyone has scored. Shown as a Multiplier panel on the scorecard and a Multiplier leaderboard (groups ranked by total; ties shared). (`multiplier.ts`)
- **Novelty top 5** for trains, birdies and pars (everyone level with 5th included; a long tie is summarised as "and N more level").
- **Trains** are 2 or more holes in a row within a round. Every train counts, so a player can appear twice. The **Par or better train** shows the score to par over the train (E, −1, −2…); same length lists the better score first.
- Course name, tee, colour, pars and all index columns can be edited in Setup › Courses (same checks as pasting).

## Open questions
- None at present.

## Settled
- Halved 0.5-point match = 0.25 each.
- Hole-by-hole countback runs 18 back to 10, then the front 9 the same way.
- Gross Stableford has no tie-breakers.
- Players: typically 24-28 a day; no limit built in (plan for 50+).
- Par for Gross Stableford comes from the course/tee library (Barnbougle sheet corrected 29 Oct).
- Ambrose ties show T9 (no countback).
- Stroke countback last 3 = handicap ÷ 6 (mockup corrected 29 Oct).
- Ambrose has no Stableford totals; per-hole Stableford points are used only to decide each match-play hole.
- Score markers (MiScore style): eagle = double circle, birdie = circle, both medium blue; bogey = yellow square; double bogey or worse = red double square.
- Score entry layout: holes down the page, one column per player; one match shown at a time.
- All square chevron: light yellow while live, strong yellow when the match finishes halved.
- Final validation is done by Graham in the app; engine tests check against worked examples and agreed rules.

## Prototype round 3 (29 Oct): administrator set-up
- Tour data model: players, course library (course > tees > 18 holes), days (course/tee, Cup on/off, briefing), groups stored as player slots and turned into matches or Ambrose teams by format.
- Setup tab (administrator only): tour settings, players with invite links, course import by pasting 18 rows from Excel (validated), days and group editor with assignment check. Tour-to-date leaderboards and Cup sessions by day.
- Backend decision: Google Firebase (Firestore with offline persistence), personal invite links for players, hosting on GitHub Pages. Only the data layer at the top of `prototype/app3.js` changes when Firebase replaces on-phone storage.

## Prototype (29 Oct, round 2 after Graham's feedback)
- One match at a time per scorecard, team 1 always on the left, chevrons for match status, winning score shaded, sign-and-submit lock, players edit only their own match, administrator controls leaderboard visibility and team names/colours (demo 'Viewing as' switch).
- `../prototype/golf-tour-scorer.html` – phone prototype, published privately as an artifact. Engine bundled in; scores saved on the phone only.
- `../prototype/demo.ts` builds the demo day: Groups 1, 2 and 6 use Graham's mockup scores; others are seeded example scores.
