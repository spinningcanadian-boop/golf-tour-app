// Graham's mockup workbook, 29 Oct evening: stroke (net) sheet additions, Ambrose sheet, and finishing-hole cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stablefordCard } from '../src/core.ts';
import type { Course, HoleScore } from '../src/core.ts';
import { playMatch } from '../src/matchplay.ts';
import type { MatchPlayer } from '../src/matchplay.ts';
import { ambroseCard, playAmbroseMatch } from '../src/ambrose.ts';
import { dayNetStrokeLeaderboard, rankLabel, strokeKeys } from '../src/leaderboard.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const fx4 = load('woolooware-4ball.json');
const course: Course = fx4.course;
const players: MatchPlayer[] = fx4.players.map((p: any, k: number) => ({
  name: p.name, handicap: p.handicap, scores: fx4.gross.map((row: any[]) => row[k] as HoleScore) }));
const cards = players.map(p => ({ player: p.name, card: stablefordCard(course, p.handicap, p.scores) }));

// ---------- Stroke (net) ----------

test('stroke net: 66 / 74 / 67 and Glen DQ for his pickup on hole 1 (Stableford sheet L35:P35)', () => {
  const lb = dayNetStrokeLeaderboard(cards);
  const byName = new Map(lb.map(r => [r.entry.player, r]));
  fx4.players.forEach((p: any, k: number) => {
    const r = byName.get(p.name)!;
    if (fx4.stroke.net[k] === 'DQ') { assert.equal(rankLabel(r), 'DQ'); assert.equal(r.entry.net, null); }
    else assert.equal(r.entry.net, fx4.stroke.net[k], p.name);
  });
  assert.deepEqual(lb.map(r => [r.entry.player, rankLabel(r)]), [['Graham', '1'], ['Nic', '2'], ['Col', '3'], ['Glen', 'DQ']]);
});

test('stroke countback values: back 9 - H/2, last 6 - H/3, last 3 - H/6 match the sheet (L37:P39)', () => {
  players.forEach((p, k) => {
    const keys = strokeKeys(p.scores.map(x => (typeof x === 'number' ? x : 0)), p.handicap);
    if (p.scores.some(x => x === 'P')) return; // Glen is DQ; his countback row is not used
    assert.ok(Math.abs(keys[0].value - fx4.stroke.cbBack9[k]) < 1e-9, `${p.name} back 9`);
    assert.ok(Math.abs(keys[1].value - fx4.stroke.cbLast6[k]) < 1e-9, `${p.name} last 6`);
    assert.ok(Math.abs(keys[2].value - fx4.stroke.cbLast3[k]) < 1e-9, `${p.name} last 3`);
  });
});

// ---------- Ambrose ----------

const fa = load('woolooware-ambrose.json');
const acourse: Course = fa.course;

test('Ambrose: team handicaps 5.75 / 8.5, gross 65 / 70, net 59.25 / 61.5', () => {
  fa.teams.forEach((t: any, i: number) => {
    const c = ambroseCard(acourse, t);
    assert.equal(c.teamHandicap, fa.expected.teamCaps[i]);
    assert.equal(c.front9, fa.expected.front9[i]);
    assert.equal(c.back9, fa.expected.back9[i]);
    assert.equal(c.gross, fa.expected.gross[i]);
    assert.equal(c.pickups, fa.expected.pickups[i]);
    assert.equal(c.net, fa.expected.net[i]);
  });
});

test('Ambrose: a team pickup makes the net score DQ', () => {
  const t = { ...fa.teams[0], scores: ['P', ...fa.teams[0].scores.slice(1)] };
  const c = ambroseCard(acourse, t);
  assert.equal(c.dq, true);
  assert.equal(c.net, null);
});

test('Ambrose match: difference 2.75 deemed 3 strokes to Nic & Glen on the stroke index', () => {
  const m = playAmbroseMatch(acourse, fa.teams);
  assert.equal(m.difference, fa.expected.difference);
  assert.deepEqual(m.strokesReceived, fa.expected.deemed);
  m.holes.forEach((h, i) => assert.deepEqual(h.strokes.flat(), fa.expected.strokes[i], `hole ${h.hole} strokes`));
});

