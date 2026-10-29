// Leaderboards, countbacks and tour (cup) points.
import type { StablefordCard } from './core.ts';

export interface Ranked<T> { rank: number; tied: boolean; entry: T; countbackNote?: string }

/**
 * Countback key sequences (single day only, per brief).
 * Stableford (higher is better): back 9, last 6, last 3, then holes 18..10 one by one;
 * if still level, the same on the front 9: front 9, holes 4-9, holes 7-9, then holes 9..1.
 */
function stablefordKeys(c: StablefordCard): { label: string; value: number }[] {
  const p = (h: number) => c.holes[h - 1].points ?? 0;
  const range = (a: number, b: number) => { let s = 0; for (let h = a; h <= b; h++) s += p(h); return s; };
  const keys = [
    { label: 'back 9', value: range(10, 18) },
    { label: 'last 6', value: range(13, 18) },
    { label: 'last 3', value: range(16, 18) },
  ];
  for (let h = 18; h >= 10; h--) keys.push({ label: `hole ${h}`, value: p(h) });
  keys.push({ label: 'front 9', value: range(1, 9) }, { label: 'front last 6', value: range(4, 9) }, { label: 'front last 3', value: range(7, 9) });
  for (let h = 9; h >= 1; h--) keys.push({ label: `hole ${h}`, value: p(h) });
  return keys;
}

/**
 * Stroke countback (lower is better) on hole scores h[1..18] with playing handicap H:
 * back 9 - H/2, last 6 - H/3, last 3 - H/6, then holes 18..10 each - H/18; then the same on the front 9.
 * Used for the individual stroke (net) leaderboard only.
 */
export function strokeKeys(holeScores: number[], H: number): { label: string; value: number }[] {
  const range = (a: number, b: number) => { let s = 0; for (let h = a; h <= b; h++) s += holeScores[h - 1]; return s; };
  const keys = [
    { label: 'back 9', value: range(10, 18) - H / 2 },
    { label: 'last 6', value: range(13, 18) - H / 3 },
    { label: 'last 3', value: range(16, 18) - H / 6 },
  ];
  for (let h = 18; h >= 10; h--) keys.push({ label: `hole ${h}`, value: holeScores[h - 1] - H / 18 });
  keys.push({ label: 'front 9', value: range(1, 9) - H / 2 }, { label: 'front last 6', value: range(4, 9) - H / 3 }, { label: 'front last 3', value: range(7, 9) - H / 6 });
  for (let h = 9; h >= 1; h--) keys.push({ label: `hole ${h}`, value: holeScores[h - 1] - H / 18 });
  return keys;
}

const EPS = 1e-9;

function rankWith<T>(
  entries: T[],
  primary: (e: T) => number,
  better: 'higher' | 'lower',
  keys: ((e: T) => { label: string; value: number }[]) | null,
): Ranked<T>[] {
  const sign = better === 'higher' ? -1 : 1;
  const cmpKeys = (a: T, b: T): { c: number; label?: string } => {
    if (!keys) return { c: 0 };
    const ka = keys(a), kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      const d = ka[i].value - kb[i].value;
      if (Math.abs(d) > EPS) return { c: sign * d, label: ka[i].label };
    }
    return { c: 0 };
  };
  const cmp = (a: T, b: T) => {
    const d = primary(a) - primary(b);
    if (Math.abs(d) > EPS) return sign * d;
    return cmpKeys(a, b).c;
  };
  const sorted = [...entries].sort(cmp);
  const out: Ranked<T>[] = [];
  sorted.forEach((e, i) => {
    const prev = sorted[i - 1];
    const sameAsPrev = prev !== undefined && cmp(prev, e) === 0;
    const rank = sameAsPrev ? out[i - 1].rank : i + 1;
    out.push({ rank, tied: false, entry: e });
    if (sameAsPrev) { out[i - 1].tied = true; out[i].tied = true; }
    // Note where a countback separated equal primary scores.
    if (prev && Math.abs(primary(prev) - primary(e)) < EPS && !sameAsPrev) {
      const lbl = cmpKeys(prev, e).label;
      if (lbl) out[i].countbackNote = `beaten on countback (${lbl})`;
    }
  });
  return out;
}

export interface DayEntry { player: string; card: StablefordCard }

