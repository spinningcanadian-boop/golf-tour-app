import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noveltyStats } from '../src/novelty.ts';

const pars = [4, 4, 4, 3, 4, 4, 4, 5, 3, 3, 4, 5, 4, 5, 4, 3, 3, 4];
const round = (player: string, scores: any[], session = 's1') => ({ player, session, pars, scores });

test('bogey train counts bogeys, doubles and pickups in a row, with the hole range', () => {
  const a = pars.map(p => p);                       // all pars
  a[3] = 4; a[4] = 6; a[5] = 'P'; a[6] = 5;         // holes 4-7: bogey, double, pickup, bogey
  const s = noveltyStats([round('A', a)]);
  assert.deepEqual(s.bogeyTrain[0].item, { player: 'A', session: 's1', length: 4, from: 4, to: 7, toPar: null });
});

test('par train counts par or better; a bogey or a pickup breaks it', () => {
  const a = pars.map(p => p); a[9] = pars[9] + 1;  // bogey on 10 splits 1-9 (9 holes) and 11-18 (8 holes)
  const b = pars.map(p => p); b[0] = 'P';          // pickup on 1: par train 2-18 (17 holes)
  const s = noveltyStats([round('A', a), round('B', b)]);
  // A has two trains (1-9 and 11-18): both listed
  assert.deepEqual(s.parTrain.map(r => [r.item.player, r.item.length, r.item.from, r.item.to]), [['B', 17, 2, 18], ['A', 9, 1, 9], ['A', 8, 11, 18]]);
  assert.equal(s.parTrain[0].item.toPar, 0);
});

test('unplayed holes break a train', () => {
  const a = pars.map(p => p + 1); a[9] = null;
  const s = noveltyStats([round('A', a)]);
  assert.equal(s.bogeyTrain[0].item.length, 9);
});

test('birdies (or better) and pars totals, ties shared', () => {
  const mk = (b: number, e: number) => pars.map((p, i) => (i < b ? p - 1 : i < b + e ? p - 2 : p + 1));
  const s = noveltyStats([round('A', mk(3, 1)), round('B', mk(4, 0)), round('C', mk(2, 0)), round('D', mk(1, 0)), round('E', mk(2, 0))]);
  assert.deepEqual(s.birdies.map(r => [r.item.player, r.item.count, r.rank, r.tied]),
    [['A', 4, 1, true], ['B', 4, 1, true], ['C', 2, 3, true], ['E', 2, 3, true], ['D', 1, 5, false]]);
  const p = noveltyStats([round('A', pars.map(x => x)), round('B', pars.map((x, i) => (i < 5 ? x : x + 1)))]);
  assert.deepEqual(p.pars.map(r => [r.item.player, r.item.count]), [['A', 18], ['B', 5]]);
});

test('across several sessions totals add up and trains stay within a round', () => {
  const a1 = pars.map((p, i) => (i >= 15 ? p + 1 : p));    // bogeys 16-18
  const a2 = pars.map((p, i) => (i <= 2 ? p + 1 : p));     // bogeys 1-3 next session: not joined to 16-18
  const s = noveltyStats([round('A', a1, 's1'), round('A', a2, 's2')]);
  assert.equal(s.bogeyTrain[0].item.length, 3);
  assert.equal(s.pars[0].item.count, 30);
});

test('par or better train shows strokes under par; same length lists the better score first', () => {
  const a = pars.map(p => p + 1); a[0] = pars[0] - 1; a[1] = pars[1]; a[2] = pars[2] - 1;  // holes 1-3: -2
  const b = pars.map(p => p + 1); b[5] = pars[5]; b[6] = pars[6]; b[7] = pars[7];         // holes 6-8: E
  const s = noveltyStats([round('B', b), round('A', a)]);
  assert.deepEqual(s.parTrain.map(r => [r.item.player, r.item.length, r.item.toPar, r.rank]), [['A', 3, -2, 1], ['B', 3, 0, 1]]);
});

test('top 5 by default; a single hole is not a train', () => {
  const r = (name: string, len: number) => round(name, pars.map((p, i) => (i < len ? p : p + 1)));
  const s = noveltyStats([r('A', 9), r('B', 8), r('C', 7), r('D', 6), r('E', 5), r('F', 4), r('G', 1)]);
  assert.deepEqual(s.parTrain.map(x => x.item.player), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(s.parTrain.some(x => x.item.player === 'G'), false);
});
