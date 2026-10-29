// Cut throat: each player plays for themselves. On each hole the best Stableford score (full handicap)
// wins the hole outright; if two or more share the best score the hole is halved. No carry-overs.
// The player who wins the most holes wins (often about 4, as many holes are halved).
import type { Course, HoleScore } from './core.ts';
import { stablefordCard } from './core.ts';

export interface CutThroatPlayer { name: string; handicap: number; scores: HoleScore[] }
export interface CutThroatHole { points: (number | null)[]; winner: number | null; halved: boolean }
export interface CutThroatResult {
  holes: CutThroatHole[];   // winner = index of the player who won the hole; null if halved or not everyone has scored
  wins: number[];           // holes won by each player
  halved: number;           // holes halved so far
  holesPlayed: number;      // holes where every player has a score
  finished: boolean;
  standings: { player: number; wins: number; rank: number; tied: boolean }[];
}

export function cutThroat(course: Course, players: CutThroatPlayer[]): CutThroatResult {
  const cards = players.map(p => stablefordCard(course, p.handicap, p.scores));
  const holes = course.holes.map((_, i) => {
    const points = cards.map(c => c.holes[i].points);
    if (points.some(p => p === null)) return { points, winner: null, halved: false };
    const best = Math.max(...(points as number[]));
    const at = points.flatMap((p, k) => (p === best ? [k] : []));
    return at.length === 1 ? { points, winner: at[0], halved: false } : { points, winner: null, halved: true };
  });
  const wins = players.map((_, k) => holes.filter(h => h.winner === k).length);
  const holesPlayed = holes.filter(h => h.winner !== null || h.halved).length;
  const order = wins.map((w, k) => ({ player: k, wins: w })).sort((a, b) => b.wins - a.wins);
  const standings = order.map(o => ({ ...o, rank: 1 + order.filter(x => x.wins > o.wins).length, tied: order.filter(x => x.wins === o.wins).length > 1 }));
  return { holes, wins, halved: holes.filter(h => h.halved).length, holesPlayed, finished: holesPlayed === course.holes.length, standings };
}