/** Single-day Stableford leaderboard with countback. Incomplete cards rank below complete ones. */
export function dayStablefordLeaderboard(entries: DayEntry[]): Ranked<DayEntry>[] {
  const done = entries.filter(e => e.card.complete);
  const notDone = entries.filter(e => !e.card.complete);
  const ranked = rankWith(done, e => e.card.points, 'higher', e => stablefordKeys(e.card));
  const tail = rankWith(notDone, e => e.card.points, 'higher', null)
    .map(r => ({ ...r, rank: r.rank + done.length }));
  return [...ranked, ...tail];
}

/** Single-day Gross Stableford leaderboard (lower is better). No countback: equal scores share the rank (T2). */
export function dayGrossStablefordLeaderboard(entries: DayEntry[]): Ranked<DayEntry>[] {
  const done = entries.filter(e => e.card.complete);
  return rankWith(done, e => e.card.grossStableford!, 'lower', null);
}

/**
 * Single-day individual stroke (net) leaderboard: net = gross - playing handicap, lower is better,
 * stroke countback. A card with any pickup is DQ (listed at the bottom, no rank).
 */
export function dayNetStrokeLeaderboard(entries: DayEntry[]): (Ranked<DayEntry & { gross: number; net: number | null }> & { dq?: boolean })[] {
  const done = entries.filter(e => e.card.complete);
  const ok = done.filter(e => e.card.holes.every(l => typeof l.score === 'number'))
    .map(e => {
      const gross = e.card.holes.reduce((a, l) => a + (l.score as number), 0);
      return { ...e, gross, net: gross - e.card.handicap };
    });
  const dq = done.filter(e => e.card.holes.some(l => l.score === 'P'))
    .map(e => ({ rank: 0, tied: false, dq: true,
      entry: { ...e, gross: e.card.holes.reduce((a, l) => a + (typeof l.score === 'number' ? l.score : 0), 0), net: null } }));
  return [...rankWith(ok, e => e.net, 'lower', e => strokeKeys(e.card.holes.map(l => l.score as number), e.card.handicap)), ...dq];
}

/** Display rank: "1", "T2" for shared ranks, "DQ" for a disqualified card. */
export function rankLabel(r: { rank: number; tied: boolean; dq?: boolean }): string {
  if (r.dq) return 'DQ';
  return (r.tied ? 'T' : '') + r.rank;
}

export interface AggregateEntry { player: string; rounds: (number | null)[] }

/**
 * Multi-day aggregate: no countback (equal totals share the rank).
 * Players who missed any round go to the bottom, ordered by their total.
 */
export function aggregateLeaderboard(entries: AggregateEntry[], better: 'higher' | 'lower' = 'higher') {
  const total = (e: AggregateEntry) => e.rounds.reduce<number>((a, r) => a + (r ?? 0), 0);
  const full = entries.filter(e => e.rounds.every(r => r !== null));
  const partial = entries.filter(e => e.rounds.some(r => r === null));
  const a = rankWith(full, total, better, null).map(r => ({ ...r, total: total(r.entry), missedRounds: false }));
  const b = rankWith(partial, total, better, null)
    .map(r => ({ ...r, rank: r.rank + full.length, total: total(r.entry), missedRounds: true }));
  return [...a, ...b];
}

/**
 * Suggested points to win: the smallest achievable score strictly greater than half the points available.
 * Per Graham (29 Oct): the administrator enters the points-to-win figure for the tour; this is only a helper
 * for later automation, since all matches are not known before the tour starts.
 */
export function pointsToWin(matchValues: number[]): { available: number; toWin: number; step: number } {
  const available = matchValues.reduce((a, b) => a + b, 0);
  const step = Math.min(...matchValues) / 2;
  const toWin = (Math.floor(available / 2 / step + EPS) + 1) * step;
  return { available, toWin, step };
}

/** Session (or tour) totals for the Ryder Cup panel: sums each side's match points. */
export function sessionTotals(matches: { points: [number, number] }[]): [number, number] {
  return matches.reduce<[number, number]>((t, m) => [t[0] + m.points[0], t[1] + m.points[1]], [0, 0]);
}

/* ---------- Live (in-round) leaderboards ---------- */

