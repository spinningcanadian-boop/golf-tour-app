// Builds the demo day for the prototype. Groups 1, 2 and 6 use Graham's mockup scores exactly;
// the other groups use generated example scores (seeded, so they are the same every build).
import { readFileSync, writeFileSync } from 'node:fs';
import { stablefordCard, strokesOnHole } from '/home/claude/golf-app/engine/src/index.ts';

const F = '/home/claude/golf-app/engine/test/fixtures/';
const f4 = JSON.parse(readFileSync(F + 'woolooware-4ball.json', 'utf8'));
const fa = JSON.parse(readFileSync(F + 'woolooware-ambrose.json', 'utf8'));
const course = f4.course;
const pars: number[] = course.holes.map((h: any) => h.par);

let seed = 20261029;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const DIST: [number, number][] = [[-2, 0.01], [-1, 0.16], [0, 0.45], [1, 0.27], [2, 0.08], [3, 0.03]];
function gen(hcp: number): (number | 'P')[] {
  return course.holes.map((h: any) => {
    let r = rnd(), d = 0;
    for (const [v, p] of DIST) { if (r < p) { d = v; break; } r -= p; }
    return Math.max(2, h.par + strokesOnHole(hcp, h.strokeIndexes) + d);
  });
}
const pts = (hcp: number, sc: any[]) => stablefordCard(course, hcp, sc);

const mock = (k: number) => f4.gross.map((row: any[]) => row[k]);

type P = { id: string; name: string; team: 't1' | 't2' | null; hcp: number };
const players: P[] = [];
const scores: Record<string, (number | 'P' | null)[]> = {};
const add = (id: string, name: string, team: P['team'], hcp: number, sc?: any[]) => {
  players.push({ id, name, team, hcp }); if (sc) scores[id] = sc; return id;
};

// G1 – 4-ball, front of card: Graham's mockup
add('graham', 'Graham', 't1', 6, mock(0)); add('col', 'Col', 't1', 16, mock(1));
add('nic', 'Nic', 't2', 9, mock(2)); add('glen', 'Glen', 't2', 25, mock(3));
// G2 – 4-ball, back of card: the same four cards, other names
add('mitch', 'Mitch', 't1', 6, mock(0)); add('larry', 'Larry', 't1', 16, mock(1));
add('shae', 'Shae', 't2', 9, mock(2)); add('gavan', 'Gavan', 't2', 25, mock(3));
// G3 – two singles, front of card, in progress (thru 11)
for (const [id, n, t, h] of [['tiger', 'Tiger', 't1', 25], ['simon', 'Simon', 't2', 34], ['brett', 'Brett', 't1', 18], ['chris', 'Chris', 't2', 23]] as const) {
  const sc = gen(h).map((x, i) => (i < 11 ? x : null)); add(id, n, t, h, sc);
}
// G4 – two singles, back of card, gap above 18 (Peter 36 v Scotty O 6 = 30)
for (const [id, n, t, h] of [['peter', 'Peter', 't1', 36], ['scotty', 'Scotty O', 't2', 6], ['scottf', 'Scott F', 't1', 34], ['tony', 'Tony', 't2', 19]] as const) add(id, n, t, h, gen(h));
// G5 – 2 v 1: Dave and Waz O each play Karl for 0.5
for (const [id, n, t, h] of [['dave', 'Dave', 't1', 18], ['waz', 'Waz O', 't1', 24], ['karl', 'Karl', 't2', 28]] as const) add(id, n, t, h, gen(h));
// G6 – 2-man Ambrose match play: Graham's Ambrose mockup team scores
add('murph', 'Murph', 't1', 6); add('lord', 'Lord', 't1', 17); add('nugs', 'Nugs', 't2', 9); add('bill', 'Bill', 't2', 25);
scores['amb-red'] = fa.teams[0].scores; scores['amb-blue'] = fa.teams[1].scores;
// G7 – 3-man Ambrose, stroke only
add('brian', 'Brian', null, 15); add('jon', 'Jon', null, 18); add('matty', 'Matty T', null, 20);
const amb3 = pars.map((p, i) => Math.max(2, p + ([-1, 0, 0, 0, 1][Math.floor(rnd() * 5)])));
amb3[6] = pars[6] - 1; scores['amb-3'] = amb3;
// G8 – individual Stableford only: Al and Rob tie on points, Rob better on the back 9; Steve picks up once
const al = gen(25); add('al', 'Al', null, 25, al);
const target = pts(25, al);
let rob: any[] = [], tries = 0;
for (;;) {
  tries++; rob = gen(14);
  for (let k = 0; k < 60; k++) {
    const c = pts(14, rob); const diff = c.points - target.points; if (diff === 0) break;
    const i = Math.floor(rnd() * 9); // adjust the front 9 only
    rob[i] = Math.max(2, rob[i] + (diff > 0 ? 1 : -1));
  }
  const c = pts(14, rob);
  if (c.points === target.points && c.back9 > target.back9) break;
  if (tries > 500) throw new Error('could not build tie');
}
add('rob', 'Rob (guest)', null, 14, rob);
const steve = gen(20); steve[12] = 'P'; add('steve', 'Steve (guest)', null, 20, steve);