test('Ambrose match: points, hole results, status and "Team 1 Won 3 and 2" (Ambrose sheet)', () => {
  const code: Record<string, any> = { 'Team 1': 0, 'Team 2': 1, Halved: 'halved' };
  const m = playAmbroseMatch(acourse, fa.teams);
  m.holes.forEach((h, i) => {
    assert.deepEqual(h.points.flat(), fa.expected.points[i], `hole ${h.hole} points`);
    assert.equal(h.winner, code[fa.expected.result[i]], `hole ${h.hole} result`);
    if (h.hole <= 16) assert.equal(h.status, fa.expected.status[i], `hole ${h.hole} status`);
  });
  assert.equal(`Team ${(m.winner as number) + 1} Won ${m.resultText}`, fa.expected.matchResult);
});

test('Ambrose match: administrator can override the deemed strokes', () => {
  const m = playAmbroseMatch(acourse, fa.teams, { deemedStrokes: 2 });
  assert.deepEqual(m.strokesReceived, [0, 2]);
  assert.equal(m.holes[17].strokes[1][0], 1); // hole 18, stroke index 2: still a stroke
  assert.equal(m.holes[1].strokes[1][0], 0);  // hole 2, stroke index 3: no longer a stroke
});

// ---------- Singles and 2 v 1 from the same cards ----------

test('two singles in one group: Graham v Nic and Col v Glen (4-ball with partners removed)', () => {
  const a = playMatch(course, [[players[0]], [players[2]]], { method: 'front' });
  const b = playMatch(course, [[players[1]], [players[3]]], { method: 'front' });
  assert.ok(a.finished && b.finished);
  assert.ok(a.resultText && b.resultText);
});

test("2 v 1: Glen's one card counts in two half-point singles", () => {
  const m1 = playMatch(course, [[players[0]], [players[3]]], { method: 'back', value: 0.5 });
  const m2 = playMatch(course, [[players[1]], [players[3]]], { method: 'back', value: 0.5 });
  for (const m of [m1, m2]) assert.equal(m.points[0] + m.points[1], 0.5);
});

// ---------- Going up the 18th 1 up ----------

function finishing(last: 'halve' | 'lose' | 'win') {
  const pars = course.holes.map(h => h.par);
  const a: MatchPlayer = { name: 'A', handicap: 0, scores: [...pars] };
  const b: MatchPlayer = { name: 'B', handicap: 0, scores: [...pars] };
  b.scores[16] = pars[16] + 1;                 // A wins the 17th: 1 up playing the 18th
  if (last === 'lose') a.scores[17] = pars[17] + 1;
  if (last === 'win') b.scores[17] = pars[17] + 1;
  return playMatch(course, [[a], [b]], { method: 'back' });
}

test('1 up playing the 18th: halve = wins 1 up; lose = All Square (Halved); win = 2 up', () => {
  assert.deepEqual([finishing('halve').resultText, finishing('halve').winner], ['1 up', 0]);
  assert.deepEqual([finishing('lose').resultText, finishing('lose').winner], ['Halved', 'halved']);
  assert.deepEqual([finishing('win').resultText, finishing('win').winner], ['2 up', 0]);
});

// ---------- Dormie and live leaderboards (Graham's prototype feedback, 29 Oct) ----------
import { liveStablefordLeaderboard, liveNetLeaderboard } from '../src/leaderboard.ts';

