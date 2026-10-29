import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutThroat } from '../src/cutthroat.ts';

// Simple course: all par 4, stroke index = hole number.
const course: any = { name: 'Test', holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndexes: [i + 1], matchIndexes: [i + 1] })) };
const all = (v: any) => Array(18).fill(v);

test('best Stableford score wins the hole outright; ties halve it', () => {
  const a = all(4), b = all(4), c = all(4);
  a[0] = 3;            // hole 1: A birdie (3 pts) beats pars (2 pts)
  b[1] = 3; c[1] = 3;  // hole 2: B and C both birdie: halved, no carry-over
  const r = cutThroat(course, [{ name: 'A', handicap: 0, scores: a }, { name: 'B', handicap: 0, scores: b }, { name: 'C', handicap: 0, scores: c }]);
  assert.equal(r.holes[0].winner, 0);
  assert.equal(r.holes[1].winner, null); assert.equal(r.holes[1].halved, true);
  assert.equal(r.holes[2].halved, true);           // all par: halved, nothing carries to hole 4
  assert.deepEqual(r.wins, [1, 0, 0]);
  assert.equal(r.halved, 17); assert.equal(r.finished, true);
  assert.deepEqual(r.standings[0], { player: 0, wins: 1, rank: 1, tied: false });
  assert.deepEqual(r.standings.slice(1).map(s => [s.rank, s.tied]), [[2, true], [2, true]]);
});

test('handicap shots count: a net par can beat a gross par', () => {
  const r = cutThroat(course, [{ name: 'Low', handicap: 0, scores: all(4) }, { name: 'High', handicap: 18, scores: all(4) }]);
  assert.deepEqual(r.wins, [0, 18]);   // High gets a shot on every hole: 3 pts v 2 pts
});

test('a hole only counts once every player has a score; pickups score 0 points', () => {
  const a = all(null), b = all(null), c = all(null);
  a[0] = 'P'; b[0] = 6; c[0] = 4;     // hole 1: C par (2) beats B double (0) and A pickup (0)
  a[1] = 4; b[1] = 4;                 // hole 2: C has not scored yet
  const r = cutThroat(course, [{ name: 'A', handicap: 0, scores: a }, { name: 'B', handicap: 0, scores: b }, { name: 'C', handicap: 0, scores: c }]);
  assert.equal(r.holes[0].winner, 2);
  assert.equal(r.holes[1].winner, null); assert.equal(r.holes[1].halved, false);
  assert.equal(r.holesPlayed, 1); assert.equal(r.finished, false);
});
