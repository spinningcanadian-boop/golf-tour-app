import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamMultiplier } from '../src/multiplier.ts';

const course: any = { name: 'Test', holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, strokeIndexes: [i + 1], matchIndexes: [i + 1] })) };
const all = (v: any) => Array(18).fill(v);

test("hole score is the product of everyone's Stableford points; total is the sum", () => {
  const a = all(4), b = all(4), c = all(4);
  a[0] = 3;                                  // hole 1: 3 x 2 x 2 = 12; other holes 2 x 2 x 2 = 8
  const r = teamMultiplier(course, [{ handicap: 0, scores: a }, { handicap: 0, scores: b }, { handicap: 0, scores: c }]);
  assert.equal(r.holes[0], 12); assert.equal(r.holes[1], 8);
  assert.equal(r.total, 12 + 17 * 8); assert.equal(r.complete, true);
});

test('a pickup or any zero wipes the hole for the team', () => {
  const a = all(4), b = all(4);
  a[0] = 'P'; b[1] = 7;                      // hole 1 pickup, hole 2 triple (0 pts)
  const r = teamMultiplier(course, [{ handicap: 0, scores: a }, { handicap: 0, scores: b }]);
  assert.equal(r.holes[0], 0); assert.equal(r.holes[1], 0); assert.equal(r.holes[2], 4);
});

test('handicap shots count, and a hole waits until everyone has scored', () => {
  const a = all(null), b = all(null);
  a[0] = 4; b[0] = 4; a[1] = 4;
  const r = teamMultiplier(course, [{ handicap: 18, scores: a }, { handicap: 0, scores: b }]);
  assert.equal(r.holes[0], 3 * 2); assert.equal(r.holes[1], null); assert.equal(r.thru, 1); assert.equal(r.total, 6);
});

test('groups of 2 or 3 are made up to 4 with dummy players on 2 points a hole', () => {
  const a = all(4), b = all(4), c = all(4);
  const three = teamMultiplier(course, [{ handicap: 0, scores: a }, { handicap: 0, scores: b }, { handicap: 0, scores: c }], { fillTo: 4, dummyPoints: 2 });
  assert.equal(three.holes[0], 2 * 2 * 2 * 2); assert.equal(three.dummies, 1);
  const two = teamMultiplier(course, [{ handicap: 0, scores: a }, { handicap: 0, scores: b }], { fillTo: 4, dummyPoints: 2 });
  assert.equal(two.holes[0], 16); assert.equal(two.dummies, 2);
  const wiped = teamMultiplier(course, [{ handicap: 0, scores: all('P') }], { fillTo: 4 });
  assert.equal(wiped.total, 0);
});
