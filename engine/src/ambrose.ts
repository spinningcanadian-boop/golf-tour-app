// Ambrose: one team score per hole. 2-, 3- or 4-man teams for stroke; 2-man teams for match play.
import { ambroseTeamHandicap } from './core.ts';
import type { Course, HoleScore } from './core.ts';
import { playMatch } from './matchplay.ts';
import type { MatchResult } from './matchplay.ts';

export interface AmbroseTeam {
  name: string;
  /** Playing handicaps of the team members (2, 3 or 4 players). */
  handicaps: number[];
  /** One team gross score per hole; "P" = pickup (makes the net stroke score DQ). */
  scores: HoleScore[];
}

export interface AmbroseCard {
  team: string;
  teamHandicap: number;     // total / 4, 6 or 8 – kept fractional (e.g. 5.75)
  front9: number;
  back9: number;
  gross: number;
  pickups: number;
  /** gross − team handicap; null when the team picked up on any hole (DQ). */
  net: number | null;
  dq: boolean;
  toPar: number;
  complete: boolean;
}

export function ambroseCard(course: Course, team: AmbroseTeam): AmbroseCard {
  const teamHandicap = ambroseTeamHandicap(team.handicaps);
  const n = (x: HoleScore) => (typeof x === 'number' ? x : 0);
  const sum = (a: number, b: number) => team.scores.slice(a - 1, b).reduce<number>((t, x) => t + n(x), 0);
  const pickups = team.scores.filter(x => x === 'P').length;
  const complete = team.scores.length === course.holes.length && team.scores.every(x => x !== null);
  const gross = sum(1, 18);
  const par = course.holes.reduce((t, h) => t + h.par, 0);
  return {
    team: team.name, teamHandicap,
    front9: sum(1, 9), back9: sum(10, 18), gross, pickups,
    dq: pickups > 0,
    net: pickups > 0 ? null : gross - teamHandicap,
    toPar: gross - par,
    complete,
  };
}

export interface AmbroseMatchOptions {
  /**
   * Strokes the higher-handicap team receives, as set by the administrator.
   * Default: the team handicap difference rounded to the nearest whole stroke (2.75 -> 3).
   */
  deemedStrokes?: number;
  /** Index the strokes fall on: the stroke index (front of card, default) or the match play index. */
  index?: 'stroke' | 'match';
  value?: number;
}

export interface AmbroseMatchResult extends MatchResult {
  teamHandicaps: [number, number];
  difference: number;        // team 1 cap − team 2 cap
  strokesReceived: [number, number];
}

/**
 * 2-man Ambrose match play (as Graham's Ambrose mockup, 29 Oct):
 * the higher-handicap team receives the deemed strokes, allocated on the stroke index;
 * each hole is won on Stableford points from the team score.
 */
export function playAmbroseMatch(course: Course, teams: [AmbroseTeam, AmbroseTeam], opts: AmbroseMatchOptions = {}): AmbroseMatchResult {
  const caps = teams.map(t => ambroseTeamHandicap(t.handicaps)) as [number, number];
  const difference = caps[0] - caps[1];
  const deemed = opts.deemedStrokes ?? Math.round(Math.abs(difference));
  const strokesReceived: [number, number] = difference > 0 ? [deemed, 0] : difference < 0 ? [0, deemed] : [0, 0];
  const players = teams.map((t, i) => ({ name: t.name, handicap: strokesReceived[i], scores: t.scores }));
  // 'front' applies each side's handicap (here the strokes received) on the stroke index;
  // 'back' applies the difference from the low side on the match play index – identical strokes, different index.
  const m = playMatch(course, [[players[0]], [players[1]]], {
    method: (opts.index ?? 'stroke') === 'stroke' ? 'front' : 'back',
    value: opts.value, sideNames: [teams[0].name, teams[1].name],
  });
  return { ...m, teamHandicaps: caps, difference, strokesReceived };
}
