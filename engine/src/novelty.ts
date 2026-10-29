// Novelty stats: bogey train, par train, birdies, pars. Works on gross scores against par.
import type { HoleScore } from './core.ts';

export interface RoundInput {
  player: string;        // player id
  session: string;       // session id (or label)
  pars: number[];        // par for holes 1..18
  scores: HoleScore[];   // gross per hole, 'P' for pickup, null if not entered
}

export interface Streak { player: string; session: string; length: number; from: number; to: number }
export interface Count { player: string; count: number }
export interface Ranked<T> { rank: number; tied: boolean; item: T }

const isBogeyOrWorse = (s: HoleScore, par: number) => s === 'P' || (typeof s === 'number' && s >= par + 1);
const isParOrBetter = (s: HoleScore, par: number) => typeof s === 'number' && s <= par;

/** Every maximal run of consecutive holes (within one round) meeting the test. Unplayed holes break a run. */
function runs(r: RoundInput, test: (s: HoleScore, par: number) => boolean): Streak[] {
  const out: Streak[] = []; let start = -1;
  for (let i = 0; i <= r.scores.length; i++) {
    const ok = i < r.scores.length && r.scores[i] !== null && test(r.scores[i], r.pars[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) { out.push({ player: r.player, session: r.session, length: i - start, from: start + 1, to: i }); start = -1; }
  }
  return out;
}

/** Top n by value; anyone level with the nth place is included (shared rank). */
function topN<T>(items: T[], value: (t: T) => number, n: number): Ranked<T>[] {
  const sorted = [...items].filter(t => value(t) > 0).sort((a, b) => value(b) - value(a));
  const ranks: number[] = [];
  sorted.forEach((t, i) => ranks.push(i > 0 && value(sorted[i - 1]) === value(t) ? ranks[i - 1] : i + 1));
  return sorted.map((item, i) => ({ rank: ranks[i], tied: ranks.filter(r => r === ranks[i]).length > 1, item })).filter(r => r.rank <= n);
}

export function noveltyStats(rounds: RoundInput[], n = 3) {
  // Longest run per player per round (a player's second-longest run in the same round is not listed separately).
  const best = (test: (s: HoleScore, par: number) => boolean) => rounds.map(r => runs(r, test).sort((a, b) => b.length - a.length || a.from - b.from)[0]).filter(Boolean) as Streak[];
  const tally = (test: (s: HoleScore, par: number) => boolean): Count[] => {
    const m = new Map<string, number>();
    for (const r of rounds) r.scores.forEach((s, i) => { if (s !== null && test(s, r.pars[i])) m.set(r.player, (m.get(r.player) || 0) + 1); });
    return [...m].map(([player, count]) => ({ player, count }));
  };
  return {
    bogeyTrain: topN(best(isBogeyOrWorse), s => s.length, n),
    parTrain: topN(best(isParOrBetter), s => s.length, n),
    birdies: topN(tally((s, p) => typeof s === 'number' && s <= p - 1), c => c.count, n),
    pars: topN(tally((s, p) => typeof s === 'number' && s === p), c => c.count, n),
  };
}
