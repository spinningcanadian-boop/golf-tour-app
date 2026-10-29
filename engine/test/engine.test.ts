import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strokesOnHole, stablefordPoints, stablefordCard, ambroseTeamHandicap } from '../src/core.ts';
import type { Course, HoleScore } from '../src/core.ts';
import { playMatch } from '../src/matchplay.ts';
import type { MatchPlayer } from '../src/matchplay.ts';
import { dayStablefordLeaderboard, dayGrossStablefordLeaderboard, dayNetStrokeLeaderboard, aggregateLeaderboard, pointsToWin, rankLabel } from '../src/leaderboard.ts';

// Graham's 4-ball mockup (GolfAppMockups.xlsx, 29 Oct), front and back of the card, extracted cell by cell.
const fx = JSON.parse(readFileSync(new URL('./fixtures/woolooware-4ball.json', import.meta.url), 'utf8'));
const course: Course = fx.course;
const players: MatchPlayer[] = fx.players.map((p: any, k: number) => ({
  name: p.name, handicap: p.handicap, scores: fx.gross.map((row: any[]) => row[k] as HoleScore),
}));
const sides: [MatchPlayer[], MatchPlayer[]] = [[players[0], players[1]], [players[2], players[3]]];
const resultCode: Record<string, any> = { 'Team 1': 0, 'Team 2': 1, Halved: 'halved' };

// ---------- Test case 1: front of the card ----------

test('mockup front: strokes and Stableford points per hole (4 players x 18 holes)', () => {
  players.forEach((p, k) => {
    const card = stablefordCard(course, p.handicap, p.scores);
    card.holes.forEach((l, i) => {
      assert.equal(l.strokes, fx.front.strokes[i][k], `hole ${l.hole} ${p.name} strokes`);
      assert.equal(l.points, fx.front.points[i][k], `hole ${l.hole} ${p.name} points`);
    });
  });
});

test('mockup front: back 9, last 6, last 3, total and Gross Stableford', () => {
  players.forEach((p, k) => {
    const card = stablefordCard(course, p.handicap, p.scores);
    const pts = (a: number, b: number) => card.holes.slice(a - 1, b).reduce((x, l) => x + l.points!, 0);
    assert.equal(card.back9, fx.front.back9[k]);
    assert.equal(pts(13, 18), fx.front.last6[k]);
    assert.equal(pts(16, 18), fx.front.last3[k]);
    assert.equal(card.points, fx.front.total[k]);
    assert.equal(card.grossStableford, fx.front.grossStableford[k]);
  });
});

test('mockup front: 4-ball hole results, status and "Team 1 Won 3 and 2"', () => {
  const m = playMatch(course, sides, { method: 'front' });
  m.holes.forEach((h, i) => {
    assert.equal(h.winner, resultCode[fx.front.result[i]], `hole ${h.hole} result`);
    // The workbook keeps counting after the match is decided; the engine freezes status at the deciding hole (16).
    if (h.hole <= 16) assert.equal(h.status, fx.front.status[i], `hole ${h.hole} status`);
  });
  assert.equal(m.decidedOn, 16);
  assert.equal(`Team ${(m.winner as number) + 1} Won ${m.resultText}`, fx.front.matchResult);
  assert.deepEqual(m.points, [1, 0]);
});

// ---------- Test case 2: back of the card (same scores) ----------

test('mockup back: match handicaps 0 / 10 / 3 / 19 and strokes per hole on the match play index', () => {
  const m = playMatch(course, sides, { method: 'back' });
  m.holes.forEach((h, i) => {
    assert.deepEqual(h.strokes.flat(), fx.back.strokes[i], `hole ${h.hole} strokes`);
  });
  const totals = [0, 1, 2, 3].map(k => m.holes.reduce((a, h) => a + h.strokes.flat()[k], 0));
  assert.deepEqual(totals, fx.back.matchHandicaps);
});

test('mockup back: match points, hole results, status and "Halved"', () => {
  const m = playMatch(course, sides, { method: 'back' });
  m.holes.forEach((h, i) => {
    assert.deepEqual(h.points.flat(), fx.back.points[i], `hole ${h.hole} points`);
    assert.equal(h.winner, resultCode[fx.back.result[i]], `hole ${h.hole} result`);
    assert.equal(h.status, fx.back.status[i], `hole ${h.hole} status`);
  });
  assert.equal(m.resultText, fx.back.matchResult);
  assert.deepEqual(m.points, [0.5, 0.5]);
});

// ---------- Rules from the brief ----------

test('pickup scores 0 points and Stableford never goes negative', () => {
  assert.equal(stablefordPoints(4, 0, 'P'), 0);
  assert.equal(stablefordPoints(5, 1, 9), 0);      // would be -1 without MAX(x,0)
  assert.equal(stablefordPoints(4, 0, null), null);
});

