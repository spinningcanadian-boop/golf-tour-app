// Core scoring: strokes per hole, Stableford points, Gross Stableford.
// Rules as agreed in the Golf App brief (Ver1, 28 Oct 2026 revision).

export interface Hole {
  number: number;          // 1..18
  par: number;
  /**
   * "Front of the card" indexes as printed: [1-18, 19-36, 37-54].
   * The 19-36 and 37-54 orderings are NOT always index+18 (e.g. Woolooware hole 5: 9, 23, 41).
   * If only the first is given, the others default to +18 / +36.
   */
  strokeIndexes: number[];
  /** "Back of the card" match play index(es), same convention. */
  matchIndexes: number[];
}

/** Full [1-18, 19-36, 37-54] index triple, filling missing tiers with +18 / +36. */
export function indexTiers(indexes: number[]): [number, number, number] {
  const i1 = indexes[0];
  return [i1, indexes[1] ?? i1 + 18, indexes[2] ?? i1 + 36];
}

export interface Course {
  name: string;
  tee: string;
  holes: Hole[];        // 18 holes in playing order 1..18
}

/** A hole score: gross strokes, "P" for pickup / wiped hole, or null if not yet entered. */
export type HoleScore = number | 'P' | null;

/**
 * Strokes received on a hole for a given handicap and the hole's index tiers.
 * Same as the workbook: (idx1<=h) + (idx2<=h) + (idx3<=h).
 * Plus handicaps (negative) give strokes back starting from index 18 downwards.
 */
export function strokesOnHole(handicap: number, indexes: number[]): number {
  const h = Math.round(handicap);
  if (h < 0) return indexes[0] > 18 + h ? -1 : 0;
  return indexTiers(indexes).filter(i => i <= h).length;
}

/** Stableford points on one hole: P -> 0, otherwise MAX(2 + par + strokes - gross, 0). null if not entered. */
export function stablefordPoints(par: number, strokes: number, score: HoleScore): number | null {
  if (score === null) return null;
  if (score === 'P') return 0;
  return Math.max(2 + par + strokes - score, 0);
}

/**
 * Adjusted gross for a hole: par + strokes + 2 - points.
 * Equals the real gross when points > 0, and caps a pickup / zero-point hole at net double bogey.
 * Summed over 18 holes it equals the brief's Gross Stableford: Par + Handicap + (36 - Points).
 */
export function adjustedGross(par: number, strokes: number, points: number): number {
  return par + strokes + 2 - points;
}

export interface HoleLine {
  hole: number;
  par: number;
  score: HoleScore;
  strokes: number;
  points: number | null;
  adjustedGross: number | null;
}

export interface StablefordCard {
  handicap: number;
  holes: HoleLine[];
  front9: number;
  back9: number;
  points: number;
  holesEntered: number;
  complete: boolean;
  /** Course Par + Handicap + (36 - Points); only meaningful once complete. */
  grossStableford: number | null;
}

export function stablefordCard(course: Course, handicap: number, scores: HoleScore[]): StablefordCard {
  const holes: HoleLine[] = course.holes.map((h, i) => {
    const strokes = strokesOnHole(handicap, h.strokeIndexes);
    const score = scores[i] ?? null;
    const points = stablefordPoints(h.par, strokes, score);
    return {
      hole: h.number, par: h.par, score, strokes, points,
      adjustedGross: points === null ? null : adjustedGross(h.par, strokes, points),
    };
  });
  const sum = (from: number, to: number) =>
    holes.filter(l => l.hole >= from && l.hole <= to).reduce((a, l) => a + (l.points ?? 0), 0);
  const holesEntered = holes.filter(l => l.score !== null).length;
  const complete = holesEntered === course.holes.length;
  const points = sum(1, 18);
  const coursePar = course.holes.reduce((a, h) => a + h.par, 0);
  return {
    handicap, holes,
    front9: sum(1, 9), back9: sum(10, 18), points,
    holesEntered, complete,
    grossStableford: complete ? coursePar + Math.round(handicap) + (36 - points) : null,
  };
}

/** Ambrose team handicap: total of the players' handicaps divided by 4, 6 or 8 for 2, 3 or 4 players. */
export function ambroseTeamHandicap(handicaps: number[]): number {
  const n = handicaps.length;
  if (n < 2 || n > 4) throw new Error(`Ambrose teams are 2-4 players, got ${n}`);
  return handicaps.reduce((a, b) => a + b, 0) / (2 * n);
}

/** Gross Stableford from a round total: Course Par + Handicap + (36 - Points). */
export function grossStablefordFromPoints(coursePar: number, handicap: number, points: number): number {
  return coursePar + Math.round(handicap) + (36 - points);
}
