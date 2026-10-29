// Validation against the Barnbougle tour results (GolfTour - Tour 15 Sep 26 Working.xlsx).
// That workbook holds round totals, not hole-by-hole scores, so this checks the leaderboard and summary logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { grossStablefordFromPoints } from '../src/core.ts';
import { aggregateLeaderboard, sessionTotals, pointsToWin, rankLabel } from '../src/leaderboard.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/barnbougle-2026.json', import.meta.url), 'utf8'));
const roundsOf = (p: any) => p.stab.map((x: any) => (x === null || x === 0 ? null : x));

test('Barnbougle: 3-round Stableford aggregate ranks match the Results sheet for all 27 players', () => {
  const lb = aggregateLeaderboard(fx.aggregate.map((a: any) => ({ player: a.player, rounds: a.rounds })));
  const sheet = new Map(fx.aggregate.map((a: any) => [a.player, a.rank]));
  for (const r of lb) assert.equal(r.rank, sheet.get(r.entry.player), `${r.entry.player} rank`);
  assert.deepEqual(lb.slice(-2).map(r => [r.entry.player, r.missedRounds]), [['Jon Meerkat', true], ['Alan Lancaster', true]]);
  assert.deepEqual(lb.slice(1, 4).map(rankLabel), ['T2', 'T2', 'T2']);
});

test('Barnbougle: Gross Stableford per round = par used + tour cap + (36 - points) for every player', () => {
  const pars = [fx.pars.AG4, fx.pars.AH4, fx.pars.AI4];
  let checked = 0;
  for (const p of fx.players) {
    p.stab.forEach((pts: any, i: number) => {
      if (pts === null || pts === 0) return;
      assert.equal(grossStablefordFromPoints(pars[i], p.cap, pts), p.gross[i], `${p.player} R${i + 1}`);
      checked++;
    });
  }
  assert.ok(checked >= 75, `checked ${checked} rounds`);
});

test('Barnbougle: Gross Stableford aggregate ranks (lower is better, ties shared) match the Data sheet', () => {
  const players = fx.players.filter((p: any) => p.gross.every((g: any) => typeof g === 'number'));
  const lb = aggregateLeaderboard(players.map((p: any) => ({ player: p.player, rounds: p.gross })), 'lower');
  for (const r of lb) {
    const p = players.find((x: any) => x.player === r.entry.player);
    assert.equal(r.rank, p.grossRank, `${p.player}`);
  }
});

test('Barnbougle: Ambrose net = gross - team handicap and ranking order', () => {
  for (const t of fx.ambrose) assert.ok(Math.abs(t.gross - t.cap - t.net) < 0.01, t.team);
  const lb = aggregateLeaderboard(fx.ambrose.map((t: any) => ({ player: t.team, rounds: [t.net] })), 'lower');
  assert.deepEqual(lb.map(r => r.entry.player), fx.ambrose.map((t: any) => t.team));
  // Sheet shows 9 and 10 for the two teams on 37.5; with no Ambrose countback the engine shows T9 for both.
  assert.deepEqual(lb.slice(8, 10).map(rankLabel), ['T9', 'T9']);
});

test('Barnbougle: session and weekend totals for the Ryder Cup panel', () => {
  const s = fx.sessions;
  const tot = (day: string) => sessionTotals(s.matches[day].map((m: any) => ({ points: [m.fbPts, m.jbPts] })));
  assert.deepEqual(tot('fri'), s.fri);
  assert.deepEqual(tot('sat'), s.sat);
  assert.deepEqual(tot('sun'), s.sun);
  const all = sessionTotals([tot('fri'), tot('sat'), tot('sun')].map(p => ({ points: p as [number, number] })));
  assert.deepEqual(all, s.total);
  assert.equal(pointsToWin(Array(all[0] + all[1]).fill(1)).toWin, 16.5);
  assert.match(s.toWin, /^16\.5/);
});