test('strokes per hole: handicaps above 36 and plus handicaps', () => {
  assert.equal(strokesOnHole(40, [1]), 3);         // 1, 19, 37 all <= 40
  assert.equal(strokesOnHole(40, [5]), 2);
  assert.equal(strokesOnHole(25, [9, 23, 41]), 2); // Woolooware hole 5: printed 2nd-tier index is 23, not 27
  assert.equal(strokesOnHole(25, [9]), 1);         // ...which is why printed tiers must be stored
  assert.equal(strokesOnHole(-2, [17]), -1);       // plus 2 gives back a shot on index 17 and 18
  assert.equal(strokesOnHole(-2, [16]), 0);
  const total = (h: number) => course.holes.reduce((a, x) => a + strokesOnHole(h, x.strokeIndexes), 0);
  for (const h of [-3, 0, 6, 18, 25, 36, 45, 54]) assert.equal(total(h), h);
});

test('Gross Stableford = Course Par + Handicap + (36 - Points) and equals sum of adjusted gross', () => {
  players.forEach(p => {
    const card = stablefordCard(course, p.handicap, p.scores);
    assert.equal(card.grossStableford, 70 + p.handicap + 36 - card.points);
    assert.equal(card.holes.reduce((a, l) => a + l.adjustedGross!, 0), card.grossStableford);
  });
});

test('Ambrose team handicap = total / 4, 6, 8 (checked against Barnbougle results)', () => {
  assert.equal(ambroseTeamHandicap([12, 20]), 8);         // Nugs & Matty T
  assert.equal(ambroseTeamHandicap([15, 28]), 10.75);     // Brian & Karl
  assert.ok(Math.abs(ambroseTeamHandicap([19, 25, 36]) - 13.33) < 0.01); // Tony, Al, Peter
});

// ---------- Match play edge cases ----------

const coursePars = course.holes.map(h => h.par);

test('match going the distance reads "1 up", not "1 and 0"', () => {
  const a: MatchPlayer = { name: 'A', handicap: 0, scores: [...coursePars] };
  const b: MatchPlayer = { name: 'B', handicap: 0, scores: [...coursePars] };
  b.scores[17] = coursePars[17] + 1; // B bogeys the last
  const m = playMatch(course, [[a], [b]], { method: 'back' });
  assert.equal(m.resultText, '1 up');
  assert.equal(m.winner, 0);
  assert.equal(m.decidedOn, null);
});

test('halved match gives half the match value to each side (0.5-point match -> 0.25 each)', () => {
  const a: MatchPlayer = { name: 'A', handicap: 0, scores: [...coursePars] };
  const b: MatchPlayer = { name: 'B', handicap: 0, scores: [...coursePars] };
  const m = playMatch(course, [[a], [b]], { method: 'back', value: 0.5 });
  assert.equal(m.resultText, 'Halved');
  assert.deepEqual(m.points, [0.25, 0.25]);
});

test('both sides wiping a hole halves it', () => {
  const a: MatchPlayer = { name: 'A', handicap: 0, scores: [...coursePars] };
  const b: MatchPlayer = { name: 'B', handicap: 0, scores: [...coursePars] };
  a.scores[0] = 'P'; b.scores[0] = coursePars[0] + 4; // b scores 0 points
  const m = playMatch(course, [[a], [b]], { method: 'back' });
  assert.equal(m.holes[0].winner, 'halved');
});

test('match in progress shows live status', () => {
  const a: MatchPlayer = { name: 'Graham', handicap: 0, scores: [3, 4, 4, ...Array(15).fill(null)] };
  const b: MatchPlayer = { name: 'Nic', handicap: 0, scores: [5, 4, 4, ...Array(15).fill(null)] };
  const m = playMatch(course, [[a], [b]], { method: 'back' });
  assert.equal(m.finished, false);
  assert.equal(m.liveText, 'Graham 1 up with 15 to play');
  assert.equal(m.toPlay, 15);
  assert.equal(m.dormie, false);
});

// ---------- Countbacks and leaderboards ----------

function cardWith(points: number[]) {
  // Build par-based scores giving the requested points with handicap 0 (gross = par + 2 - points).
  const scores = course.holes.map((h, i) => (points[i] === 0 ? 'P' : h.par + 2 - points[i])) as HoleScore[];
  return stablefordCard(course, 0, scores);
}

