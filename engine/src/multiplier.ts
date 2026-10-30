// Team Multiplier Stableford (novelty): on each hole the Stableford points of everyone in the group are
// multiplied together. Any 0 (including a pickup) wipes the hole for the team. Team total = sum of the hole products.
// Groups smaller than fillTo (normally 4) are made up with dummy players who score dummyPoints (normally 2) on every hole.
import type { Course, HoleScore } from './core.ts';
import { stablefordCard } from './core.ts';

export interface MultiplierPlayer { handicap: number; scores: HoleScore[] }
export interface MultiplierResult { holes: (number | null)[]; total: number; thru: number; complete: boolean; dummies: number }

export function teamMultiplier(course: Course, players: MultiplierPlayer[], opts: { fillTo?: number; dummyPoints?: number } = {}): MultiplierResult {
  const dummies = Math.max(0, (opts.fillTo ?? 0) - players.length); const dummyFactor = (opts.dummyPoints ?? 2) ** dummies;
  const cards = players.map(p => stablefordCard(course, p.handicap, p.scores));
  const holes = course.holes.map((_, i) => {
    if (!cards.length) return null;
    const pts = cards.map(c => c.holes[i].points);
    if (pts.some(p => p === null)) return null;            // waiting for someone's score
    return (pts as number[]).reduce((a, b) => a * b, dummyFactor);
  });
  const done = holes.filter(h => h !== null) as number[];
  return { holes, total: done.reduce((a, b) => a + b, 0), thru: done.length, complete: done.length === course.holes.length, dummies };
}