const day = {
  title: 'Demo day', course: { ...course, par: pars.reduce((a, b) => a + b, 0), teeColour: '#2a5fb0', teeName: 'Blue' },
  date: 'Thu 29 Oct 2026', pointsToWin: 4.5,
  briefing: 'Demo only. Groups 1, 2 and 6 use your mockup scores; the rest are generated examples. Meet at the pro shop 7:10. Nearest the pin on 4 and 16. Group 3 is still on the course, so try entering holes 12 to 18. Use "Viewing as" below to see the app as a player or as the administrator.',
  teams: { t1: { name: 'Red', color: '#c8372d' }, t2: { name: 'Blue', color: '#2a5fb0' } },
  groups: [
    { id: 'g1', n: 1, tee: '7:30', format: 'fourball', label: '4-ball · front of card', method: 'front', players: ['graham', 'col', 'nic', 'glen'], matches: [{ sides: [['graham', 'col'], ['nic', 'glen']], value: 1 }] },
    { id: 'g2', n: 2, tee: '7:39', format: 'fourball', label: '4-ball · back of card', method: 'back', players: ['mitch', 'larry', 'shae', 'gavan'], matches: [{ sides: [['mitch', 'larry'], ['shae', 'gavan']], value: 1 }] },
    { id: 'g3', n: 3, tee: '7:48', format: 'singles', label: 'Two singles · front of card', method: 'front', players: ['tiger', 'simon', 'brett', 'chris'], matches: [{ sides: [['tiger'], ['simon']], value: 1 }, { sides: [['brett'], ['chris']], value: 1 }] },
    { id: 'g4', n: 4, tee: '7:57', format: 'singles', label: 'Two singles · back of card', method: 'back', players: ['peter', 'scotty', 'scottf', 'tony'], matches: [{ sides: [['peter'], ['scotty']], value: 1 }, { sides: [['scottf'], ['tony']], value: 1 }] },
    { id: 'g5', n: 5, tee: '8:06', format: 'twoVone', label: '2 v 1 singles · ½ point each', method: 'back', players: ['dave', 'waz', 'karl'], matches: [{ sides: [['dave'], ['karl']], value: 0.5 }, { sides: [['waz'], ['karl']], value: 0.5 }] },
    { id: 'g6', n: 6, tee: '8:15', format: 'ambroseMatch', label: '2-man Ambrose match play', players: ['murph', 'lord', 'nugs', 'bill'], ambrose: [{ id: 'amb-red', name: 'Murph & Lord', team: 't1', players: ['murph', 'lord'] }, { id: 'amb-blue', name: 'Nugs & Bill', team: 't2', players: ['nugs', 'bill'] }], value: 1 },
    { id: 'g7', n: 7, tee: '8:24', format: 'ambroseStroke', label: '3-man Ambrose · stroke', players: ['brian', 'jon', 'matty'], ambrose: [{ id: 'amb-3', name: 'Brian, Jon & Matty T', team: null, players: ['brian', 'jon', 'matty'] }] },
    { id: 'g8', n: 8, tee: '8:33', format: 'individual', label: 'Individual Stableford', players: ['al', 'rob', 'steve'] },
  ],
  players, scores,
};
writeFileSync('/tmp/claude-0/-home-claude/3a55c52a-eddf-5d94-9a81-9f377a2c0cac/scratchpad/build/demo.json', JSON.stringify(day));
console.log('Al', target.points, target.back9, '| Rob', pts(14, rob).points, pts(14, rob).back9, '| tries', tries);