export interface LiveRow {
  player: string;
  card: StablefordCard;
  /** Holes entered: 18 = finished ("F"). */
  thru: number;
  complete: boolean;
  rank: number;
  tied: boolean;
  /** Countback note for the player AHEAD in a countback: who they beat and on what. */
  aheadOn?: { other: string; label: string };
  /** Level on every countback with the player next to them. */
  tiedAllCountbacks?: boolean;
  dq?: boolean;
  /** Net leaderboard only: strokes relative to net par through the holes played. */
  netToPar?: number;
  /** Net leaderboard only: total net once finished. */
  net?: number;
  gross?: number;
}

/**
 * Orders rows by a primary value, then complete cards by countback, then partial rounds after the finished
 * players they are level with. Ranks: countback separates finished players; a partial round shares the rank
 * of the players it is level with (T).
 */
function liveOrder(rows: LiveRow[], primary: (r: LiveRow) => number, better: 'higher' | 'lower',
  keys: (r: LiveRow) => { label: string; value: number }[]): LiveRow[] {
  const sign = better === 'higher' ? -1 : 1;
  const cb = (a: LiveRow, b: LiveRow): { c: number; label?: string } => {
    const ka = keys(a), kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      const d = ka[i].value - kb[i].value;
      if (Math.abs(d) > EPS) return { c: sign * d, label: ka[i].label };
    }
    return { c: 0 };
  };
  const cmp = (a: LiveRow, b: LiveRow) => {
    const d = primary(a) - primary(b);
    if (Math.abs(d) > EPS) return sign * d;
    if (a.complete !== b.complete) return a.complete ? -1 : 1;     // finished first, partial rounds below
    if (a.complete && b.complete) return cb(a, b).c;
    return b.thru - a.thru;                                          // partials: further through first
  };
  const out = [...rows].sort(cmp);
  out.forEach((r, i) => {
    const prev = out[i - 1];
    const level = prev && Math.abs(primary(prev) - primary(r)) < EPS;
    const sameRank = level && (!prev.complete || !r.complete || cb(prev, r).c === 0);
    r.rank = sameRank ? prev.rank : i + 1;
    r.tied = false;
    if (sameRank) { prev.tied = true; r.tied = true; }
    if (level && prev.complete && r.complete) {
      const res = cb(prev, r);
      if (res.c === 0) { prev.tiedAllCountbacks = true; r.tiedAllCountbacks = true; }
      else prev.aheadOn = { other: r.player, label: res.label! };
    }
  });
  return out;
}

/** Live Stableford: points through the holes played; partial rounds shown among finished scores. */
export function liveStablefordLeaderboard(entries: DayEntry[]): LiveRow[] {
  const rows: LiveRow[] = entries.filter(e => e.card.holesEntered > 0).map(e => ({
    player: e.player, card: e.card, thru: e.card.holesEntered, complete: e.card.complete, rank: 0, tied: false,
  }));
  return liveOrder(rows, r => r.card.points, 'higher', r => stablefordKeys(r.card));
}

/**
 * Live net stroke: net to par through the holes played (gross − par − shots per hole);
 * finished cards also carry the total net. Any pickup = DQ, listed at the bottom.
 */
export function liveNetLeaderboard(entries: DayEntry[]): LiveRow[] {
  const ok: LiveRow[] = [], dq: LiveRow[] = [];
  for (const e of entries) {
    if (e.card.holesEntered === 0) continue;
    const played = e.card.holes.filter(l => l.score !== null);
    const base: LiveRow = { player: e.player, card: e.card, thru: e.card.holesEntered, complete: e.card.complete, rank: 0, tied: false };
    if (played.some(l => l.score === 'P')) { dq.push({ ...base, dq: true }); continue; }
    const gross = played.reduce((a, l) => a + (l.score as number), 0);
    const netToPar = played.reduce((a, l) => a + (l.score as number) - l.par - l.strokes, 0);
    ok.push({ ...base, gross, netToPar, net: e.card.complete ? gross - e.card.handicap : undefined });
  }
  const ordered = liveOrder(ok, r => r.netToPar!, 'lower', r => strokeKeys(r.card.holes.map(l => l.score as number), r.card.handicap));
  return [...ordered, ...dq.map(r => ({ ...r, rank: 0 }))];
}