test('Stableford countback: back 9, then last 6, then last 3, then hole by hole', () => {
  const base = Array(18).fill(2);
  const a = [...base]; a[0] = 3; a[17] = 1;      // 36 pts, back 9 = 17
  const b = [...base];                            // 36 pts, back 9 = 18 -> wins on back 9
  const c = [...base]; c[9] = 3; c[17] = 1;       // 36 pts, back 9 18, last 6 = 11 vs b's 12 -> loses on last 6
  const lb = dayStablefordLeaderboard([
    { player: 'A', card: cardWith(a) }, { player: 'B', card: cardWith(b) }, { player: 'C', card: cardWith(c) },
  ]);
  assert.deepEqual(lb.map(r => r.entry.player), ['B', 'C', 'A']);
  assert.match(lb[1].countbackNote!, /last 6/);
  assert.match(lb[2].countbackNote!, /back 9/);
});

test('Stableford countback falls through to the front 9 and shares rank if identical', () => {
  const a = Array(18).fill(2); a[3] = 3; a[8] = 1;   // differs only on the front: last 6 of front equal, last 3 of front a=5 vs 6
  const b = Array(18).fill(2);
  const c = Array(18).fill(2);
  const lb = dayStablefordLeaderboard([
    { player: 'A', card: cardWith(a) }, { player: 'B', card: cardWith(b) }, { player: 'C', card: cardWith(c) },
  ]);
  assert.deepEqual(lb.map(r => [r.entry.player, r.rank, r.tied]), [['B', 1, true], ['C', 1, true], ['A', 3, false]]);
  assert.match(lb[2].countbackNote!, /front last 3/);
});

test('Gross Stableford leaderboard: lower is better, no tie-breakers, equal scores show T2', () => {
  const g = players.map(p => ({ player: p.name, card: stablefordCard(course, p.handicap, p.scores) }));
  // Two scratch players on 75 (33 pts): X has the better back 9, Y the worse; Stableford countback would split them.
  const x = Array(18).fill(2); x[0] = 0; x[1] = 1;   // loses 3 points on the front
  const y = Array(18).fill(2); y[17] = 0; y[16] = 1; // loses 3 points on the back
  const lb = dayGrossStablefordLeaderboard([...g, { player: 'X', card: cardWith(x) }, { player: 'Y', card: cardWith(y) }]);
  assert.deepEqual(lb.map(r => [r.entry.player, rankLabel(r), r.entry.card.grossStableford]),
    [['Graham', '1', 72], ['X', 'T2', 73], ['Y', 'T2', 73], ['Nic', '4', 76], ['Col', '5', 90], ['Glen', '6', 96]]);
});

test('net stroke leaderboard: net = gross - handicap, stroke countback (back 9 - H/2 ...)', () => {
  const pars = course.holes.map(h => h.par);
  // A: handicap 10, gross 80 (net 70), back 9 = 40 -> 40 - 5 = 35
  // B: handicap 12, gross 82 (net 70), back 9 = 40 -> 40 - 6 = 34 -> B wins on countback
  const mk = (hcp: number, extraFront: number, extraBack: number) => {
    const sc = pars.map((p, i) => p + (i < 9 ? (i < extraFront ? 1 : 0) : (i - 9 < extraBack ? 1 : 0)));
    return stablefordCard(course, hcp, sc);
  };
  const a = mk(10, 5, 5);   // 70 + 10 = 80, back 9 = 35 + 5 = 40
  const b = mk(12, 7, 5);   // 70 + 12 = 82, back 9 = 40
  const lb = dayNetStrokeLeaderboard([{ player: 'A', card: a }, { player: 'B', card: b }]);
  assert.deepEqual(lb.map(r => [r.entry.player, r.entry.net, rankLabel(r)]), [['B', 70, '1'], ['A', 70, '2']]);
  assert.match(lb[1].countbackNote!, /back 9/);
});

test('multi-day aggregate: no countback, ties share rank, missed rounds go to the bottom', () => {
  const lb = aggregateLeaderboard([
    { player: 'Glen', rounds: [31, 33, 41] },
    { player: 'Chris', rounds: [25, 34, 46] },
    { player: 'Simon', rounds: [26, 38, 43] },
    { player: 'Jon', rounds: [29, null, 38] },
  ]);
  assert.deepEqual(lb.map(r => [r.entry.player, rankLabel(r), r.total, r.missedRounds]),
    [['Simon', '1', 107, false], ['Glen', 'T2', 105, false], ['Chris', 'T2', 105, false], ['Jon', '4', 67, true]]);
});

test('suggested points to win (administrator enters the actual figure)', () => {
  assert.deepEqual(pointsToWin(Array(32).fill(1)), { available: 32, toWin: 16.5, step: 0.5 });
  assert.deepEqual(pointsToWin(Array(35).fill(1)), { available: 35, toWin: 18, step: 0.5 });
  // Barnbougle weekend: 32 points incl. half-point matches; if a halved 0.5 match is worth 0.25 each, 16.25 wins.
  assert.equal(pointsToWin([...Array(30).fill(1), 0.5, 0.5, 0.5, 0.5]).toWin, 16.25);
});