test('dormie: 5 up with 5 to play is dormie; text reads "with n to play"', () => {
  const pars = course.holes.map(h => h.par);
  const a: MatchPlayer = { name: 'A', handicap: 0, scores: [...pars.slice(0, 13), ...Array(5).fill(null)] };
  const b: MatchPlayer = { name: 'B', handicap: 0, scores: [...pars.slice(0, 13), ...Array(5).fill(null)] };
  for (const i of [0, 2, 4, 6, 8]) b.scores[i] = pars[i] + 1; // A wins 5 holes
  const m = playMatch(course, [[a], [b]], { method: 'back' });
  assert.equal(m.holesPlayed, 13);
  assert.equal(m.dormie, true);
  assert.equal(m.holes[12].dormie, true);
  assert.equal(m.liveText, 'A 5 up with 5 to play (dormie)');
});

test('live Stableford: partial rounds placed among finished scores, below those they are level with', () => {
  const g = cards.find(c => c.player === 'Graham')!;           // 40 pts, finished
  const partial = stablefordCard(course, 6, [...players[0].scores.slice(0, 15), null, null, null] as HoleScore[]);
  const lb = liveStablefordLeaderboard([...cards, { player: 'Partial', card: partial }]);
  const order = lb.map(r => [r.player, r.thru, r.card.points, rankLabel(r)]);
  // Partial = Graham's first 15 holes = 40 - (2+2+3) = 33 points thru 15: sits between Glen (35) and Col (32)
  assert.deepEqual(order, [['Graham', 18, 40, '1'], ['Nic', 18, 39, '2'], ['Glen', 18, 35, '3'], ['Partial', 15, 33, '4'], ['Col', 18, 32, '5']]);
  assert.ok(g);
});

test('live Stableford: a partial round level with a finisher shares the rank and sits below', () => {
  const p = stablefordCard(course, 9, [...players[2].scores.slice(0, 17), null] as HoleScore[]); // Nic minus hole 18 (4 pts) = 35
  const lb = liveStablefordLeaderboard([...cards, { player: 'NicPart', card: p }]);
  const glen = lb.findIndex(r => r.player === 'Glen'), part = lb.findIndex(r => r.player === 'NicPart');
  assert.equal(part, glen + 1);
  assert.equal(rankLabel(lb[part]), 'T3');
  assert.equal(rankLabel(lb[glen]), 'T3');
});

test('countback note sits with the player ahead; identical cards show tied on all countbacks', () => {
  const twin = { player: 'Twin', card: stablefordCard(course, 6, players[0].scores) };
  const x = Array(18).fill(2); x[0] = 0; x[1] = 1;   // 33 pts, better back 9
  const y = Array(18).fill(2); y[17] = 0; y[16] = 1; // 33 pts, worse back 9
  const mk = (pts: number[]) => stablefordCard(course, 0, course.holes.map((h, i) => (pts[i] === 0 ? 'P' : h.par + 2 - pts[i])) as HoleScore[]);
  const lb = liveStablefordLeaderboard([...cards, twin, { player: 'X', card: mk(x) }, { player: 'Y', card: mk(y) }]);
  const by = (n: string) => lb.find(r => r.player === n)!;
  assert.equal(by('Graham').tiedAllCountbacks, true);
  assert.equal(by('Twin').tiedAllCountbacks, true);
  assert.equal(rankLabel(by('Graham')), 'T1');
  assert.deepEqual(by('X').aheadOn, { other: 'Y', label: 'back 9' });
  assert.equal(by('Y').aheadOn, undefined);
});

test('live net: to par through holes played, total net when finished, DQ at the bottom', () => {
  const partial = stablefordCard(course, 6, [...players[0].scores.slice(0, 9), ...Array(9).fill(null)] as HoleScore[]);
  const lb = liveNetLeaderboard([...cards, { player: 'Front9', card: partial }]);
  const row = (n: string) => lb.find(r => r.player === n)!;
  assert.equal(row('Graham').net, 66);
  assert.equal(row('Graham').netToPar, -4);          // 66 v par 70
  assert.equal(row('Front9').net, undefined);
  assert.equal(row('Front9').netToPar, 38 - 35 - 3);  // front 9: gross 38, par 35, 3 shots = 0
  assert.equal(row('Glen').dq, true);
  assert.equal(lb[lb.length - 1].player, 'Glen');
});
