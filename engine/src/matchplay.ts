// Match play: singles and 4-ball (1 or 2 players a side), front or back of the card.
import { stablefordPoints, strokesOnHole } from './core.ts';
import type { Course, HoleScore } from './core.ts';

export type HandicapMethod = 'front' | 'back';

export interface MatchPlayer {
  name: string;
  handicap: number;
  scores: HoleScore[];
}

export interface MatchHole {
  hole: number;
  /** Strokes each player receives on this hole for match purposes, [side][player]. */
  strokes: number[][];
  /** Points each player scores for match purposes, [side][player]. */
  points: (number | null)[][];
  /** Best points per side. */
  best: [number | null, number | null];
  winner: 0 | 1 | 'halved' | null;   // null = not yet played by both sides
  /** Running status from side 0's view: +2 = side 0 two up. Frozen once the match is decided. */
  status: number;
  /** Text per brief: "1 up" (with the side), "AS". */
  display: string;
  holesRemaining: number;
  /** True when the leading side is as many holes up as there are holes left (and the match is still live). */
  dormie: boolean;
}

export interface MatchResult {
  holes: MatchHole[];
  holesPlayed: number;
  finished: boolean;
  winner: 0 | 1 | 'halved' | null;
  /** e.g. "3 and 2", "1 up", "2 up", "Halved" */
  resultText: string | null;
  /** Hole on which the match was decided, if before the 18th. */
  decidedOn: number | null;
  /** Points awarded to each side given the match value (1 or 0.5). */
  points: [number, number];
  /** Live text, e.g. "Graham & Col 2 up with 7 to play", "Graham & Col 5 up with 5 to play (dormie)". */
  liveText: string;
  /** Holes still to play in a live match (18 - holes played). */
  toPlay: number;
  /** Live match is dormie after the last hole played. */
  dormie: boolean;
}

export interface MatchOptions {
  method: HandicapMethod;
  /** Points the match is worth (1 or 0.5). Default 1. */
  value?: number;
  sideNames?: [string, string];
}

/**
 * Strokes per player for match purposes.
 * front: each player's full playing handicap on the stroke index (as per the 4-ball mockup).
 * back:  each player's handicap less the lowest handicap in the match, on the match play index.
 */
function matchStrokes(course: Course, sides: MatchPlayer[][], method: HandicapMethod): number[][][] {
  const low = Math.min(...sides.flat().map(p => p.handicap));
  return course.holes.map(h =>
    sides.map(side => side.map(p =>
      method === 'front'
        ? strokesOnHole(p.handicap, h.strokeIndexes)
        : strokesOnHole(Math.round(p.handicap - low), h.matchIndexes))));
}

/**
 * Plays a match hole by hole. A hole goes to the side whose best player scores more points
 * (points = MAX(2 + par + strokes - gross, 0), pickup = 0). Equal best points halve the hole,
 * which means two sides who both wipe a hole halve it.
 */
export function playMatch(course: Course, sides: [MatchPlayer[], MatchPlayer[]], opts: MatchOptions): MatchResult {
  const value = opts.value ?? 1;
  const names = opts.sideNames ?? [sides[0].map(p => p.name).join(' & '), sides[1].map(p => p.name).join(' & ')];
  const strokes = matchStrokes(course, sides, opts.method);
  const n = course.holes.length;

  let status = 0;
  let decidedOn: number | null = null;
  let holesPlayed = 0;
  const holes: MatchHole[] = course.holes.map((h, i) => {
    const pts = sides.map((side, s) => side.map((p, k) => stablefordPoints(h.par, strokes[i][s][k], p.scores[i] ?? null)));
    // A side's best: max of entered scores; a side with no entries yet is null.
    const best = pts.map(arr => {
      const vals = arr.filter((x): x is number => x !== null);
      return vals.length ? Math.max(...vals) : null;
    }) as [number | null, number | null];
    // For a 4-ball, require every player on both sides to have an entry before settling the hole.
    const allIn = pts.every(arr => arr.every(x => x !== null));
    let winner: MatchHole['winner'] = null;
    if (allIn && best[0] !== null && best[1] !== null) {
      winner = best[0] === best[1] ? 'halved' : best[0] > best[1] ? 0 : 1;
      holesPlayed = i + 1;
      if (decidedOn === null) {
        if (winner === 0) status++;
        if (winner === 1) status--;
        if (n - (i + 1) > 0 && Math.abs(status) > n - (i + 1)) decidedOn = h.number;
      }
    }
    const display = status === 0 ? 'AS' : `${names[status > 0 ? 0 : 1]} ${Math.abs(status)} up`;
    const dormie = winner !== null && decidedOn === null && status !== 0 && Math.abs(status) === n - (i + 1);
    return { hole: h.number, strokes: strokes[i], points: pts, best, winner, status, display, holesRemaining: n - (i + 1), dormie };
  });

  const finished = decidedOn !== null || holesPlayed === n;
  let winner: MatchResult['winner'] = null;
  let resultText: string | null = null;
  if (finished) {
    if (status === 0) { winner = 'halved'; resultText = 'Halved'; }
    else {
      winner = status > 0 ? 0 : 1;
      const remaining = n - (decidedOn ?? n);
      resultText = remaining > 0 ? `${Math.abs(status)} and ${remaining}` : `${Math.abs(status)} up`;
    }
  }
  const points: [number, number] =
    winner === null ? [0, 0] : winner === 'halved' ? [value / 2, value / 2] : winner === 0 ? [value, 0] : [0, value];
  const toPlay = n - holesPlayed;
  const dormie = !finished && holesPlayed > 0 && status !== 0 && Math.abs(status) === toPlay;
  const liveText = finished
    ? (winner === 'halved' ? 'Halved' : `${names[winner as 0 | 1]} won ${resultText}`)
    : holesPlayed === 0 ? 'Not started'
    : `${status === 0 ? 'AS' : `${names[status > 0 ? 0 : 1]} ${Math.abs(status)} up`} with ${toPlay} to play${dormie ? ' (dormie)' : ''}`;

  return { holes, holesPlayed, finished, winner, resultText, decidedOn, points, liveText, toPlay, dormie };
}
