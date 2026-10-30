// Golf Tour App: screens and logic. Storage goes through `fb` (Firebase in the live build).
import { fb } from './fb.js';
import * as E from '../engine/src/index.ts';
import SEED from './demo-seed.json';

const KEY = 'golf-tour-app';
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const load = (k, d) => { try { const s = localStorage.getItem(KEY + k); return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {} };

/* ---------- live state, mirrored from the shared database ---------- */
let me = null;             // signed-in user { uid, anonymous, email }
let cfg = null;            // app/config: { ownerUids } (the Owner's Google sign-in)
let myPid = null;          // the person this phone belongs to (from their personal link)
let myPerson = null;       // their directory entry: { fullName, nick, role, adminOf, … }
let tourId = null;         // the open event
let tour = null;           // event set-up (players, courses, sessions, groups, teams, settings, status, eventAdmins)
let scores = {};           // scores[sessionId][entrantId] = 18 holes
let locks = {};            // locks[unitKey] = { dayId, groupId, at, by }
let people = {};           // the player directory (staff only): people[personId] = { fullName, nick, phone, hcp, role, token, sentAt }
let devCount = {};         // phones signed in per person (staff only)
let sides = {};            // side matches a group set up for itself: sides[sessionId:groupId] = { type, method, a, b, players }
let gate = { state: 'loading' };   // loading | landing | joining | switch | home | people | error | ready
let sync = { pending: false, cached: false };
const server = { tour: null, scores: {}, locks: {} };   // last values seen from the database
let unsubs = [];
const ui = Object.assign({ tab: 'day', day: null, group: null, unit: {}, view: 'gross', lb: 'stab', lbScope: 'day', as: 'admin', cb: true, open: {}, setup: 'tour' }, load(':ui', {}), { entry: null });
const persist = () => store(':ui', { tab: ui.tab, showDemo: ui.showDemo, day: ui.day, group: ui.group, unit: ui.unit, view: ui.view, lb: ui.lb, lbScope: ui.lbScope, as: ui.as, cb: ui.cb, setup: ui.setup });

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = p => p + Math.random().toString(36).slice(2, 8);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const frac = n => { const w = Math.floor(n), f = n - w; const s = f === 0.5 ? '½' : f === 0.25 ? '¼' : f === 0.75 ? '¾' : ''; return (w || !s ? w : '') + s; };
const toParTxt = n => (n === 0 ? 'E' : n > 0 ? '+' + n : '−' + Math.abs(n));
const hhmm = v => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const teeTxt = v => { const t = hhmm(v); if (!t) return v || ''; let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
const fmtDate = iso => { try { return new Date(iso + 'T00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return iso; } };
let toastTimer;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2800); }

/* ---------- lookups ---------- */
const P = () => Object.fromEntries(tour.players.map(p => [p.id, p]));
let PIDX = {};
const dayById = id => tour.days.find(d => d.id === id);
const isTour = () => tour.isTour !== false;
const scoringOf = d => d.scoring || 'stableford';           // 'stableford' | 'both' | 'net'
const hasStab = d => scoringOf(d) !== 'net';
const hasNet = d => scoringOf(d) !== 'stableford';
const viewOnly = d => d.mode === 'view';
const multOn = d => !!d.multiplier;
const multPlayers = g => groupPlayers(g).filter(id => PIDX[id]);
function multOf(day, g) { return E.teamMultiplier(teeOf(day), multPlayers(g).map(id => ({ handicap: PIDX[id].hcp, scores: scFor(day.id, id) }))); }
const gradeCut = () => (Number.isFinite(tour?.gradeCut) ? tour.gradeCut : 16);
const visibleDays = () => (isAdmin() ? tour.days : tour.days.filter(d => !d.hidden));
const DAY = () => { const v = visibleDays(); return v.find(d => d.id === ui.day) || v[0] || null; };
const teeOf = day => { const c = tour.courses.find(c => c.id === day.courseId); const t = c && c.tees.find(t => t.id === day.teeId); return c && t ? { name: c.name, tee: t.name, colour: t.colour, holes: t.holes, par: t.holes.reduce((a, h) => a + h.par, 0) } : null; };
let course = null; // current day's course (set in render)
const daySc = dayId => (scores[dayId] = scores[dayId] || {});
const scFor = (dayId, id) => daySc(dayId)[id] || Array(18).fill(null);
const sc = id => scFor(DAY().id, id);
const tName = t => (t ? tour.teams[t].name : '');

/* ---------- groups: slots -> matches / Ambrose teams ---------- */
const FORMATS = {
  fourball: { label: '4-ball', a: 2, b: 2, match: true },
  singles: { label: 'Two singles', a: 2, b: 2, match: true },
  twoVone: { label: '2 v 1 singles', a: 2, b: 1, match: true },
  ambroseMatch: { label: '2-man Ambrose match', a: 2, b: 2, match: true },
  ambroseStroke: { label: 'Ambrose · stroke', a: 4, b: 0, match: false, min: 2 },
  individual: { label: 'Individual', a: 4, b: 0, match: false, min: 1 },
};
const dayOfGroup = g => tour.days.find(d => d.groups.some(x => x.id === g.id));
const indivLabel = day => ({ stableford: 'Individual Stableford', both: 'Individual Stableford + stroke', net: 'Individual stroke' })[scoringOf(day || {})];
const formatLabel = (k, day) => (k === 'individual' ? indivLabel(day) : FORMATS[k].label);
function groupLabel(g, day = dayOfGroup(g)) {
  const f = FORMATS[g.format];
  if (g.format === 'individual') return indivLabel(day);
  const meth = f.match && g.format !== 'ambroseMatch' ? ` · ${g.method === 'back' ? 'back' : 'front'} of card` : '';
  const val = f.match && g.value !== 1 ? ` · ${frac(g.value)} pt each` : '';
  if (g.format === 'ambroseStroke') return `${g.slots.a.filter(Boolean).length}-man Ambrose · stroke`;
  return f.label + meth + val;
}
const groupPlayers = g => [...g.slots.a, ...g.slots.b].filter(Boolean);
function ambTeams(g) {
  if (g.format === 'ambroseMatch') {
    const ids = g.ambIds || [g.id + '-a', g.id + '-b'];
    return [{ id: ids[0], players: g.slots.a.filter(Boolean) }, { id: ids[1], players: g.slots.b.filter(Boolean) }]
      .map(t => ({ ...t, name: t.players.map(id => PIDX[id]?.name).join(' & '), team: PIDX[t.players[0]]?.team || null }));
  }
  if (g.format === 'ambroseStroke') {
    const id = (g.ambIds || [g.id + '-t'])[0]; const ps = g.slots.a.filter(Boolean);
    return [{ id, players: ps, name: ps.map(x => PIDX[x]?.name).join(', ').replace(/, ([^,]*)$/, ' & $1'), team: null }];
  }
  return [];
}
/** A group's matches. withSide adds the side match a playing group set up for itself (not part of any Cup). */
function unitsOf(day, g, withSide = false) {
  const base = unitsOfGroup(day, g);
  if (!withSide || g.format !== 'individual' || !base.length) return base;
  return [...base, ...sideUnits(day, g, base[0].key)];
}
function sideUnits(day, g, key) {
  const sm = sides[day.id + ':' + g.id]; if (!sm) return [];
  const inGroup = id => groupPlayers(g).includes(id) && PIDX[id];
  if (sm.type === 'cutthroat') { const ps = (sm.players || []).filter(inGroup); return ps.length >= 2 ? [{ key, g, day, kind: 'cutthroat', ents: ps, label: 'Cut throat', side: true }] : []; }
  const a = (sm.a || []).filter(inGroup), b = (sm.b || []).filter(inGroup);
  const gm = { ...g, method: sm.method || 'front' };
  const pairs = sm.type === 'fourball' ? [[a, b]] : a.map((x, i) => [[x], [b[i]].filter(Boolean)]);
  return pairs.filter(p => p[0].length && p[1].length).map(sd => ({ key, g: gm, day, kind: 'match', side: true, sides: sd, teams: ['t1', 't2'], value: 1, ents: [...sd[0], ...sd[1]],
    label: 'Side: ' + sd.map(x => x.map(id => PIDX[id].name).join(' & ')).join(' v '), teamsOn: false }));
}
const sideLabel = sm => (sm.type === 'cutthroat' ? 'Cut throat' : sm.type === 'fourball' ? `4-ball · ${sm.method === 'back' ? 'back' : 'front'} of card` : `Singles · ${sm.method === 'back' ? 'back' : 'front'} of card`);
function cutThroatOf(u) { return E.cutThroat(teeOf(u.day), u.ents.map(id => ({ name: PIDX[id].name, handicap: PIDX[id].hcp, scores: scFor(u.day.id, id) }))); }
function unitsOfGroup(day, g) {
  const key = i => `${day.id}:${g.id}:${i}`;
  const teamsOn = isTour() && day.teamsOn !== false;
  if (g.format === 'ambroseMatch') {
    const [a, b] = ambTeams(g); if (!a.players.length || !b.players.length) return [];
    return [{ key: key(0), g, day, kind: 'ambroseMatch', sides: [[a.id], [b.id]], teams: teamsOn ? sideTeams(a.players, b.players) : ['t1', 't2'], label: `${a.name} v ${b.name}`, value: g.value, ents: [a.id, b.id], teamsOn }];
  }
  if (g.format === 'ambroseStroke') { const [t] = ambTeams(g); return t.players.length ? [{ key: key(0), g, day, kind: 'ambroseStroke', ents: [t.id], label: t.name }] : []; }
  if (g.format === 'individual') return [{ key: key(0), g, day, kind: 'individual', ents: g.slots.a.filter(Boolean), label: 'All players' }];
  let pairs;
  if (g.format === 'fourball') pairs = [[g.slots.a.filter(Boolean), g.slots.b.filter(Boolean)]];
  else if (g.format === 'singles') pairs = [0, 1].map(i => [[g.slots.a[i]].filter(Boolean), [g.slots.b[i]].filter(Boolean)]);
  else pairs = [0, 1].map(i => [[g.slots.a[i]].filter(Boolean), [g.slots.b[0]].filter(Boolean)]);
  return pairs.filter(p => p[0].length && p[1].length).map((sides, i) => {
    let teams = sideTeams(sides[0], sides[1]);
    if (teamsOn && teams[0] === 't2') { sides = [sides[1], sides[0]]; teams = ['t1', 't2']; }   // team 1 on the left
    return { key: key(i), g, day, kind: 'match', sides, teams: teamsOn ? teams : ['t1', 't2'], value: g.value, ents: [...sides[0], ...sides[1]],
      label: sides.map(s => s.map(id => PIDX[id].name).join(' & ')).join(' v '), teamsOn };
  });
}
/** Teams for the two sides of a match in tour mode. A side takes the team of its team players;
 *  a side made only of no-team players (guests) plays for the other team, defaulting to left = team 1. */
function sideTeams(a, b) {
  const t = ids => ids.map(id => PIDX[id]?.team).find(Boolean) || null;
  const other = x => (x === 't1' ? 't2' : 't1');
  let ta = t(a), tb = t(b);
  if (ta && tb && ta === tb) { ta = 't1'; tb = 't2'; }
  if (ta && !tb) tb = other(ta);
  if (!ta && tb) ta = other(tb);
  if (!ta && !tb) { ta = 't1'; tb = 't2'; }
  return [ta, tb];
}
const allAmb = () => tour.days.flatMap(d => d.groups.flatMap(ambTeams));
const ambTeam = id => allAmb().find(a => a.id === id);
const entName = id => (PIDX[id] ? PIDX[id].name : ambTeam(id)?.name || '?');
const entTeam = id => (PIDX[id] ? PIDX[id].team : ambTeam(id)?.team);
const entHcp = id => (PIDX[id] ? PIDX[id].hcp : E.ambroseTeamHandicap(ambTeam(id).players.map(p => PIDX[p].hcp)));
function matchOf(u) {
  const crs = teeOf(u.day); const s = id => scFor(u.day.id, id);
  if (u.kind === 'match') return E.playMatch(crs, u.sides.map(x => x.map(id => ({ name: PIDX[id].name, handicap: PIDX[id].hcp, scores: s(id) }))), { method: u.g.method, value: u.value, sideNames: u.sides.map(x => x.map(id => PIDX[id].name).join(' & ')) });
  if (u.kind === 'ambroseMatch') return E.playAmbroseMatch(crs, u.sides.map(x => { const a = ambTeam(x[0]); return { name: a.name, handicaps: a.players.map(p => PIDX[p].hcp), scores: s(x[0]) }; }), { value: u.value });
  return null;
}
const cardOf = (id, day = DAY()) => E.stablefordCard(teeOf(day), PIDX[id].hcp, scFor(day.id, id));
const thruOf = id => sc(id).filter(v => v !== null).length;
const unitComplete = u => u.ents.every(id => scFor(u.day.id, id).filter(v => v !== null).length === 18);

/* ---------- viewer ---------- */
const isAdmin = () => isRealAdmin() && ui.as === 'admin';
function myUnits(day = DAY()) { return isAdmin() ? [] : day.groups.flatMap(g => unitsOf(day, g)).filter(u => u.ents.includes(ui.as) || (u.kind.startsWith('ambrose') && groupPlayers(u.g).includes(ui.as))); }
function myGroup(day = DAY()) { return isAdmin() ? null : day.groups.find(g => groupPlayers(g).includes(ui.as)); }
function boardsLive() {
  if (tour.visibility === 'live') return true;
  if (tour.visibility === 'hidden') return false;
  const [h, m] = (tour.until || '12:30').split(':').map(Number); const now = new Date();
  return now.getHours() * 60 + now.getMinutes() < h * 60 + m;
}
const canSeeAll = () => isAdmin() || boardsLive();
const canSeeGroup = g => canSeeAll() || (myGroup() && myGroup().id === g.id);
const canEdit = u => isAdmin() || (!locks[u.key] && !viewOnly(u.day) && myUnits(u.day).some(x => x.key === u.key));

/* ---------- team colours ---------- */
const SWATCHES = [['Red', '#c8372d'], ['Blue', '#2a5fb0'], ['Aussie green', '#00843d'], ['Gold', '#f2b705'], ['Orange', '#e06c1f'], ['Purple', '#6b3fa0'], ['Black', '#26292e'], ['Teal', '#0f8b8d']];
function inkFor(hex) { const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#1d1a10' : '#ffffff'; }
function applyTeams() {
  const r = document.documentElement.style;
  for (const t of ['t1', 't2']) { r.setProperty('--' + t, tour.teams[t].color); r.setProperty('--' + t + '-ink', inkFor(tour.teams[t].color)); }
  r.setProperty('--tee', course ? course.colour : '#2a5fb0');
}

/* ---------- small renderers ---------- */
function marker(score, par) {
  if (score === null || score === undefined) return '<span class="empty-cell">·</span>';
  if (score === 'P') return '<span class="mk pu">P</span>';
  const d = score - par;
  const cls = d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'dbl' : '';
  return `<span class="mk ${cls}">${score}</span>`;
}
const withShots = (inner, n) => `<span class="cv">${inner}${n > 0 ? `<span class="shots" aria-label="${n} shot${n > 1 ? 's' : ''}">${'<i></i>'.repeat(n)}</span>` : ''}</span>`;
function chev(st, teams, { deep = false, text = null, big = false } = {}) {
  if (st === 0) return `<span class="chev as ${deep ? 'deep' : ''} ${big ? 'big' : ''}">${text || 'AS'}</span>`;
  const side = st > 0 ? 0 : 1;
  return `<span class="chev ${side === 0 ? 'l' : 'r'} ${teams[side]} ${deep ? 'deep' : ''} ${big ? 'big' : ''}">${text || Math.abs(st) + ' UP'}</span>`;
}
function matchState(u, m, big = false) {
  if (!m || !m.holesPlayed) return { chip: `<span class="chev ns ${big ? 'big' : ''}">Not started</span>`, sub: '' };
  if (m.finished) {
    if (m.winner === 'halved') return { chip: chev(0, u.teams, { deep: true, text: 'AS', big }), sub: 'Halved' };
    return { chip: chev(m.winner === 0 ? 1 : -1, u.teams, { deep: true, text: m.resultText.replace(' and ', ' & ').toUpperCase(), big }), sub: u.teamsOn ? `${tName(u.teams[m.winner])} won` : `${entNames(u.sides[m.winner])} won` };
  }
  const st = m.holes[m.holesPlayed - 1].status;
  return { chip: chev(st, u.teams, { big, text: st === 0 ? 'AS' : null }), sub: m.dormie ? `Dormie · ${m.toPlay} to play` : `${m.toPlay} to play` };
}
const entNames = ids => ids.map(id => esc(entName(id))).join(' & ');
function cutLine(u, ct) {
  if (!ct.holesPlayed) return `<div class="mline"><div class="a" style="grid-column:1/-1"><span class="chev ns">Not started</span></div></div>`;
  return `<div class="ctline">${ct.standings.map(s => `<span class="${s.rank === 1 && s.wins ? 'lead' : ''}">${esc(PIDX[u.ents[s.player]].name)} <b>${s.wins}</b></span>`).join('')}<span class="muted small">${ct.finished ? 'holes won · finished' : `holes won · thru ${ct.holesPlayed}`}</span></div>`;
}
function mlineHTML(u, m, opts = {}) {
  const st = matchState(u, m, opts.big);
  const pts = side => (m && m.finished ? `<b>${frac(m.points[side])}</b>` : '');
  return `<div class="mline"><div class="a"><span class="dot ${u.teams[0]}"></span>${entNames(u.sides[0])}${opts.pts ? pts(0) : ''}</div>
    <div class="c">${st.chip}<span class="sub">${st.sub}</span></div>
    <div class="b">${entNames(u.sides[1])}<span class="dot ${u.teams[1]}" style="margin:0 0 0 5px"></span>${opts.pts ? pts(1) : ''}</div></div>`;
}
function miniPlayer(id, day = DAY()) {
  const c = cardOf(id, day);
  const block = from => {
    const ls = c.holes.slice(from, from + 9);
    const sum = f => ls.reduce((t, l) => t + (f(l) ?? 0), 0);
    const gross = ls.reduce((t, l) => t + (typeof l.score === 'number' ? l.score : 0), 0);
    return `<tr class="hd"><th>Hole</th>${ls.map(l => `<th>${l.hole}</th>`).join('')}<th class="tot">${from ? 'IN' : 'OUT'}</th></tr>
      <tr><td>Par</td>${ls.map(l => `<td>${l.par}</td>`).join('')}<td class="tot">${sum(l => l.par)}</td></tr>
      <tr><td>Strokes</td>${ls.map(l => `<td>${l.score === null ? '' : marker(l.score, l.par)}</td>`).join('')}<td class="tot">${gross || ''}</td></tr>
      <tr><td>Shots</td>${ls.map(l => `<td>${l.strokes || ''}</td>`).join('')}<td class="tot">${sum(l => l.strokes)}</td></tr>
      <tr><td>Points</td>${ls.map(l => `<td>${l.points ?? ''}</td>`).join('')}<td class="tot">${sum(l => l.points)}</td></tr>`;
  };
  return `<table class="mini">${block(0)}${block(9)}</table>`;
}
function miniMatch(u, m) {
  const crs = teeOf(u.day); const s = id => scFor(u.day.id, id);
  const block = from => {
    const hs = crs.holes.slice(from, from + 9);
    const row = (id, side, k) => `<tr><td><span class="dot ${u.teams[side]}"></span>${esc(entName(id))}</td>${hs.map((h, j) => {
      const i = from + j; const mh = m.holes[i]; const p = mh.points[side][k];
      const win = mh.winner === side && p !== null && p === mh.best[side] && !(m.decidedOn && h.number > m.decidedOn);
      return `<td class="${win ? 'win-' + u.teams[side] : ''}">${marker(s(id)[i], h.par)}</td>`; }).join('')}<td class="tot">${s(id).slice(from, from + 9).reduce((t, v) => t + (typeof v === 'number' ? v : 0), 0) || ''}</td></tr>`;
    const status = `<tr><td>Match</td>${hs.map(h => { const mh = m.holes[h.number - 1];
      if (mh.winner === null || (m.decidedOn && h.number > m.decidedOn)) return '<td></td>';
      const st = mh.status; const fin = m.decidedOn === h.number || (m.finished && !m.decidedOn && h.number === 18);
      return `<td><span class="ms ${st === 0 ? 'as' : u.teams[st > 0 ? 0 : 1]} ${fin ? 'deep' : ''}">${st === 0 ? 'AS' : Math.abs(st)}</span></td>`; }).join('')}<td></td></tr>`;
    return `<tr class="hd"><th>Hole</th>${hs.map(h => `<th>${h.number}</th>`).join('')}<th class="tot">${from ? 'IN' : 'OUT'}</th></tr>
      <tr><td>Par</td>${hs.map(h => `<td>${h.par}</td>`).join('')}<td class="tot">${hs.reduce((t, h) => t + h.par, 0)}</td></tr>
      ${u.sides[0].map((id, k) => row(id, 0, k)).join('')}${status}${u.sides[1].map((id, k) => row(id, 1, k)).join('')}`;
  };
  return `<table class="mini">${block(0)}${block(9)}</table>`;
}
function daySwitch() {
  if (visibleDays().length < 2) return '';
  return `<div class="chips" role="toolbar" aria-label="Sessions">${visibleDays().map(d => `<button aria-pressed="${d.id === DAY().id}" data-day="${d.id}">${esc(d.title)} · ${fmtDate(d.date)}${d.hidden ? ' · hidden' : ''}</button>`).join('')}</div>`;
}

/* ---------- Day ---------- */
function viewDay() {
  const day = DAY();
  const viewing = !isRealAdmin() ? '' : `<section class="card"><div class="pad"><div class="frow"><label for="as">Preview as <span class="muted small">(administrators only: see the app as a player would)</span></label>
    <select id="as"><option value="admin" ${isAdmin() ? 'selected' : ''}>Administrator</option>${tour.players.map(p => `<option value="${p.id}" ${ui.as === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div></section>`;
  if (!course) return viewing + daySwitch() + `<section class="card"><div class="pad">${esc(day.title)} has no course yet. ${isAdmin() ? 'Choose one in Setup > Sessions & groups.' : ''}</div></section>`;
  const order = day.groups.map((g, gi) => {
    const units = unitsOf(day, g); const visible = canSeeGroup(g); const side = unitsOf(day, g, true).filter(u => u.side);
    const ents = units.flatMap(u => u.ents);
    const thru = ents.length ? Math.min(...ents.map(thruOf)) : 0;
    const status = thru === 18 ? 'Finished' : thru === 0 ? 'Not started' : `Thru ${thru}`;
    let lines;
    if (FORMATS[g.format].match) lines = units.map(u => mlineHTML(u, visible ? matchOf(u) : null)).join('');
    else lines = `<div class="mline"><div class="a" style="grid-column:1/-1">${groupPlayers(g).map(id => `<span class="dot ${isTour() ? PIDX[id]?.team || '' : ''}"></span>${esc(PIDX[id]?.name)}`).join('&ensp;')}</div></div>`;
    if (side.length && visible) lines += `<div class="sidelbl2">Side match · ${esc(sideLabel(sides[day.id + ':' + g.id]))}</div>` + side.map(u => (u.kind === 'cutthroat' ? cutLine(u, cutThroatOf(u)) : mlineHTML(u, matchOf(u)))).join('');
    return `<li><button class="gbtn" data-go="${g.id}"><span class="teet">${esc(teeTxt(g.tee))}<small>Group ${gi + 1}</small></span>
      <span><span class="lbl"><span>${esc(groupLabel(g))}</span><span>${visible ? status : ''}</span></span>${lines}</span></button></li>`;
  }).join('');
  return `${viewing}${daySwitch()}
  <section class="card"><div class="pad coursebar"><span><span class="eyebrow">${esc(day.title)} · ${fmtDate(day.date)}</span><br><b>${esc(course.name)}</b></span><span class="tee"><i></i>${esc(course.tee)} tees · Par ${course.par}</span></div></section>
  ${day.briefing ? `<section class="card"><h2>Briefing</h2><div class="pad" style="padding-top:0;white-space:pre-line">${esc(day.briefing)}</div></section>` : ''}
  <section class="card"><h2>Order of play</h2>${day.groups.length ? `<ol class="order">${order}</ol>` : `<div class="pad muted">No groups posted yet.</div>`}</section>
  <p class="small muted" style="margin:0">Scores save on your phone first and sync when there is signal.</p>`;
}

/* ---------- Scores ---------- */
function viewScores() {
  const day = DAY();
  if (!course) return daySwitch() + `<section class="card"><div class="pad">No course set for this session yet.</div></section>`;
  const groups = day.groups.filter(canSeeGroup);
  if (!groups.length) return daySwitch() + `<section class="card"><div class="pad">${day.groups.length ? 'You are not in a group on this day.' : 'No groups posted yet.'}</div></section>`;
  if (!groups.find(g => g.id === ui.group)) ui.group = (myGroup() || groups[0]).id;
  const g = day.groups.find(x => x.id === ui.group); const gn = day.groups.indexOf(g) + 1;
  const units = unitsOf(day, g, true);
  if (!units.length) return daySwitch() + `<section class="card"><div class="pad">Group ${gn} has no players yet.</div></section>`;
  const uk = day.id + ':' + g.id;
  if (ui.unit[uk] === undefined || !units[ui.unit[uk]]) { const mine = units.findIndex(u => myUnits().some(x => x.key === u.key)); ui.unit[uk] = Math.max(0, mine); }
  const u = units[ui.unit[uk]]; const m = matchOf(u); const isMatch = !!m; const ct = u.kind === 'cutthroat' ? cutThroatOf(u) : null;
  const views = [['gross', 'Gross'], ...(u.kind === 'ambroseStroke' ? [] : [['stab', u.kind === 'ambroseMatch' ? 'Points' : 'Stableford']]), ...(u.kind === 'match' ? [['match', 'Match']] : []), ...(multOn(day) && !u.kind.startsWith('ambrose') && multPlayers(g).length ? [['mult', 'Multiplier']] : [])];
  if (!views.find(v => v[0] === ui.view)) ui.view = 'gross';
  const chips = groups.length > 1 ? `<div class="chips" role="toolbar" aria-label="Groups">${groups.map(x => `<button aria-pressed="${x.id === g.id}" data-group="${x.id}">Group ${day.groups.indexOf(x) + 1}</button>`).join('')}</div>` : '';
  const unitSeg = units.length > 1 ? `<div class="seg" role="group" aria-label="Match">${units.map((x, i) => `<button aria-pressed="${i === ui.unit[uk]}" data-unit="${i}">${esc(x.label)}</button>`).join('')}</div>` : '';
  const viewSeg = `<div class="seg" role="group" aria-label="Scorecard view">${views.map(([k, l]) => `<button aria-pressed="${ui.view === k}" data-view="${k}">${l}</button>`).join('')}</div>`;
  const left = isMatch ? u.sides[0] : u.ents, right = isMatch ? u.sides[1] : [];
  const cards = Object.fromEntries(u.ents.filter(id => PIDX[id]).map(id => [id, cardOf(id)]));
  const sideOf = id => (u.sides[0].includes(id) ? 0 : 1);
  const kOf = id => u.sides[sideOf(id)].indexOf(id);
  const shotsAt = (id, i) => (u.kind === 'ambroseStroke' ? 0 : (u.kind === 'ambroseMatch' || ui.view === 'match') ? m.holes[i].strokes[sideOf(id)][kOf(id)] : cards[id].holes[i].strokes);
  const head = id => `<th><span class="nm">${esc(entName(id))}</span><span class="hc">HC ${+entHcp(id).toFixed(2)}</span><span class="bar ${entTeam(id) || ''}"></span></th>`;
  const colgroup = `<colgroup><col class="hole">${left.map(() => '<col>').join('')}${isMatch ? '<col class="mid">' : ''}${right.map(() => '<col>').join('')}</colgroup>`;
  const pointsAt = (id, i) => (ui.view === 'match' || u.kind === 'ambroseMatch' ? m.holes[i].points[sideOf(id)][kOf(id)] : cards[id].holes[i].points);
  const cell = (id, i) => {
    const h = course.holes[i]; const s = sc(id)[i];
    let inner;
    if (ui.view === 'gross') inner = marker(s, h.par);
    else { const p = pointsAt(id, i); inner = p === null ? '<span class="empty-cell">·</span>' : `<span class="pts ${p === 0 ? 'zero' : ''}">${p}</span>`; }
    let win = '';
    if (isMatch) { const mh = m.holes[i]; const side = sideOf(id); const p = mh.points[side][kOf(id)];
      if (mh.winner === side && p !== null && p === mh.best[side] && !(m.decidedOn && h.number > m.decidedOn)) win = 'win-' + u.teams[side]; }
    if (ct && ct.holes[i].winner === u.ents.indexOf(id)) win = 'win-ct';
    return `<td class="c ${win}">${withShots(inner, shotsAt(id, i))}</td>`;
  };
  const mid = i => {
    const h = course.holes[i]; const mh = m.holes[i];
    if (mh.winner === null) {
      const have = u.ents.filter(id => sc(id)[i] !== null).length;
      return have ? `<td class="c mid"><span class="wait" title="Waiting for the other scores on this hole">…</span></td>` : '<td class="c mid"></td>';
    }
    if (m.decidedOn && h.number > m.decidedOn) return '<td class="c mid"><span class="muted">–</span></td>';
    const fin = m.decidedOn === h.number || (m.finished && !m.decidedOn && h.number === 18);
    if (fin) return `<td class="c mid">${m.winner === 'halved' ? chev(0, u.teams, { deep: true, text: 'AS' }) : chev(m.winner === 0 ? 1 : -1, u.teams, { deep: true, text: m.resultText.replace(' and ', '&').replace(' up', ' UP') })}</td>`;
    return `<td class="c mid">${chev(mh.status, u.teams)}${mh.dormie ? '<span class="dm">dormie</span>' : ''}</td>`;
  };
  const total = (id, a, b) => {
    if (ui.view === 'gross') { let t = 0, any = false; for (let i = a; i < b; i++) { const v = sc(id)[i]; if (typeof v === 'number') { t += v; any = true; } } return `<td>${any ? t : ''}</td>`; }
    let t = 0; for (let i = a; i < b; i++) t += pointsAt(id, i) ?? 0; return `<td>${t}</td>`;
  };
  const ro = !canEdit(u);
  const parSum = (a, b) => course.holes.slice(a, b).reduce((t, h) => t + h.par, 0);
  const totRow = (lbl, a, b) => `<tr class="tot"><td class="h">${lbl} <span>${parSum(a, b)}</span></td>${left.map(id => total(id, a, b)).join('')}${isMatch ? '<td></td>' : ''}${right.map(id => total(id, a, b)).join('')}</tr>`;
  const rows = [];
  for (let i = 0; i < 18; i++) {
    const h = course.holes[i];
    const idx = (u.kind === 'match' && u.g.method === 'back' && ui.view === 'match') ? `M${h.matchIndexes[0]}` : h.strokeIndexes[0];
    rows.push(`<tr class="hrow ${ro ? 'ro' : ''}" data-hole="${i}" tabindex="0" aria-label="Hole ${h.number}${ro ? '' : ': enter scores'}"><td class="h"><b>${h.number}</b><span>P${h.par} · ${idx}</span></td>${left.map(id => cell(id, i)).join('')}${isMatch ? mid(i) : ''}${right.map(id => cell(id, i)).join('')}</tr>`);
    if (i === 8) rows.push(totRow('OUT', 0, 9));
  }
  rows.push(totRow('IN', 9, 18)); rows.push(totRow('TOT', 0, 18));
  // Which players are holding up the match: a hole only counts once everyone in the match has a score for it.
  const gaps = isMatch ? u.ents.map(id => { const miss = []; for (let i = 0; i < 18; i++) if (sc(id)[i] === null && u.ents.some(o => sc(o)[i] !== null)) miss.push(i + 1); return { id, miss }; }).filter(x => x.miss.length) : [];
  const runs = a => a.reduce((r, n) => { const l = r[r.length - 1]; if (l && n === l[1] + 1) l[1] = n; else r.push([n, n]); return r; }, []).map(([x, y]) => (x === y ? x : `${x}–${y}`)).join(', ');
  const gapNote = gaps.length ? `<div class="pad small gapnote">Match status shows once every player in the match has a score for the hole. Waiting for: ${gaps.map(x => `<b>${esc(entName(x.id))}</b> (hole${x.miss.length > 1 ? 's' : ''} ${runs(x.miss)})`).join('; ')}.</div>` : '';
  const smEditor = g.format === 'individual' ? sideMatchCard(day, g, units[0]) : '';
  const ctCard = ct ? `<section class="card"><h2>Cut throat</h2><table class="lb"><thead><tr><th>Pos</th><th>Player</th><th class="num">Holes won</th></tr></thead><tbody>${ct.standings.map(s => `<tr><td class="pos">${s.tied ? 'T' : ''}${s.rank}</td><td>${esc(PIDX[u.ents[s.player]].name)}</td><td class="num">${s.wins}</td></tr>`).join('')}</tbody></table>
    <div class="pad small muted">Best Stableford score on a hole wins it outright; a shared best score halves the hole, with no carry-over. ${ct.holesPlayed ? `${ct.halved} of ${ct.holesPlayed} holes halved so far.` : 'Not started.'} Winning scores are shaded on the card.</div></section>` : '';
  let summary = ctCard + (isMatch ? `<section class="card"><h2>${u.side ? 'Side match' : 'Match'}</h2><div class="pad" style="padding-top:0">${mlineHTML(u, m, { big: true })}</div>${gapNote}${u.side ? '<div class="pad small muted" style="padding-top:0">A side match is just for your group: it does not count towards any Cup.</div>' : submitHTML(u)}</section>` : `<section class="card"><h2>Sign and submit</h2>${submitHTML(u.side ? units[0] : u)}</section>`);
  if (u.kind.startsWith('ambrose')) {
    summary += `<section class="card"><h2>Ambrose</h2><table class="lb"><thead><tr><th>Team</th><th class="thru">Thru</th><th class="num">HC</th><th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody>${u.ents.map(id => {
      const a = ambTeam(id); const c = E.ambroseCard(course, { name: a.name, handicaps: a.players.map(p => PIDX[p].hcp), scores: sc(id) }); const t = thruOf(id);
      return `<tr><td><span class="dot ${a.team || ''}"></span>${esc(a.name)}</td><td class="thru ${t === 18 ? 'f' : ''}">${t === 18 ? 'F' : t}</td><td class="num" style="font-weight:500">${+c.teamHandicap.toFixed(2)}</td><td class="num">${c.gross || '–'}</td><td class="num">${t < 18 ? '–' : c.dq ? 'DQ' : +c.net.toFixed(2)}</td></tr>`;
    }).join('')}</tbody></table>${u.kind === 'ambroseMatch' ? `<div class="pad small muted">Team handicaps ${m.teamHandicaps.map(v => +v.toFixed(2)).join(' v ')}: ${Math.max(...m.strokesReceived)} shots to ${esc(m.strokesReceived[0] ? entName(u.sides[0][0]) : entName(u.sides[1][0]))} on the stroke index.</div>` : ''}</section>`;
  } else {
    const S = hasStab(day), N = hasNet(day);
    if (u.side && isMatch) summary += `<section class="card"><h2>Sign and submit</h2>${submitHTML(units[0])}</section>`;
    if (multOn(day) && multPlayers(g).length) { const mt = multOf(day, g); summary += `<section class="card"><h2>Team Multiplier</h2><div class="pad" style="padding-top:0;display:flex;justify-content:space-between;align-items:baseline;gap:10px"><span class="small muted">Group ${gn} · ${mt.complete ? 'finished' : `thru ${mt.thru}`}</span><b style="font:700 22px/1 var(--f-display)">${mt.total}</b></div></section>`; }
    summary += `<section class="card"><h2>Group ${gn} scores</h2><table class="lb"><thead><tr><th>Player</th><th class="thru">Thru</th>${S ? '<th class="num">Pts</th><th class="num">Gross Stab</th>' : ''}${N ? '<th class="num">Stroke</th>' : ''}</tr></thead><tbody>${groupPlayers(g).map(id => {
      const c = cardOf(id); const t = c.holesEntered; const pu = sc(id).some(v => v === 'P');
      const played = c.holes.filter(l => typeof l.score === 'number');
      const ntp = played.reduce((a, l) => a + l.score - l.par - l.strokes, 0); const gross = played.reduce((a, l) => a + l.score, 0);
      const net = pu ? 'DQ' : t === 18 ? `${gross - c.handicap}` : t ? toParTxt(ntp) : '–';
      return `<tr><td><span class="dot ${isTour() ? PIDX[id].team || '' : ''}"></span>${esc(PIDX[id].name)}</td><td class="thru ${t === 18 ? 'f' : ''}">${t === 18 ? 'F' : t}</td>${S ? `<td class="num">${c.points}</td><td class="num">${c.grossStableford ?? '–'}</td>` : ''}${N ? `<td class="num">${net}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></section>`;
  }
  summary += smEditor;
  return `${daySwitch()}<section class="card"><div class="pad coursebar"><span><b>${esc(course.name)}</b></span><span class="tee"><i></i>${esc(course.tee)} tees · Par ${course.par}</span></div></section>
  ${chips}
  <section class="card">
    <div class="ghead"><div class="t"><div><div class="eyebrow">Group ${gn} · ${esc(teeTxt(g.tee))}</div><h2>${esc(groupLabel(g))}</h2></div>${locks[u.key] ? '<span class="small" style="color:var(--ok);font-weight:600">Submitted</span>' : ''}</div>${unitSeg}${viewSeg}</div>
    ${ui.view === 'mult' ? multTable(day, g, !canEdit(u)) : `<table class="sc">${colgroup}<thead><tr><th style="text-align:left;padding-left:8px">Hole</th>${left.map(head).join('')}${isMatch ? '<th>Match</th>' : ''}${right.map(head).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`}
    <div class="legend"><span><span class="mk eagle">3</span>Eagle or better</span><span><span class="mk birdie">3</span>Birdie</span><span><span class="mk bogey">5</span>Bogey</span><span><span class="mk dbl">6</span>Double bogey +</span>${isMatch ? `<span><span class="sw" style="background:var(--${u.teams[0]}-soft)"></span><span class="sw" style="background:var(--${u.teams[1]}-soft)"></span>Winning score on the hole</span>` : ''}${ct ? '<span><span class="sw" style="background:var(--as-soft)"></span>Won the hole outright</span>' : ''}${ui.view === 'mult' ? '<span>× = Stableford points multiplied together; any 0 wipes the hole</span>' : ''}<span>${ro ? (locks[u.key] ? 'Scores locked' : 'View only') : 'Tap a hole to enter scores'}</span></div>
  </section>${summary}`;
}
/* Side match: a group playing individual scoring can set up its own match. Group members and administrators can change it. */
function sideMatchCard(day, g, baseUnit) {
  const key = day.id + ':' + g.id; const sm = sides[key]; const can = canEdit(baseUnit);
  const ps = groupPlayers(g).filter(id => PIDX[id]);
  if (ps.length < 2) return '';
  const ed = ui.sideEdit && ui.sideEdit.key === key ? ui.sideEdit : null;
  if (!ed) {
    if (!can) return sm ? '' : '';
    return `<section class="card"><h2>Side match</h2><div class="pad" style="padding-top:0;display:grid;gap:8px">${sm ? `<span>${esc(sideLabel(sm))}. Choose it above the scorecard to follow it hole by hole.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-sideedit>Change</button><button class="btn" data-sidedel>Remove side match</button></div>`
      : `<span class="small muted">Playing a match within your group? Set it up here. It is just for your group and does not count towards any Cup.</span><div><button class="btn primary" data-sideedit>Set up a side match</button></div>`}</div></section>`;
  }
  const types = [['fourball', '4-ball', ps.length === 4], ['singles', 'Singles', ps.length % 2 === 0], ['cutthroat', 'Cut throat', ps.length >= 3]].filter(x => x[2]);
  if (!types.find(x => x[0] === ed.type)) ed.type = types[0]?.[0];
  const sideOf = id => (ed.a.includes(id) ? 'a' : ed.b.includes(id) ? 'b' : '');
  const pick = ed.type !== 'cutthroat' ? `<div class="frow"><span class="lab">${ed.type === 'singles' ? 'Sides (first on the left plays first on the right, and so on)' : 'Sides'}</span>
      ${ps.map(id => `<div class="smrow"><span>${esc(PIDX[id].name)} <span class="muted small">HC ${PIDX[id].hcp}</span></span><div class="seg" role="group" aria-label="Side for ${esc(PIDX[id].name)}">
        <button aria-pressed="${sideOf(id) === 'a'}" data-smside="a" data-pid="${id}" class="sm-a">Left</button><button aria-pressed="${sideOf(id) === 'b'}" data-smside="b" data-pid="${id}" class="sm-b">Right</button></div></div>`).join('')}</div>
      <div class="frow"><span class="lab">Handicaps</span><div class="seg" role="group">${[['front', 'Front of card'], ['back', 'Back of card']].map(([k, l]) => `<button aria-pressed="${ed.method === k}" data-smmethod="${k}">${l}</button>`).join('')}</div>
        <span class="small muted">${ed.method === 'back' ? 'Shots are the difference from the lowest handicap, on the match play index.' : 'Each player plays off their full handicap on the stroke index.'}</span></div>`
    : `<span class="small muted">Everyone plays for themselves. The best Stableford score on a hole wins it outright; if two or more share the best score the hole is halved, with no carry-over. Most holes won wins.</span>`;
  const ready = ed.type === 'cutthroat' || (ed.type === 'fourball' ? ed.a.length === 2 && ed.b.length === 2 : ed.a.length && ed.a.length === ed.b.length && ed.a.length + ed.b.length === ps.length);
  return `<section class="card"><h2>Side match</h2><div class="form">
    <div class="frow"><span class="lab">Game</span><div class="seg" role="group" aria-label="Side match game">${types.map(([k, l]) => `<button aria-pressed="${ed.type === k}" data-smtype="${k}">${l}</button>`).join('')}</div></div>
    ${pick}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-smsave ${ready ? '' : 'disabled'}>Save side match</button><button class="btn" data-smcancel>Cancel</button></div>
    ${!ready ? `<span class="small muted">${ed.type === 'fourball' ? 'Put two players on each side.' : 'Put the same number of players on each side.'}</span>` : ''}</div></section>`;
}
/* Multiplier view: every player in the group, their Stableford points, and the hole product on the far right. */
function multTable(day, g, ro) {
  const ps = multPlayers(g); const mt = multOf(day, g);
  const cards = Object.fromEntries(ps.map(id => [id, cardOf(id, day)]));
  const cell = (id, i) => { const l = cards[id].holes[i]; const p = l.points; return `<td class="c">${withShots(p === null ? '<span class="empty-cell">·</span>' : `<span class="pts ${p === 0 ? 'zero' : ''}">${p}</span>`, l.strokes)}</td>`; };
  const prod = i => { const v = mt.holes[i]; return `<td class="c mult ${v === 0 ? 'wipe' : ''}">${v === null ? '' : v === 0 ? '<span class="wipe-t">0</span>' : `<b>${v}</b>`}</td>`; };
  const parSum = (a, b) => course.holes.slice(a, b).reduce((t, h) => t + h.par, 0);
  const tot = (a, b) => `<tr class="tot"><td class="h">${a ? (b === 18 && a === 0 ? 'TOT' : 'IN') : 'OUT'} <span>${parSum(a, b)}</span></td>${ps.map(id => `<td>${cards[id].holes.slice(a, b).reduce((t, l) => t + (l.points ?? 0), 0)}</td>`).join('')}<td class="mult"><b>${mt.holes.slice(a, b).reduce((t, v) => t + (v ?? 0), 0)}</b></td></tr>`;
  const rows = [];
  for (let i = 0; i < 18; i++) { const h = course.holes[i];
    rows.push(`<tr class="hrow ${ro ? 'ro' : ''}" data-hole="${i}" tabindex="0" aria-label="Hole ${h.number}"><td class="h"><b>${h.number}</b><span>P${h.par} · ${h.strokeIndexes[0]}</span></td>${ps.map(id => cell(id, i)).join('')}${prod(i)}</tr>`);
    if (i === 8) rows.push(tot(0, 9)); }
  rows.push(tot(9, 18)); rows.push(tot(0, 18).replace('>OUT <', '>TOT <'));
  return `<table class="sc multsc"><colgroup><col class="hole">${ps.map(() => '<col>').join('')}<col class="mcol"></colgroup><thead><tr><th style="text-align:left;padding-left:8px">Hole</th>${ps.map(id => `<th><span class="nm">${esc(PIDX[id].name)}</span><span class="hc">HC ${PIDX[id].hcp}</span><span class="bar ${isTour() ? PIDX[id].team || '' : ''}"></span></th>`).join('')}<th class="mult">×</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function submitHTML(u) {
  if (locks[u.key]) return `<div class="submit"><span class="ok">Scores submitted and locked.</span><span class="small muted">If something is wrong, ask an administrator to change it.</span>${isAdmin() ? `<div><button class="btn" data-unlock="${u.key}">Unlock for changes</button></div>` : ''}</div>`;
  if (!isAdmin() && viewOnly(u.day)) return `<div class="submit"><span class="small muted">This session is view only: scores can no longer be changed. Ask an administrator if something is wrong.</span></div>`;
  if (!canEdit(u)) return `<div class="submit"><span class="small muted">Only players in this ${u.kind === 'individual' ? 'group' : 'match'} can enter and submit these scores.</span></div>`;
  const done = unitComplete(u);
  return `<div class="submit"><label class="switch"><input type="checkbox" id="ack" ${done ? '' : 'disabled'}> I confirm these scores are correct</label>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" data-submit="${u.key}" disabled>Submit scores</button><span class="small muted">${done ? 'Once submitted, scores are locked.' : 'Submit once all 18 holes are entered.'}</span></div></div>`;
}

/* ---------- Leaders ---------- */
const hiddenNote = () => `<section class="card"><div class="pad">Leaderboards are hidden until the administrator publishes results. You can still see your own group on the Scores tab.</div></section>`;
function viewLeaders() {
  if (!canSeeAll()) return hiddenNote();
  const day = DAY();
  const multi = visibleDays().length > 1;
  const scope = multi ? ui.lbScope : 'day';
  const anyStab = visibleDays().some(hasStab);
  const indiv = d => d.groups.some(g => !g.format.startsWith('ambrose') && groupPlayers(g).length);
  const tabs = scope === 'tour'
    ? [...(anyStab ? [['stab', 'Stableford'], ['gross', 'Gross Stab']] : []), ['nov', 'Novelty']]
    : [...(hasStab(day) && indiv(day) ? [['stab', 'Stableford'], ['gross', 'Gross Stab']] : []), ...(hasNet(day) && indiv(day) ? [['net', 'Stroke']] : []),
       ...(day.groups.some(g => g.format.startsWith('ambrose')) ? [['amb', 'Ambrose']] : []), ...(multOn(day) && indiv(day) ? [['mult', 'Multiplier']] : []), ...(indiv(day) ? [['nov', 'Novelty']] : [])];
  if (!tabs.length) return daySwitch() + `<section class="card"><div class="pad">No leaderboards for this session yet.</div></section>`;
  if (!tabs.find(t => t[0] === ui.lb)) ui.lb = tabs[0][0];
  if (!tabs.find(t => t[0] === ui.lb)) ui.lb = 'stab';
  const seg = `<div class="seg" role="group" aria-label="Leaderboard">${tabs.map(([k, l]) => `<button aria-pressed="${ui.lb === k}" data-lb="${k}">${l}</button>`).join('')}</div>`;
  const scopeSeg = multi ? `<div class="seg" role="group" aria-label="Session or event">${[['day', esc(day.title)], ['tour', 'Event to date']].map(([k, l]) => `<button aria-pressed="${scope === k}" data-scope="${k}">${l}</button>`).join('')}</div>` : '';
  const nm = id => `<span class="dot ${PIDX[id]?.team || ''}"></span>${esc(PIDX[id]?.name)}`;
  const thruTd = t => `<td class="thru ${t === 18 ? 'f' : ''}">${t === 18 ? 'F' : t}</td>`;
  const cbNote = r => {
    if (!ui.cb) return '';
    if (r.tiedAllCountbacks) return '<span class="note">Tied on all countbacks</span>';
    if (r.aheadOn) return `<span class="note">Ahead of ${esc(PIDX[r.aheadOn.other].name)} on countback (${esc(r.aheadOn.label)})</span>`;
    return '';
  };
  const expandable = (id, cols, rowHtml, detail) => {
    const open = ui.open['lb:' + id];
    return `<tr class="tap" data-open="lb:${id}" tabindex="0" aria-expanded="${!!open}">${rowHtml}<td class="pm">${open ? '−' : '+'}</td></tr>${open ? `<tr class="detail"><td colspan="${cols + 1}">${detail()}</td></tr>` : ''}`;
  };
  let head = '', body = '', note = '';
  if (ui.lb === 'mult' && scope !== 'tour') {
    const gs = day.groups.filter(g => !g.format.startsWith('ambrose') && multPlayers(g).length).map(g => ({ g, n: day.groups.indexOf(g) + 1, mt: multOf(day, g) }));
    gs.sort((a, b) => b.mt.total - a.mt.total);
    const rank = x => 1 + gs.filter(y => y.mt.total > x.mt.total).length; const tied = x => gs.filter(y => y.mt.total === x.mt.total).length > 1;
    head = '<th>Pos</th><th>Group</th><th class="thru">Thru</th><th class="num">Total</th>';
    body = gs.map(x => `<tr><td class="pos">${x.mt.thru ? (tied(x) ? 'T' : '') + rank(x) : ''}</td><td><b>Group ${x.n}</b><span class="note">${multPlayers(x.g).map(id => esc(PIDX[id].name)).join(', ')}</span></td><td class="thru ${x.mt.complete ? 'f' : ''}">${x.mt.complete ? 'F' : x.mt.thru}</td><td class="num">${x.mt.total}</td></tr>`).join('');
    note = 'Team Multiplier Stableford: each hole scores everyone\'s Stableford points multiplied together; any 0 or pickup wipes the hole. Groups of different sizes are compared as they stand.';
  } else if (ui.lb === 'nov') {
    ({ body, note } = noveltyView(scope === 'tour' ? visibleDays().filter(d => teeOf(d)) : [day]));
    head = null;
  } else if (scope === 'tour') {
    const playedDays = visibleDays().filter(d => teeOf(d));
    const ids = tour.players.map(p => p.id).filter(id => playedDays.some(d => d.groups.some(g => !g.format.startsWith('ambrose') && groupPlayers(g).includes(id))));
    const roundOf = (id, d) => { const inDay = d.groups.some(g => !g.format.startsWith('ambrose') && groupPlayers(g).includes(id)); if (!inDay) return null; const c = cardOf(id, d); if (!c.holesEntered) return null;
      return ui.lb === 'stab' ? c.points : c.complete ? c.grossStableford : null; };
    const lb = E.aggregateLeaderboard(ids.map(id => ({ player: id, rounds: playedDays.map(d => roundOf(id, d)) })), ui.lb === 'stab' ? 'higher' : 'lower');
    head = `<th>Pos</th><th>Player</th>${playedDays.map((d, i) => `<th class="num">R${i + 1}</th>`).join('')}<th class="num">Total</th><th></th>`;
    body = lb.map(r => expandable(r.entry.player, playedDays.length + 3, `<td class="pos">${E.rankLabel(r)}</td><td>${nm(r.entry.player)}${r.missedRounds ? '<span class="note">Missing a round</span>' : ''}</td>${r.entry.rounds.map(v => `<td class="num" style="font-weight:500">${v ?? '–'}</td>`).join('')}<td class="num">${r.total}</td>`, () => playedDays.map(d => `<div class="small muted" style="padding:8px 8px 0">${esc(d.title)}</div>${miniPlayer(r.entry.player, d)}`).join(''))).join('');
    note = ui.lb === 'stab' ? 'Total Stableford points across the event. No countback: equal totals share the place. Anyone missing a round is listed at the bottom.' : 'Gross Stableford totals for finished rounds. Lower is better.';
  } else {
    const ids = day.groups.filter(g => !g.format.startsWith('ambrose')).flatMap(groupPlayers);
    const entries = ids.map(id => ({ player: id, card: cardOf(id) }));
    if (ui.lb === 'stab') {
      const lb = E.liveStablefordLeaderboard(entries);
      head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Pts</th><th></th>';
      body = lb.map(r => expandable(r.player, 4, `<td class="pos">${E.rankLabel(r)}</td><td>${nm(r.player)}${cbNote(r)}</td>${thruTd(r.thru)}<td class="num">${r.card.points}</td>`, () => miniPlayer(r.player))).join('');
      note = 'Points through the holes played. Finished ties split on countback; anyone still playing sits below those they are level with.';
    } else if (ui.lb === 'gross') {
      const lb = E.dayGrossStablefordLeaderboard(entries);
      head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Gross</th><th></th>';
      body = lb.map(r => expandable(r.entry.player, 4, `<td class="pos">${E.rankLabel(r)}</td><td>${nm(r.entry.player)}</td>${thruTd(18)}<td class="num">${r.entry.card.grossStableford}</td>`, () => miniPlayer(r.entry.player))).join('');
      note = 'Finished rounds only. Course par + handicap + (36 − points). No tie-breakers.';
    } else if (ui.lb === 'net') {
      const lb = E.liveNetLeaderboard(entries);
      head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Net</th><th></th>';
      body = lb.map(r => expandable(r.player, 4, `<td class="pos">${r.dq ? 'DQ' : E.rankLabel(r)}</td><td>${nm(r.player)}${r.dq ? '<span class="note">Picked up</span>' : cbNote(r)}</td>${thruTd(r.thru)}<td class="num">${r.dq ? 'DQ' : r.complete ? `${r.net}<span class="sub">${toParTxt(r.netToPar)}</span>` : toParTxt(r.netToPar)}</td>`, () => miniPlayer(r.player))).join('');
      note = `Net stroke play: relative to par while playing; total net score once finished (par ${course.par}). Any pickup is DQ.`;
    } else {
      const teams = day.groups.flatMap(ambTeams).map(a => ({ a, c: E.ambroseCard(course, { name: a.name, handicaps: a.players.map(id => PIDX[id].hcp), scores: sc(a.id) }) })).filter(t => t.c.complete);
      const lb = E.aggregateLeaderboard(teams.map(t => ({ player: t.a.id, rounds: [t.c.dq ? null : t.c.net] })), 'lower');
      const by = Object.fromEntries(teams.map(t => [t.a.id, t]));
      head = '<th>Pos</th><th>Team</th><th class="thru">Thru</th><th class="num">Gross</th><th class="num">Net</th>';
      body = lb.map(r => { const t = by[r.entry.player]; return `<tr><td class="pos">${r.missedRounds ? 'DQ' : E.rankLabel(r)}</td><td><span class="dot ${t.a.team || ''}"></span>${esc(t.a.name)}<span class="note">HC ${+t.c.teamHandicap.toFixed(2)}</span></td>${thruTd(18)}<td class="num" style="font-weight:500">${t.c.gross}</td><td class="num">${r.missedRounds ? 'DQ' : +t.c.net.toFixed(2)}</td></tr>`; }).join('');
      note = 'Finished teams only. Gross − team handicap; ties share the position.';
    }
  }
  const banner = isAdmin() && !boardsLive() ? '<div class="banner">Players cannot see leaderboards right now. You can see them as the administrator.</div>' : '';
  return `${banner}${daySwitch()}<section class="card"><div class="ghead"><div class="t"><div><div class="eyebrow">${esc(tour.title)}</div><h2>Leaderboards</h2></div>
    ${scope === 'day' && (ui.lb === 'stab' || ui.lb === 'net') ? `<label class="switch"><input type="checkbox" id="cbt" ${ui.cb ? 'checked' : ''}> Countback details</label>` : ''}</div>${scopeSeg}${seg}</div>
    <div class="pad small muted" style="padding-block:8px 4px">${note}${ui.lb !== 'amb' && ui.lb !== 'nov' ? ' Tap a player to see their card.' : ''}</div>
    ${head === null ? body : `<div style="overflow-x:auto"><table class="lb"><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">No scores yet.</td></tr>'}</tbody></table></div>`}</section>`;
}

function noveltyView(days) {
  const rounds = days.flatMap(d => { const crs = teeOf(d); if (!crs) return [];
    return d.groups.filter(g => !g.format.startsWith('ambrose')).flatMap(groupPlayers).filter(id => PIDX[id] && (ui.grade === 'A' ? PIDX[id].hcp <= gradeCut() : ui.grade === 'B' ? PIDX[id].hcp > gradeCut() : true)).map(id => ({ player: id, session: d.id, pars: crs.holes.map(h => h.par), scores: scFor(d.id, id) })); });
  const st = E.noveltyStats(rounds, 5);
  const multi = days.length > 1;
  const sessName = id => esc(dayById(id)?.title || '');
  const nm = id => `<span class="dot ${PIDX[id]?.team || ''}"></span>${esc(PIDX[id]?.name || '?')}`;
  const block = (title, desc, rows, val, extra) => `<div class="nov"><div class="nov-h"><b>${title}</b><span class="small muted">${desc}</span></div>
    ${rows.length ? `<table class="lb"><tbody>${capTies(rows).shown.map(r => `<tr><td class="pos">${r.tied ? 'T' : ''}${r.rank}</td><td>${nm(r.item.player)}${extra ? `<span class="note">${extra(r.item)}</span>` : ''}</td><td class="num">${val(r.item)}</td></tr>`).join('')}${capTies(rows).more ? `<tr><td></td><td colspan="2" class="small muted">and ${capTies(rows).more} more level on ${val(capTies(rows).last.item)}</td></tr>` : ''}</tbody></table>` : '<div class="pad small muted">Nothing yet.</div>'}</div>`;
  // Everyone level with 5th is included; if that makes a long list, show the first ones and count the rest.
  function capTies(rows) { if (rows.length <= 8) return { shown: rows, more: 0 }; const last = rows[rows.length - 1]; const keep = rows.filter(r => r.rank < last.rank); const level = rows.filter(r => r.rank === last.rank);
    const shown = [...keep, ...level.slice(0, Math.max(1, 6 - keep.length))]; return { shown, more: rows.length - shown.length, last }; }
  const range = x => `Holes ${x.from}–${x.to}${multi ? ` · ${sessName(x.session)}` : ''}`;
  const parRange = x => `${range(x)} · <b>${x.toPar === 0 ? 'E' : toParTxt(x.toPar)}</b>`;
  const gradeSeg = `<div class="pad" style="padding-block:4px 0"><div class="seg" role="group" aria-label="Grade">${[['all', 'All'], ['A', `A grade (≤${gradeCut()})`], ['B', `B grade (${gradeCut() + 1}+)`]].map(([k, l]) => `<button aria-pressed="${(ui.grade || 'all') === k}" data-grade="${k}">${l}</button>`).join('')}</div></div>`;
  return {
    note: (multi ? 'Top 5 across the whole event so far. Trains are 2 or more holes within one round; a player can appear more than once.' : 'Top 5 in this session so far. Trains are 2 or more holes in a row; a player can appear more than once.') + (ui.grade && ui.grade !== 'all' ? ` ${ui.grade} grade only, by event handicap.` : ''),
    body: gradeSeg + `<div class="novs">
      ${block('Bogey train', 'Most holes in a row at bogey or worse (pickups count)', st.bogeyTrain, x => x.length, range)}
      ${block('Par or better train', 'Most holes in a row at par or better, with the score to par', st.parTrain, x => x.length, parRange)}
      ${block('Birdies', 'Birdie or better', st.birdies, x => x.count)}
      ${block('Pars', 'Total pars', st.pars, x => x.count)}</div>`,
  };
}

/* ---------- Cup ---------- */
function viewCup() {
  if (!canSeeAll()) return hiddenNote();
  if (!isTour()) return `<section class="card"><div class="pad">This event is not a Tour, so there is no Cup.</div></section>`;
  const sessions = visibleDays().filter(d => d.teamsOn !== false && teeOf(d)).map(d => {
    const ms = d.groups.flatMap(g => unitsOf(d, g)).filter(u => (u.kind === 'match' || u.kind === 'ambroseMatch') && u.teams[0] && u.teams[1]).map(u => ({ u, m: matchOf(u) }));
    const tot = [0, 0]; ms.forEach(({ u, m }) => { const s = u.teams[0] === 't1' ? 0 : 1; tot[0] += m.points[s]; tot[1] += m.points[1 - s]; });
    return { d, ms, tot };
  });
  const tot = sessions.reduce((t, s) => [t[0] + s.tot[0], t[1] + s.tot[1]], [0, 0]);
  const available = sessions.reduce((t, s) => t + s.ms.reduce((a, x) => a + x.u.value, 0), 0);
  const done = sessions.reduce((t, s) => t + s.ms.filter(x => x.m.finished).length, 0), count = sessions.reduce((t, s) => t + s.ms.length, 0);
  const sess = sessions.map(({ d, ms, tot }) => `<details class="sess" ${d.id === DAY().id ? 'open' : ''}><summary><span class="pm"></span><span>${esc(d.title)} · ${fmtDate(d.date)}</span><span style="font:700 16px/1 var(--f-display)"><span style="color:var(--t1-text)">${frac(tot[0])}</span> – <span style="color:var(--t2-text)">${frac(tot[1])}</span></span></summary>
    ${ms.map(({ u, m }) => { const open = ui.open['cup:' + u.key]; const gn = d.groups.indexOf(u.g) + 1;
      return `<div class="xrow"><button data-open="cup:${u.key}" aria-expanded="${!!open}"><span class="pm">${open ? '−' : '+'}</span>
        <span><span class="small muted">Group ${gn} · ${u.value === 1 ? '1 point' : frac(u.value) + ' point'}</span>${mlineHTML(u, m, { pts: true })}</span></button>
        ${open ? `<div class="det">${m.holesPlayed ? miniMatch(u, m) : '<span class="small muted">Not started.</span>'}</div>` : ''}</div>`; }).join('') || '<div class="pad small muted">No team matches on this day.</div>'}</details>`).join('');
  const banner = isAdmin() && !boardsLive() ? '<div class="banner">Players cannot see the Cup right now. You can see it as the administrator.</div>' : '';
  return `${banner}<section class="card">
    <div class="cup"><div class="side"><span class="tn" style="color:var(--t1-text)">${esc(tName('t1'))}</span><b style="color:var(--t1-text)">${frac(tot[0])}</b></div><div class="vs">v</div><div class="side"><span class="tn" style="color:var(--t2-text)">${esc(tName('t2'))}</span><b style="color:var(--t2-text)">${frac(tot[1])}</b></div></div>
    <div class="towin">${tour.pointsToWin} points to win · ${available} available · ${done} of ${count} matches finished</div>
    ${sess}
    <div class="legend"><span>${chev(1, ['t1', 't2'], { text: '2 UP' })} Leading</span><span>${chev(1, ['t1', 't2'], { deep: true, text: 'WON' })} Won</span><span>${chev(0, ['t1', 't2'])} All square</span><span>${chev(0, ['t1', 't2'], { deep: true, text: 'HALVED' })} Halved</span><span>Tap a match for hole by hole</span></div>
  </section>`;
}

/* ---------- Setup (administrator) ---------- */
function viewSetup() {
  const tabs = [['tour', 'Event'], ['players', 'Players'], ['courses', 'Courses'], ['days', 'Sessions & groups']];
  const seg = `<div class="seg" role="group" aria-label="Setup section">${tabs.map(([k, l]) => `<button aria-pressed="${ui.setup === k}" data-setup="${k}">${l}</button>`).join('')}</div>`;
  const body = ui.setup === 'tour' ? setupTour() : ui.setup === 'players' ? setupPlayers() : ui.setup === 'courses' ? setupCourses() : setupDays();
  return `<section class="card"><div class="ghead"><div class="eyebrow">${esc(roleName())}</div><h2>Set-up</h2>${seg}</div>${body}</section>
    <section class="card"><div class="pad" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between"><span class="small muted">Signed in as ${esc(myName())}. App version ${esc(window.APP_VERSION || 'dev')}.</span><span style="display:flex;gap:8px"><button class="btn" data-home>My Home</button></span></div></section>`;
}
const STATUS = [['planning', 'Planning'], ['active', 'Active'], ['complete', 'Complete'], ['archived', 'Archived']];
const STATUS_NOTE = {
  planning: 'Only administrators can see this event, so you can set it up in advance.',
  active: 'Players can see this event and enter scores.',
  complete: 'Players can still see the results. Set each session to View only to freeze scores.',
  archived: 'Hidden from players. Administrators can still open it.',
};
const statusName = s => (STATUS.find(x => x[0] === s) || STATUS[0])[1];
function setupTour() {
  const canStatus = isAppAdmin();
  const admins = tour.eventAdmins || [];
  const adminName = pid => esc(PIDX[pid]?.name || people[pid]?.nick || people[pid]?.fullName || 'Someone');
  const others = Object.entries(people).filter(([id, x]) => !PIDX[id] && !admins.includes(id) && !x.demo && x.role === 'player').sort((a, b) => byName({ name: a[1].fullName }, { name: b[1].fullName }));
  const adminBox = canStatus
    ? `<div class="book adm">${[...tour.players].sort(byName).map(p => `<label class="bk"><input type="checkbox" data-evadmin="${p.id}" ${admins.includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span><span class="muted small">${people[p.id]?.fullName && people[p.id].fullName !== p.name ? esc(people[p.id].fullName) : ''}</span></label>`).join('')}
        ${admins.filter(id => !PIDX[id]).map(id => `<label class="bk"><input type="checkbox" data-evadmin="${id}" checked><span>${adminName(id)}</span><span class="muted small">not playing</span></label>`).join('')}</div>
      ${others.length ? `<select id="addadmin" aria-label="Add an administrator who is not playing"><option value="">Add someone who is not playing…</option>${others.map(([id, x]) => `<option value="${id}">${esc(x.fullName)}</option>`).join('')}</select>` : ''}
      <span class="small muted">Event administrators can set up this event: players, handicaps, sessions, groups and scores. They cannot change its status or who the administrators are. Owner and app administrators can always manage every event.</span>`
    : `<div>${admins.length ? admins.map(adminName).join(', ') : '<span class="muted">None</span>'}</div><span class="small muted">Set by the app administrators.</span>`;
  return `<div class="form">
    <div class="frow prevbox"><label for="as">See the app as a player</label><span class="small muted">Pick a player to check exactly what they will see. A banner lets you switch back.</span>
      <select id="as"><option value="admin" selected>Choose a player…</option>${[...tour.players].sort(teamFirst).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
    <div class="frow"><label for="t-title">Event name</label><input type="text" id="t-title" data-tf="title" value="${esc(tour.title)}"></div>
    <div class="frow"><span class="lab">Status</span>
      ${canStatus ? `<div class="radios" role="radiogroup" aria-label="Event status">${STATUS.map(([k, l]) => `<label class="radio"><input type="radio" name="evstatus" value="${k}" ${(tour.status || 'planning') === k ? 'checked' : ''}><span><b>${l}</b><span class="small muted">${STATUS_NOTE[k]}</span></span></label>`).join('')}</div>`
        : `<div><span class="stchip st-${tour.status}">${statusName(tour.status)}</span></div><span class="small muted">${STATUS_NOTE[tour.status || 'planning']}</span>`}</div>
    <div class="frow"><span class="lab">Event administrators</span>${adminBox}</div>
    <label class="switch tourmode"><input type="checkbox" id="istour" ${isTour() ? 'checked' : ''}> <span>This event is a Tour<span class="small muted" style="display:block;font-weight:500">Two teams play matches for a Cup. Turn on to show team settings, team colours and the Cup page.</span></span></label>
    ${!isTour() ? '' : ['t1', 't2'].map((t, i) => `<div class="frow"><label for="tn-${t}">Team ${i + 1}</label><input type="text" id="tn-${t}" value="${esc(tour.teams[t].name)}" data-teamname="${t}">
      <div class="swatches" role="group" aria-label="Team ${i + 1} colour">${SWATCHES.map(([n, c]) => `<button style="background:${c}" aria-label="${n}" title="${n}" aria-pressed="${tour.teams[t].color === c}" data-swatch="${t}" data-c="${c}"></button>`).join('')}</div></div>`).join('')}
    ${!isTour() ? '' : `<div class="frow"><label for="t-ptw">Points to win the Cup</label><input type="text" inputmode="decimal" id="t-ptw" data-tf="pointsToWin" value="${tour.pointsToWin}" style="max-width:120px"></div>`}
    <div class="frow"><label for="t-grade">A grade: handicap up to</label><input type="text" inputmode="numeric" id="t-grade" data-tf="gradeCut" value="${gradeCut()}" style="max-width:90px">
      <span class="small muted">A grade is handicap ${gradeCut()} or less; B grade is ${gradeCut() + 1} or more. Used to filter the Novelty stats.</span></div>
    <div class="frow"><span class="lab">Live leaderboards for players</span>
      <div class="seg" role="group">${[['live', 'Live'], ['hidden', 'Hidden'], ['until', 'Live until']].map(([k, l]) => `<button aria-pressed="${tour.visibility === k}" data-vis="${k}">${l}</button>`).join('')}</div>
      ${tour.visibility === 'until' ? `<input type="time" id="until" value="${tour.until}" aria-label="Hide leaderboards at" style="max-width:140px">` : ''}
      <span class="small muted">${tour.visibility === 'hidden' ? 'Players see only their own group until you publish.' : tour.visibility === 'until' ? `Players see live leaderboards until ${tour.until}, then only their own group.` : 'Players can follow every group live.'}</span></div>
    ${isAppAdmin() ? `<div class="frow"><span class="lab">Delete this event</span>${ui.confirmDelEv ? `<div class="confirm"><span>Delete <b>${esc(tour.title)}</b> and all its scores? This cannot be undone. Players stay in the directory. To keep the results, set the status to Archived instead.</span><div style="display:flex;gap:8px"><button class="btn danger" data-delevyes>Delete for good</button><button class="btn" data-delevno>Cancel</button></div></div>` : `<div><button class="btn" data-delev>Delete event…</button></div>`}</div>` : ''}
    </div>`;
}
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' });
const teamStyle = t => (t ? `style="color:var(--${t}-text);font-weight:600;border-left:4px solid var(--${t})"` : '');
/* Australian mobiles: 0412 345 678 / +61 412 345 678; other international numbers in +country form. */
function normPhone(v) {
  const d = String(v || '').replace(/[^\d+]/g, '');
  if (/^04\d{8}$/.test(d)) return '+61' + d.slice(1);
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^614\d{8}$/.test(d)) return '+' + d;
  if (/^\+\d{8,15}$/.test(d) && !d.startsWith('+61')) return d;
  return null;
}
const showPhone = n => (n && n.startsWith('+614') ? `0${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}` : n || '');
const teamFirst = (a, b) => (!!b.team - !!a.team) || byName(a, b);
const firstName = s => String(s || '').trim().split(/\s+/)[0] || '';
function setupPlayers() {
  const sub = ui.ptab === 'teams' && !isTour() ? 'list' : ui.ptab || 'list';
  const seg = `<div class="pad" style="padding-bottom:0"><div class="seg" role="group" aria-label="Players section">${[['list', 'Players'], ['invites', 'Links'], ...(isTour() ? [['teams', 'Teams']] : [])].map(([k, l]) => `<button aria-pressed="${sub === k}" data-ptab="${k}">${l}</button>`).join('')}</div></div>`;
  return seg + (sub === 'invites' ? setupInvites() : sub === 'teams' ? teamLists() : setupPlayerList());
}
function setupPlayerList() {
  const list = [...tour.players].sort(isTour() ? teamFirst : byName);
  const firstNone = isTour() ? list.findIndex(p => !p.team) : -1;
  const teamSel = p => (isTour() ? `<td><select data-pf="team" data-pid="${p.id}" aria-label="Team" class="${p.team ? '' : 'warnsel'}"><option value="">No team</option><option value="t1" ${p.team === 't1' ? 'selected' : ''}>${esc(tName('t1'))}</option><option value="t2" ${p.team === 't2' ? 'selected' : ''}>${esc(tName('t2'))}</option></select></td>` : '');
  const cols = isTour() ? 4 : 3;
  const row = p => `<tr class="${p.team || !isTour() ? '' : 'noteam'}"><td><input type="text" value="${esc(p.name)}" data-pf="name" data-pid="${p.id}" aria-label="Nickname for this event" ${isTour() ? teamStyle(p.team) : ''}>${people[p.id]?.fullName ? `<span class="fullname">${esc(people[p.id].fullName)}</span>` : ''}</td>
    ${teamSel(p)}
    <td><input type="text" inputmode="numeric" value="${p.hcp}" data-pf="hcp" data-pid="${p.id}" aria-label="Playing handicap" style="width:52px"></td>
    <td><button class="btn sm ghost" data-delp="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></td></tr>
    ${ui.confirmDel === p.id ? `<tr><td colspan="${cols}"><div class="confirm"><span>Remove <b>${esc(p.name)}</b> from this event? They will also be taken out of any groups. Scores already entered stay saved, and they stay in the player directory.</span><div style="display:flex;gap:8px"><button class="btn danger" data-delyes="${p.id}">Yes, remove</button><button class="btn" data-delno>Cancel</button></div></div></td></tr>` : ''}`;
  const rows = list.map((p, i) => (i === firstNone ? `<tr class="divider"><td colspan="${cols}">No team <span>(${list.length - firstNone}) · not in the ${esc(tName('t1'))} v ${esc(tName('t2'))} Cup unless placed on a side</span></td></tr>` : '') + row(p)).join('');
  const book = Object.entries(people).filter(([id, x]) => !PIDX[id] && (!x.demo || ui.showDemo)).map(([id, x]) => ({ id, ...x, name: x.fullName })).sort(byName);
  const demoCount = Object.entries(people).filter(([id, x]) => !PIDX[id] && x.demo).length;
  const q = (ui.bookQ || '').toLowerCase();
  const summary = isTour() ? `${tour.players.length} players in this event: ${tour.players.filter(p => p.team === 't1').length} ${esc(tName('t1'))}, ${tour.players.filter(p => p.team === 't2').length} ${esc(tName('t2'))}, ${tour.players.filter(p => !p.team).length} with no team.` : `${tour.players.length} players in this event.`;
  return `<div class="pad small muted" style="padding-bottom:0">${summary} The nickname and handicap here are for this event only; they start from the player directory.</div>
    <div style="overflow-x:auto"><table class="lb ed"><thead><tr><th>Nickname</th>${isTour() ? '<th>Team</th>' : ''}<th>HC</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="form addbox">
      <div class="frow"><span class="lab">Add from the player directory</span>
        ${book.length ? `<input type="search" id="bookq" placeholder="Search ${book.length} people" value="${esc(ui.bookQ || '')}">
        <div class="book">${book.map(x => `<label class="bk" ${q && !(x.fullName + ' ' + (x.nick || '')).toLowerCase().includes(q) ? 'hidden' : ''}><input type="checkbox" data-pick="${x.id}" ${ui.picks?.[x.id] ? 'checked' : ''}><span>${esc(x.fullName)}${x.nick ? ` <span class="muted">(${esc(x.nick)})</span>` : ''}${x.demo ? ' <span class="hid">Demo</span>' : ''}</span><span class="muted small">${x.hcp ?? ''}</span></label>`).join('')}</div>
        <div><button class="btn primary" id="addpicked" ${Object.values(ui.picks || {}).some(Boolean) ? '' : 'disabled'}>Add selected to this event</button></div>`
        : '<span class="small muted">Everyone in the player directory is already in this event.</span>'}
        ${demoCount ? `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="showdemo" ${ui.showDemo ? 'checked' : ''}> Show ${demoCount} demo players</label>` : ''}</div>
      <div class="frow"><span class="lab">New player</span><span class="small muted">Adds them to the player directory too, so they can be added to any future event.</span>
        <div class="newp2"><input type="text" id="nfull" placeholder="Full name" autocomplete="off"><input type="text" id="nnick" placeholder="Nickname (optional)" autocomplete="off"><input type="tel" id="nphone" placeholder="Mobile (optional)" inputmode="tel"><input type="text" id="nhcp" placeholder="HC" inputmode="numeric" style="width:64px"><button class="btn" id="addp">Add</button></div></div>
    </div>`;
}
const appUrl = () => location.origin + location.pathname;
const personalUrl = (pid, eid = tourId) => `${appUrl()}#join=${people[pid]?.token}${eid ? '&e=' + eid : ''}`;
const eventUrl = () => `${appUrl()}#e=${tourId}`;
function inviteText(pid) {
  const nm = PIDX[pid]?.name || people[pid]?.nick || firstName(people[pid]?.fullName);
  return `Hi ${nm}, here is your personal link for golf scoring${tour ? ` (${tour.title})` : ''}. Tap it to sign in on your phone. It works for future events too, so keep this text: ${personalUrl(pid)}`;
}
const smsSep = () => (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? '&' : '?');
const smsHref = pid => { const n = normPhone(people[pid]?.phone); return n && people[pid]?.token ? `sms:${n}${smsSep()}body=${encodeURIComponent(inviteText(pid))}` : null; };
const linkStatus = pid => (devCount[pid] ? `<span class="st ok">Signed in${devCount[pid] > 1 ? ` · ${devCount[pid]} phones` : ''}</span>` : people[pid]?.sentAt ? '<span class="st sent">Texted</span>' : '<span class="st">Not sent</span>');
function setupInvites() {
  const list = [...tour.players].sort(isTour() ? teamFirst : byName);
  const sent = list.filter(p => people[p.id]?.sentAt).length, joined = list.filter(p => devCount[p.id]).length;
  const sel = ui.sel || {}; const nSel = list.filter(p => sel[p.id]).length;
  const q = ui.queue;
  const qBox = q ? (() => {
    const pid = q.ids[q.i];
    if (!pid) return `<div class="queue"><b>Done.</b> ${q.ids.length} text${q.ids.length === 1 ? '' : 's'} opened. <button class="btn sm" data-qstop>Close</button></div>`;
    return `<div class="queue"><span>Texting ${q.ids.length} ${q.ids.length === 1 ? 'person' : 'people'}: <b>${q.i + 1} of ${q.ids.length}</b></span>
      <a class="btn primary" href="${smsHref(pid)}" data-sent="${pid}" data-q>Text ${esc(PIDX[pid]?.name)}</a>
      <span class="small muted">Press send in Messages, then come back here for the next one.</span>
      <div style="display:flex;gap:8px"><button class="btn sm" data-qskip>Skip</button><button class="btn sm" data-qstop>Stop</button></div></div>`;
  })() : '';
  const rows = list.map(p => {
    const raw = ui.phoneDraft?.[p.id] ?? showPhone(people[p.id]?.phone);
    const norm = normPhone(raw); const bad = raw && !norm;
    const href = smsHref(p.id);
    return `<div class="invrow"><div class="nm"><label class="sel"><input type="checkbox" data-sel="${p.id}" ${sel[p.id] ? 'checked' : ''} aria-label="Select ${esc(p.name)}"><span ${isTour() && p.team ? `style="color:var(--${p.team}-text)"` : ''}>${esc(p.name)}</span></label> ${linkStatus(p.id)}</div>
      <input type="tel" inputmode="tel" value="${esc(raw)}" placeholder="Mobile number" data-phone="${p.id}" aria-label="Mobile for ${esc(p.name)}" class="${bad ? 'bad' : ''}">
      <div class="ia">${href ? `<a class="btn sm primary" href="${href}" data-sent="${p.id}">Text link</a>` : `<button class="btn sm" disabled>Text link</button>`}<button class="btn sm" data-copy="${p.id}" ${people[p.id]?.token ? '' : 'disabled'}>Copy</button></div>
      ${bad ? '<div class="small err-t">Check this number: an Australian mobile looks like 0412 345 678.</div>' : ''}</div>`;
  }).join('');
  return `<div class="pad evlink"><b>Event link for your WhatsApp group</b>
      <span class="small muted">Anyone who has opened their personal link on their phone goes straight into this event with the right view for them. Anyone who hasn't is asked to open their personal link first.</span>
      <code>${esc(eventUrl())}</code>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" data-copyevent>Copy event link</button>${navigator.share ? '<button class="btn sm" data-shareevent>Share…</button>' : ''}</div></div>
    <div class="pad" style="display:grid;gap:6px;padding-bottom:4px;border-top:1px solid var(--rule)"><b>Personal links</b><span><b>${sent}</b> of ${list.length} texted · <b>${joined}</b> signed in</span>
    <span class="small muted">Each person has one personal link that works for every event they are in. Text link opens Messages with their number and link filled in: just press send. Send it again any time someone has lost it. Mobile numbers are kept in the player directory and never shown to players.</span>
    <div class="selbar"><span class="small">Select:</span><button class="btn sm" data-selall="all">All</button><button class="btn sm" data-selall="out">Not signed in</button><button class="btn sm" data-selall="none">None</button>
      <button class="btn sm primary" data-textsel ${nSel ? '' : 'disabled'}>Text selected (${nSel})</button></div></div>
    ${qBox}
    <div class="invlist">${rows}</div>`;
}
function teamLists() {
  const sort = ui.teamSort || 'name';
  const cmp = sort === 'hcp' ? (a, b) => a.hcp - b.hcp || byName(a, b) : byName;
  const col = t => { const ps = tour.players.filter(p => (p.team || null) === t).sort(cmp); const hcAvg = ps.length ? (ps.reduce((x, p) => x + p.hcp, 0) / ps.length).toFixed(1) : '–';
    return `<div class="tcol ${t ? 'tc-' + t : 'tc-none'}"><div class="th"><span>${t ? esc(tName(t)) : 'No team'}</span><span class="small">${ps.length} · avg HC ${hcAvg}</span></div><ol>${ps.map(p => `<li><span>${esc(p.name)}</span><span class="hc">${p.hcp}</span></li>`).join('') || '<li class="muted">None yet</li>'}</ol></div>`; };
  const none = tour.players.some(p => !p.team);
  return `<div class="teams-panel"><div class="tp-head"><b>Teams</b><div class="seg" role="group" aria-label="Sort teams by">${[['name', 'A–Z'], ['hcp', 'Handicap']].map(([k, l]) => `<button aria-pressed="${sort === k}" data-tsort="${k}">${l}</button>`).join('')}</div></div>
    <div class="tcols">${col('t1')}${col('t2')}</div>${none ? col(null) : ''}</div>`;
}
function setupCourses() {
  const list = tour.courses.map(c => c.tees.map(t => {
    const open = ui.open['crs:' + c.id + t.id];
    return `<div class="xrow"><button data-open="crs:${c.id}${t.id}" aria-expanded="${!!open}"><span class="pm">${open ? '−' : '+'}</span><span><b>${esc(c.name)}</b> <span class="tee" style="--tee:${t.colour}"><i style="background:${t.colour}"></i>${esc(t.name)} · Par ${t.holes.reduce((a, h) => a + h.par, 0)}</span></span></button>
      ${open ? (ui.crsEdit === c.id + '|' + t.id ? courseEditor(c, t) : `<div class="det" style="overflow-x:auto"><table class="mini holes"><tr class="hd"><th>Hole</th><th>Par</th><th>Index</th><th>19-36</th><th>37-54</th><th>Match</th></tr>${t.holes.map(h => `<tr><td>${h.number}</td><td>${h.par}</td><td>${h.strokeIndexes[0]}</td><td>${h.strokeIndexes[1] ?? ''}</td><td>${h.strokeIndexes[2] ?? ''}</td><td>${h.matchIndexes[0]}</td></tr>`).join('')}</table>
        <div style="padding-top:8px"><button class="btn sm" data-crsedit="${c.id}|${t.id}">Edit course and indexes</button></div></div>`) : ''}</div>`;
  }).join('')).join('');
  const err = ui.courseErr ? `<div class="banner" style="margin:0">${esc(ui.courseErr)}</div>` : '';
  return `<div class="pad small muted" style="padding-bottom:6px">Your course library. Each session picks a course and tee from here.</div>${list}
    <div class="form" style="padding-top:14px;border-top:1px solid var(--rule)"><span class="lab" style="font-weight:700">Add a course and tee</span>
      <div class="frow"><label for="cn">Course</label><input type="text" id="cn" list="courselist" placeholder="e.g. Barnbougle Lost Farm"><datalist id="courselist">${tour.courses.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist></div>
      <div class="frow"><label for="ctn">Tee</label><div style="display:flex;gap:8px;align-items:center"><input type="text" id="ctn" placeholder="e.g. Blue"><select id="ctc" aria-label="Tee colour">${[['Blue', '#2a5fb0'], ['White', '#f4f4f4'], ['Black', '#26292e'], ['Red', '#c8372d'], ['Gold', '#f2b705'], ['Green', '#00843d']].map(([n, c]) => `<option value="${c}">${n}</option>`).join('')}</select></div></div>
      <div class="frow"><label for="cpaste">Paste 18 rows from your hole-index workbook</label>
        <span class="small muted">One row per hole, in order: Par, Index (1-18), then optionally Index 19-36, Index 37-54 and the Match play index. Copy the cells in Excel and paste here.</span>
        <textarea id="cpaste" rows="6" placeholder="4\t1\t19\t37\t18&#10;4\t3\t22\t40\t8&#10;…"></textarea></div>
      ${err}<div><button class="btn primary" id="addc">Check and add</button></div></div>`;
}
const TEE_COLOURS = [['Blue', '#2a5fb0'], ['White', '#f4f4f4'], ['Black', '#26292e'], ['Red', '#c8372d'], ['Gold', '#f2b705'], ['Green', '#00843d']];
function courseEditor(c, t) {
  const used = tour.days.filter(d => d.courseId === c.id && d.teeId === t.id);
  const inp = (k, i, v) => `<td><input type="text" inputmode="numeric" data-ce="${k}" data-i="${i}" value="${v ?? ''}" aria-label="${k} hole ${i + 1}"></td>`;
  return `<div class="det crsedit"><div class="form" style="padding:0">
    <div class="two"><div class="frow"><label for="ce-name">Course name</label><input type="text" id="ce-name" value="${esc(c.name)}"></div>
      <div class="frow"><label for="ce-tee">Tee</label><div style="display:flex;gap:8px"><input type="text" id="ce-tee" value="${esc(t.name)}"><select id="ce-col" aria-label="Tee colour">${TEE_COLOURS.map(([n, col]) => `<option value="${col}" ${t.colour === col ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div></div>
    <div style="overflow-x:auto"><table class="mini holes edit"><tr class="hd"><th>Hole</th><th>Par</th><th>Index</th><th>19-36</th><th>37-54</th><th>Match</th></tr>
      ${t.holes.map((h, i) => `<tr><td>${h.number}</td>${inp('par', i, h.par)}${inp('i1', i, h.strokeIndexes[0])}${inp('i2', i, h.strokeIndexes[1])}${inp('i3', i, h.strokeIndexes[2])}${inp('mi', i, h.matchIndexes[0])}</tr>`).join('')}</table></div>
    <span class="small muted">The course name changes for every tee of ${esc(c.name)}. Leave the 19-36 or 37-54 column empty if the card does not print it. ${used.length ? `Used by ${used.map(d => esc(d.title)).join(', ')}: scores and results there recalculate with the new indexes.` : ''}</span>
    <div class="crs-err"></div>
    <div style="display:flex;gap:8px"><button class="btn primary" data-crssave="${c.id}|${t.id}">Save changes</button><button class="btn" data-crscancel>Cancel</button></div></div></div>`;
}
/** 18 rows of [par, index, index 19-36, index 37-54, match index] (blank = undefined) -> holes, with checks. */
function holesFromRows(rows) {
  rows.forEach((r, i) => { if (!(r[0] >= 3 && r[0] <= 6)) throw new Error(`Hole ${i + 1}: par ${r[0] ?? '(blank)'} looks wrong.`); });
  const blank = x => x === undefined || x === null || Number.isNaN(x);
  const perm = (col, lo, label) => {
    const v = rows.map(r => r[col]);
    if (v.every(blank)) return null;
    if (v.some(blank)) throw new Error(`The ${label} column has gaps: fill in all 18 holes or leave it all empty.`);
    const sorted = [...v].sort((a, b) => a - b);
    if (!sorted.every((x, i) => x === lo + i)) throw new Error(`The ${label} column must use each number ${lo} to ${lo + 17} once.`);
    return v;
  };
  const i1 = perm(1, 1, 'index'); if (!i1) throw new Error('The index column is needed.');
  const i2 = perm(2, 19, '19-36'), i3 = perm(3, 37, '37-54'), mi = perm(4, 1, 'match play');
  if (i3 && !i2) throw new Error('Fill in the 19-36 column before the 37-54 column.');
  return rows.map((r, i) => ({ number: i + 1, par: r[0], strokeIndexes: [r[1], ...(i2 ? [r[2]] : []), ...(i3 ? [r[3]] : [])], matchIndexes: [mi ? r[4] : r[1]] }));
}
function parseHoles(text) {
  const rows = text.trim().split(/\r?\n/).map(r => r.trim()).filter(Boolean).map(r => r.split(/[\t,; ]+/).map(Number));
  if (rows.length !== 18) throw new Error(`Found ${rows.length} rows; there must be 18, one per hole.`);
  rows.forEach((r, i) => { if (r.length < 2 || r.some(isNaN)) throw new Error(`Row ${i + 1} needs at least a par and an index (numbers only).`); if (r[0] < 3 || r[0] > 6) throw new Error(`Row ${i + 1}: par ${r[0]} looks wrong.`); });
  const perm = (col, lo) => { const v = rows.map(r => r[col]); if (v.some(x => x === undefined)) return null; const s = [...v].sort((a, b) => a - b); return s.every((x, i) => x === lo + i) ? v : 'bad'; };
  const i1 = perm(1, 1); if (i1 === 'bad') throw new Error('The index column must use each number 1 to 18 once.');
  const i2 = perm(2, 19); if (i2 === 'bad') throw new Error('The 19-36 column must use each number 19 to 36 once.');
  const i3 = perm(3, 37); if (i3 === 'bad') throw new Error('The 37-54 column must use each number 37 to 54 once.');
  const mi = perm(4, 1); if (mi === 'bad') throw new Error('The match play column must use each number 1 to 18 once.');
  return rows.map((r, i) => ({ number: i + 1, par: r[0], strokeIndexes: [r[1], ...(i2 ? [r[2]] : []), ...(i3 ? [r[3]] : [])], matchIndexes: [mi ? r[4] : r[1]] }));
}
function setupDays() {
  const crsOpts = d => tour.courses.flatMap(c => c.tees.map(t => `<option value="${c.id}|${t.id}" ${d.courseId === c.id && d.teeId === t.id ? 'selected' : ''}>${esc(c.name)} · ${esc(t.name)}</option>`)).join('');
  return tour.days.map(d => {
    const open = ui.open['day:' + d.id] ?? d.id === DAY().id;
    const check = assignmentCheck(d);
    return `<div class="xrow"><button data-open="day:${d.id}" aria-expanded="${!!open}"><span class="pm">${open ? '−' : '+'}</span><span><b>${esc(d.title)}</b> · ${fmtDate(d.date)} <span class="small muted">${d.groups.length} groups</span>${d.hidden ? ' <span class="hid">Hidden</span>' : ''}</span></button>
    ${open ? `<div class="form">
      <div class="two"><div class="frow"><label>Name</label><input type="text" value="${esc(d.title)}" data-df="title" data-did="${d.id}"></div><div class="frow"><label>Date</label><input type="date" value="${d.date}" data-df="date" data-did="${d.id}"></div></div>
      <div class="frow"><label>Course and tee</label><select data-df="course" data-did="${d.id}"><option value="">Choose…</option>${crsOpts(d)}</select></div>
      <label class="switch tourmode"><input type="checkbox" data-df="shown" data-did="${d.id}" ${!d.hidden ? 'checked' : ''}> <span>Show this session to players<span class="small muted" style="display:block;font-weight:500">${d.hidden ? 'Hidden: players cannot see this session yet, so you can set it up in advance.' : 'Players can see the order of play, briefing and scores for this session.'}</span></span></label>
      <div class="frow"><span class="lab">Players can</span><div class="seg" role="group" aria-label="Scoring access">${[['edit', 'View and edit'], ['view', 'View only']].map(([k, l]) => `<button aria-pressed="${(d.mode || 'edit') === k}" data-mode="${k}" data-did="${d.id}">${l}</button>`).join('')}</div>
        <span class="small muted">${viewOnly(d) ? 'Results are final: players can see but not change scores. Administrators can still edit.' : 'Players enter scores for their own match.'}</span></div>
      <div class="frow"><span class="lab">Individual scoring</span><div class="seg" role="group" aria-label="Individual scoring">${[['stableford', 'Stableford'], ['both', 'Stableford + Stroke'], ['net', 'Stroke only']].map(([k, l]) => `<button aria-pressed="${scoringOf(d) === k}" data-scoring="${k}" data-did="${d.id}">${l}</button>`).join('')}</div></div>
      <label class="switch tourmode"><input type="checkbox" data-df="multiplier" data-did="${d.id}" ${multOn(d) ? 'checked' : ''}> <span>Team Multiplier Stableford<span class="small muted" style="display:block;font-weight:500">Novelty: on each hole everyone's Stableford points in the group are multiplied together; any 0 or pickup wipes the hole. Adds a Multiplier view to the scorecard and a Multiplier leaderboard.</span></span></label>
      ${!isTour() ? '' : `<label class="switch tourmode"><input type="checkbox" data-df="teamsOn" data-did="${d.id}" ${d.teamsOn !== false ? 'checked' : ''}> <span>Tour mode: <b style="color:var(--t1-text)">${esc(tName('t1'))}</b> v <b style="color:var(--t2-text)">${esc(tName('t2'))}</b><span class="small muted" style="display:block;font-weight:500">Matches are ${esc(tName('t1'))} v ${esc(tName('t2'))} and count towards the Cup. Turn off for a session of mixed groups.</span></span></label>`}
      <div class="frow"><label>Briefing</label><textarea rows="3" data-df="briefing" data-did="${d.id}" placeholder="Meeting time, format, nearest the pins…">${esc(d.briefing || '')}</textarea></div>
      <div class="frow"><span class="lab">Groups</span>${check}</div>
      ${d.groups.map((g, i) => groupEditor(d, g, i)).join('')}
      <div><button class="btn" data-addgroup="${d.id}">Add group</button></div></div>` : ''}</div>`;
  }).join('') + `<div class="pad"><button class="btn primary" id="addday">Add a session</button></div>`;
}
function assignmentCheck(d) {
  if (!isTour()) return noTeamCheck(d);
  const counts = {}; d.groups.forEach(g => groupPlayers(g).forEach(id => (counts[id] = (counts[id] || 0) + 1)));
  const dup = Object.keys(counts).filter(id => counts[id] > 1).map(id => PIDX[id]?.name);
  const left = t => tour.players.filter(p => p.team === t && !counts[p.id]).sort(byName);
  const l1 = left('t1'), l2 = left('t2');
  const dupHtml = dup.length ? `<div class="banner" style="margin:0">In more than one group: ${dup.map(esc).join(', ')}.</div>` : '';
  if (!l1.length && !l2.length) return dupHtml + `<span class="small" style="color:var(--ok);font-weight:600">Every ${esc(tName('t1'))} and ${esc(tName('t2'))} player is in a group.</span>`;
  const col = (t, ps) => `<div class="tcol tc-${t}"><div class="th"><span>${esc(tName(t))}</span><span class="small">${ps.length} to place</span></div><ol>${ps.map(p => `<li><span>${esc(p.name)}</span><span class="hc">${p.hcp}</span></li>`).join('') || '<li class="muted">All placed</li>'}</ol></div>`;
  return dupHtml + `<div class="unassigned"><div class="small" style="font-weight:600">Not yet in a group</div><div class="tcols">${col('t1', l1)}${col('t2', l2)}</div></div>`;
}
function noTeamCheck(d) {
  const counts = {}; d.groups.forEach(g => groupPlayers(g).forEach(id => (counts[id] = (counts[id] || 0) + 1)));
  const dup = Object.keys(counts).filter(id => counts[id] > 1).map(id => PIDX[id]?.name);
  const left = tour.players.filter(p => !counts[p.id]).sort(byName);
  return (dup.length ? `<div class="banner" style="margin:0">In more than one group: ${dup.map(esc).join(', ')}.</div>` : '') +
    (left.length ? `<div class="small"><b>Not yet in a group:</b> ${left.map(p => esc(p.name)).join(', ')}</div>` : `<span class="small" style="color:var(--ok);font-weight:600">Every player is in a group.</span>`);
}
function groupEditor(d, g, i) {
  const f = FORMATS[g.format]; const used = new Set(d.groups.flatMap(groupPlayers));
  const tourMode = isTour() && d.teamsOn !== false && f.match;
  const sideTeam = side => (tourMode ? (side === 'a' ? 't1' : 't2') : null);
  const opt = (p, v) => `<option value="${p.id}" ${p.id === v ? 'selected' : ''}>${esc(p.name)} (${p.hcp})${used.has(p.id) && p.id !== v ? ' ✓' : ''}</option>`;
  const grp = (label, ps, v) => (ps.length ? `<optgroup label="${esc(label)}">${ps.map(p => opt(p, v)).join('')}</optgroup>` : '');
  const slot = (side, k) => {
    const v = g.slots[side][k] || ''; const t = sideTeam(side); const cur = PIDX[v];
    const by = team => tour.players.filter(p => (p.team || null) === team).sort(byName);
    let opts;
    if (t) { const other = t === 't1' ? 't2' : 't1'; opts = grp(tName(t), by(t), v) + grp('No team', by(null), v) + (cur && cur.team === other ? grp(tName(other) + ' (other team)', [cur], v) : ''); }
    else opts = grp(tName('t1'), by('t1'), v) + grp(tName('t2'), by('t2'), v) + grp('No team', by(null), v);
    return `<select data-slot="${side}${k}" data-did="${d.id}" data-gid="${g.id}" aria-label="Player" ${cur ? teamStyle(cur.team) : ''}><option value="">— choose —</option>${opts}</select>`;
  };
  const sideA = Array.from({ length: f.a }, (_, k) => slot('a', k)).join('');
  const sideB = Array.from({ length: f.b }, (_, k) => slot('b', k)).join('');
  const sw = ui.swap && ui.swap.gid === g.id && ui.swap.did === d.id ? ui.swap : null;
  const swapBox = sw ? `<div class="confirm"><span><b>${esc(PIDX[sw.old]?.name)}</b> has ${sw.held} hole${sw.held > 1 ? 's' : ''} entered for this session. ${sw.nv ? `Replace him with <b>${esc(PIDX[sw.nv]?.name)}</b>` : 'Take him out of the group'} anyway? His scores stay saved and come back if you put him back.</span>
    <div style="display:flex;gap:8px"><button class="btn danger" data-swapyes>${sw.nv ? 'Replace' : 'Take out'}</button><button class="btn" data-swapno>Keep ${esc(PIDX[sw.old]?.name)}</button></div></div>` : '';
  const n = d.groups.length;
  return `<div class="gedit"><div class="ghd"><b>Group ${i + 1}</b><input type="time" value="${hhmm(g.tee)}" data-gf="tee" data-did="${d.id}" data-gid="${g.id}" aria-label="Tee time for group ${i + 1}" step="60">
    <span class="mv"><button class="btn sm" data-gmove="-1" data-gid="${g.id}" data-did="${d.id}" aria-label="Move group ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn sm" data-gmove="1" data-gid="${g.id}" data-did="${d.id}" aria-label="Move group ${i + 1} later" ${i === n - 1 ? 'disabled' : ''}>↓</button></span>
    <button class="btn sm" data-delgroup="${g.id}" data-did="${d.id}" aria-label="Remove group ${i + 1}">Remove</button></div>
    <div class="two"><select data-gf="format" data-did="${d.id}" data-gid="${g.id}" aria-label="Format">${Object.keys(FORMATS).map(k => `<option value="${k}" ${k === g.format ? 'selected' : ''}>${esc(formatLabel(k, d))}</option>`).join('')}</select>
    ${f.match ? `<div style="display:flex;gap:6px">${g.format !== 'ambroseMatch' ? `<select data-gf="method" data-did="${d.id}" data-gid="${g.id}" aria-label="Handicap method"><option value="front" ${g.method !== 'back' ? 'selected' : ''}>Front of card</option><option value="back" ${g.method === 'back' ? 'selected' : ''}>Back of card</option></select>` : ''}
      <select data-gf="value" data-did="${d.id}" data-gid="${g.id}" aria-label="Points per match"><option value="1" ${g.value === 1 ? 'selected' : ''}>1 pt</option><option value="0.5" ${g.value === 0.5 ? 'selected' : ''}>½ pt</option></select></div>` : '<span></span>'}</div>
    ${tourMode ? (() => { const n = [['a', 't1'], ['b', 't2']].flatMap(([sd, tm]) => g.slots[sd].filter(Boolean).filter(id => PIDX[id] && !PIDX[id].team).map(id => `${esc(PIDX[id].name)} (no team) plays for ${esc(tName(tm))} in this group.`)); return n.length ? `<div class="small" style="color:var(--muted)">${n.join(' ')}</div>` : ''; })() : ''}
    ${swapBox}
    ${f.match ? `<div class="slots"><div class="${tourMode ? 'side-t1' : ''}">${tourMode ? `<span class="sidelbl" style="color:var(--t1-text)">${esc(tName('t1'))}</span>` : ''}${sideA}</div><span class="v">v</span><div class="${tourMode ? 'side-t2' : ''}">${tourMode ? `<span class="sidelbl" style="color:var(--t2-text)">${esc(tName('t2'))}</span>` : ''}${sideB}</div></div><span class="small muted">${g.format === 'singles' ? 'Top left plays top right; bottom left plays bottom right.' : g.format === 'twoVone' ? 'Both players on the left each play the single player on the right.' : 'Left pair v right pair.'}</span>` : `<div class="slots one">${sideA}</div>`}</div>`;
}

/* ---------- entry sheet ---------- */
function curUnit() { const day = DAY(); const g = day.groups.find(x => x.id === ui.group); return unitsOf(day, g, true)[ui.unit[day.id + ':' + g.id] || 0]; }
function openEntry(i) {
  const u = curUnit();
  if (!canEdit(u)) { toast(viewOnly(u.day) ? 'This session is view only.' : locks[u.key] ? 'Scores are locked. Ask an administrator to make a change.' : 'You can only enter scores for your own match.'); return; }
  ui.entry = { i, draft: Object.fromEntries(u.ents.map(id => [id, sc(id)[i] ?? course.holes[i].par])) };
  renderSheet();
}
function renderSheet() {
  const box = document.getElementById('overlay');
  if (!ui.entry) { box.innerHTML = ''; return; }
  const u = curUnit(); const { i, draft } = ui.entry; const h = course.holes[i];
  const order = u.sides ? [...u.sides[0], ...u.sides[1]] : u.ents;
  box.innerHTML = `<div class="scrim" data-cancel></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Scores for hole ${h.number}"><div class="in">
    <div class="hd"><h3>Hole ${h.number}</h3><span class="muted small">Par ${h.par} · Index ${h.strokeIndexes[0]} · ${esc(u.label)}</span></div>
    ${order.map(id => { const v = draft[id]; const isP = v === 'P'; const team = !PIDX[id];
      const shots = team ? 0 : E.strokesOnHole(PIDX[id].hcp, h.strokeIndexes);
      return `<div class="erow"><div class="nm"><span class="dot ${entTeam(id) || ''}"></span>${esc(entName(id))}<small>${team ? 'Team score' : `HC ${PIDX[id].hcp}${shots ? ` · ${shots} shot${shots > 1 ? 's' : ''}` : ''}`}</small></div>
        <div class="stepper"><button data-step="-1" data-id="${id}" aria-label="One less for ${esc(entName(id))}" ${isP ? 'disabled' : ''}>−</button>
        <span class="val">${isP ? '<span class="mk pu">P</span>' : marker(v, h.par)}</span>
        <button data-step="1" data-id="${id}" aria-label="One more for ${esc(entName(id))}" ${isP ? 'disabled' : ''}>+</button>
        <button class="p" data-pu="${id}" aria-pressed="${isP}" aria-label="Pickup for ${esc(entName(id))}">P</button></div></div>`; }).join('')}
    <div class="acts"><button class="btn" data-cancel>Cancel</button><button class="btn" data-clear>Clear</button><button class="btn primary" data-save>Save</button></div>
  </div></div>`;
}


/* ---------- who is using the app ---------- */
const hashParams = () => Object.fromEntries(location.hash.replace(/^#/, '').split('&').filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent)));
const isOwner = () => !!(me && ((cfg?.ownerUids || []).includes(me.uid) || myPerson?.role === 'owner'));
const isAppAdmin = () => isOwner() || myPerson?.role === 'appAdmin';
const isStaff = () => isAppAdmin() || (myPerson?.adminOf || []).length > 0;
const isEventAdmin = () => !!(tour && myPid && (tour.eventAdmins || []).includes(myPid));
const isRealAdmin = () => !!(tour && (isAppAdmin() || isEventAdmin()));
const roleName = () => (isOwner() ? 'Owner' : isAppAdmin() ? 'App administrator' : isEventAdmin() ? 'Event administrator' : 'Player');
const myName = () => myPerson?.fullName || me?.name || me?.email || 'you';
const errText = e => (e && e.code === 'permission-denied' ? 'You do not have permission to do that.' : e && e.code === 'unavailable' ? 'No signal: it will sync when you are back in range.' : (e && e.message) || 'Something went wrong.');
const ACTIVE = ['active', 'complete'];

/** Who may score what: administrators can do anything; players only their own group (checked again by the database rules). */
function accessMap(t) {
  const a = {};
  for (const d of t.days) {
    a[d.id] = d.mode === 'view' ? { __viewonly: 'yes' } : {};
    for (const g of d.groups) {
      [...g.slots.a, ...g.slots.b].filter(Boolean).forEach(id => (a[d.id][id] = g.id));
      if (g.format === 'ambroseMatch') (g.ambIds || [g.id + '-a', g.id + '-b']).forEach(id => (a[d.id][id] = g.id));
      if (g.format === 'ambroseStroke') (g.ambIds || [g.id + '-t']).forEach(id => (a[d.id][id] = g.id));
    }
  }
  return a;
}
// Fields worked out from the set-up when saving (who can see the event, who may score what).
const DERIVED = ['access', 'members', 'visibleTo'];
const tourForSave = t => { const c = clone(t) || {}; DERIVED.forEach(k => delete c[k]); return c; };
function eventDoc(t) {
  const c = tourForSave(t);
  c.status = c.status || 'planning'; c.eventAdmins = c.eventAdmins || [];
  c.members = [...new Set([...c.players.map(p => p.id), ...c.eventAdmins])];
  c.visibleTo = ACTIVE.includes(c.status) ? [...c.members] : [...c.eventAdmins];
  c.access = accessMap(c);
  return c;
}
let tourTimer = null;
let tourDirty = false;   // a local set-up change is waiting to save: don't let an incoming copy overwrite it
function queueTourSave() {
  clearTimeout(tourTimer); tourDirty = true;
  tourTimer = setTimeout(() => {
    tourDirty = false;
    fb.set(`events/${tourId}`, eventDoc(tour)).catch(e => failed('Set-up not saved', e));
  }, 350);
}
function unitKeyFor(dayId, ent) {
  const day = dayById(dayId); if (!day) return '';
  for (const g of day.groups) { const u = unitsOf(day, g).find(x => x.ents.includes(ent)); if (u) return u.key; }
  return '';
}
/** Push any local change (scores, locks, set-up) to the database. Called after every render. */
function syncOut() {
  if (!tourId || !tour) return;
  if (isRealAdmin() && JSON.stringify(tourForSave(tour)) !== JSON.stringify(tourForSave(server.tour))) { server.tour = clone(tour); queueTourSave(); }
  const acc = accessMap(tour);
  for (const [dayId, ents] of Object.entries(scores)) for (const [ent, holes] of Object.entries(ents)) {
    if (JSON.stringify(server.scores[dayId]?.[ent]) === JSON.stringify(holes)) continue;
    (server.scores[dayId] = server.scores[dayId] || {})[ent] = clone(holes);
    fb.set(`events/${tourId}/scores/${dayId}_${ent}`, { dayId, ent, holes, groupId: acc[dayId]?.[ent] || '', unitKey: unitKeyFor(dayId, ent), by: me.uid, at: fb.now() })
      .catch(e => failed('Score not saved', e));
  }
  for (const k of Object.keys(locks)) if (!server.locks[k]) {
    server.locks[k] = locks[k]; const [dayId, groupId] = k.split(':');
    fb.set(`events/${tourId}/locks/${k}`, { dayId, groupId, by: me.uid, at: fb.now() }).catch(e => failed('Not submitted', e));
  }
  for (const k of Object.keys(server.locks)) if (!locks[k]) { delete server.locks[k]; fb.del(`events/${tourId}/locks/${k}`).catch(e => toast('Not unlocked: ' + errText(e))); }
}
let pendingRender = false;
let syncErr = null;
function failed(what, e) { syncErr = `${what}: ${errText(e)}`; toast(syncErr); safeRender(); }
function safeRender() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('#view') && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /text|date|time|number|tel|search/.test(a.type)))) { pendingRender = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) { pendingRender = false; safeRender(); } }, 0));

function stopWatching() { unsubs.forEach(u => u && u()); unsubs = []; }
function openTour(id) {
  stopWatching(); tourId = id; tour = null; scores = {}; locks = {}; sides = {}; ui.sideEdit = null;
  server.tour = null; server.scores = {}; server.locks = {};
  store(':tour', id); if (!location.hash.includes('e=' + id)) history.replaceState(null, '', '#e=' + id);
  gate = { state: 'loading' }; render();
  unsubs.push(fb.watchDoc(`events/${id}`, (data, meta) => {
    if (!data) { gate = { state: 'error', msg: 'This event could not be found. It may have been deleted.' }; render(); return; }
    sync.cached = meta.cached;
    // Ignore an incoming copy that is unchanged from the last one seen (keeps local edits that are about to save),
    // or that arrives while a local change is waiting to save.
    const same = server.tour && JSON.stringify(tourForSave(data)) === JSON.stringify(tourForSave(server.tour));
    if (tourDirty || (same && tour)) { if (gate.state !== 'ready') { gate = { state: 'ready' }; safeRender(); } return; }
    tour = tourForSave(data); server.tour = clone(tour);
    gate = { state: 'ready' }; safeRender();
  }, e => { gate = { state: 'error', msg: e && e.code === 'permission-denied' ? 'This event is not open to you. It may still be in planning, or you may not be in it. Check with the organiser.' : errText(e) }; render(); }));
  unsubs.push(fb.watchColl(`events/${id}/scores`, (docs, meta) => {
    const s = {}; docs.forEach(({ data }) => ((s[data.dayId] = s[data.dayId] || {})[data.ent] = data.holes));
    scores = s; server.scores = clone(s); sync.pending = meta.pending; sync.cached = meta.cached; if (tour) safeRender();
  }, () => {}));
  unsubs.push(fb.watchColl(`events/${id}/sides`, docs => {
    const m = {}; docs.forEach(({ data }) => (m[data.dayId + ':' + data.groupId] = data)); sides = m; if (tour) safeRender();
  }, () => {}));
  unsubs.push(fb.watchColl(`events/${id}/locks`, docs => {
    const l = {}; docs.forEach(({ id: k, data }) => (l[k] = data)); locks = l; server.locks = clone(l); if (tour) safeRender();
  }, () => {}));
}
/* The player directory and who has signed in (staff only), watched for the whole visit. */
let staffUnsubs = [];
function startStaffWatch() {
  if (staffUnsubs.length || !isStaff()) return;
  staffUnsubs.push(fb.watchColl('people', docs => { const m = {}; docs.forEach(({ id, data }) => (m[id] = data)); people = m; safeRender(); }, () => {}));
  staffUnsubs.push(fb.watchColl('devices', docs => { const m = {}; docs.forEach(({ data }) => (m[data.personId] = (m[data.personId] || 0) + 1)); devCount = m; safeRender(); }, () => {}));
}
function stopAll() { stopWatching(); staffUnsubs.forEach(u => u && u()); staffUnsubs = []; meUnsub && meUnsub(); meUnsub = null; }
const making = new Set();
/** Make sure each of these people has a personal link. */
function ensureLinks(pids) {
  for (const pid of pids) if (people[pid] && !people[pid].token && !making.has(pid)) {
    making.add(pid); const tk = token();
    fb.set(`links/${tk}`, { personId: pid, name: people[pid].nick || firstName(people[pid].fullName), at: fb.now() })
      .then(() => fb.merge(`people/${pid}`, { token: tk }))
      .catch(e => failed('Personal link not made', e)).finally(() => making.delete(pid));
  }
}
function savePerson(pid, patch) {
  people[pid] = { ...(people[pid] || {}), ...patch };
  fb.merge(`people/${pid}`, patch).catch(e => failed('Player directory not saved', e));
}
function newPerson({ fullName, nick, phone, hcp }) {
  const pid = fb.newId();
  const rec = { fullName, nick: nick || firstName(fullName), phone: phone || '', hcp: hcp ?? 18, role: 'player', adminOf: [], at: fb.now() };
  people[pid] = rec;
  fb.set(`people/${pid}`, rec).catch(e => failed('Player not saved', e));
  return pid;
}

/* ---------- signing in ---------- */
let meUnsub = null;
async function loadIdentity() {
  cfg = await fb.get('app/config').catch(() => null);
  const dev = me ? await fb.get(`devices/${me.uid}`).catch(() => null) : null;
  myPid = dev?.personId || null;
  myPerson = myPid ? await fb.get(`people/${myPid}`).catch(() => null) : null;
  if (myPid && !meUnsub) meUnsub = fb.watchDoc(`people/${myPid}`, d => { if (d) { const was = isStaff(); myPerson = d; if (!was && isStaff()) startStaffWatch(); safeRender(); } }, () => {});
  startStaffWatch();
}
async function claimLink(tok, eid, force = false) {
  gate = { state: 'joining' }; render();
  try {
    if (!me) me = await fb.signInAnon();
    const link = await fb.get(`links/${tok}`);
    if (!link) throw new Error('This link is no longer valid. Ask the organiser to text you a new one.');
    const dev = await fb.get(`devices/${me.uid}`).catch(() => null);
    if (dev && dev.personId !== link.personId && !force) {
      const cur = await fb.get(`people/${dev.personId}`).catch(() => null);
      gate = { state: 'switch', tok, eid, from: cur?.nick || cur?.fullName || 'someone else', to: link.name || 'another player' }; render(); return;
    }
    if (!dev || dev.personId !== link.personId || dev.token !== tok) await fb.set(`devices/${me.uid}`, { personId: link.personId, token: tok, at: fb.now() });
    meUnsub && meUnsub(); meUnsub = null;
    await loadIdentity();
    if (eid) openTour(eid); else { history.replaceState(null, '', location.pathname); showHome(); }
  } catch (e) { gate = { state: 'error', msg: errText(e) }; render(); }
}
async function ownerSignIn() {
  try {
    me = await fb.signInGoogle();
    cfg = await fb.get('app/config').catch(() => null);
    if (!cfg) { cfg = { ownerUids: [me.uid] }; await fb.set('app/config', cfg); }
    if (cfg.ownerUids.includes(me.uid)) {
      const dev = await fb.get(`devices/${me.uid}`).catch(() => null);
      if (!dev) {
        const pid = fb.newId();
        await fb.set(`people/${pid}`, { fullName: me.name || me.email || 'Owner', nick: firstName(me.name) || 'Owner', phone: '', hcp: 18, role: 'owner', adminOf: [], at: fb.now() });
        await fb.set(`devices/${me.uid}`, { personId: pid, token: 'owner', at: fb.now() });
      }
    }
    meUnsub && meUnsub(); meUnsub = null;
    await loadIdentity();
    if (!myPid) { gate = { state: 'landing', msg: 'This Google account is not the app owner. Players and administrators sign in with their personal link.' }; render(); return; }
    showHome();
  } catch (e) { toast('Sign-in did not complete: ' + errText(e)); }
}
async function showHome() {
  stopWatching(); tourId = null; tour = null; store(':tour', null);
  if (location.hash) history.replaceState(null, '', location.pathname);
  gate = { state: 'home', events: gate.state === 'home' ? gate.events : null }; render();
  try {
    const evs = isAppAdmin() ? await fb.list('events') : myPid ? await fb.listContains('events', 'visibleTo', myPid) : [];
    gate = { state: 'home', events: evs };
  } catch (e) { gate = { state: 'home', events: [], err: errText(e) }; }
  render();
}
async function createTour(demo) {
  const id = fb.newId();
  let base, seedScores = null;
  if (demo) {
    base = clone(SEED.tour); base.title = 'Demo event'; base.isTour = true; base.status = 'active';
    base.days.forEach((d, i) => { d.title = 'Session ' + (i + 1); d.scoring = 'both'; d.mode = 'edit'; });
    // Demo players live in the directory (marked Demo), reused by every demo event.
    const bySeed = Object.fromEntries(Object.entries(people).filter(([, x]) => x.seedId).map(([pid, x]) => [x.seedId, pid]));
    const map = {}; const items = [];
    for (const p of base.players) {
      let pid = bySeed[p.id];
      if (!pid) { pid = fb.newId(); const rec = { fullName: p.name, nick: p.name, phone: '', hcp: p.hcp, role: 'player', adminOf: [], demo: true, seedId: p.id, at: fb.now() }; people[pid] = rec; items.push({ path: `people/${pid}`, data: rec }); }
      map[p.id] = pid;
    }
    try { await fb.batchSet(items); } catch (e) { toast('Could not add demo players: ' + errText(e)); return; }
    base.players.forEach(p => (p.id = map[p.id]));
    base.days.forEach(d => d.groups.forEach(g => { g.slots.a = g.slots.a.map(x => (x ? map[x] || x : x)); g.slots.b = g.slots.b.map(x => (x ? map[x] || x : x)); }));
    seedScores = {}; for (const [dayId, ents] of Object.entries(SEED.scores)) { seedScores[dayId] = {}; for (const [ent, holes] of Object.entries(ents)) seedScores[dayId][map[ent] || ent] = holes; }
  } else base = {
    title: 'New event', isTour: false, status: 'planning', teams: { t1: { name: 'Red', color: '#c8372d' }, t2: { name: 'Blue', color: '#2a5fb0' } }, pointsToWin: 0, visibility: 'live', until: '12:30',
    players: [], courses: clone(SEED.tour.courses), days: [{ id: 'd1', title: 'Session 1', date: new Date().toISOString().slice(0, 10), courseId: SEED.tour.courses[0].id, teeId: SEED.tour.courses[0].tees[0].id, teamsOn: true, scoring: 'stableford', mode: 'edit', hidden: true, briefing: '', groups: [] }],
  };
  base.eventAdmins = []; base.createdBy = myPid;
  const data = eventDoc(base);
  try {
    await fb.set(`events/${id}`, data);
    if (seedScores) {
      const items = [];
      for (const [dayId, ents] of Object.entries(seedScores)) for (const [ent, holes] of Object.entries(ents))
        items.push({ path: `events/${id}/scores/${dayId}_${ent}`, data: { dayId, ent, holes, groupId: data.access[dayId][ent] || '', unitKey: '', by: me.uid, at: fb.now() } });
      await fb.batchSet(items);
    }
    ui.setup = 'tour'; ui.tab = demo ? 'day' : 'setup'; openTour(id);
  } catch (e) { toast('Could not create the event: ' + errText(e)); }
}
async function deleteEvent() {
  const id = tourId; const t = tour;
  try {
    const kids = [...await fb.list(`events/${id}/scores`).then(x => x.map(d => `events/${id}/scores/${d.id}`)), ...await fb.list(`events/${id}/locks`).then(x => x.map(d => `events/${id}/locks/${d.id}`)), ...await fb.list(`events/${id}/sides`).then(x => x.map(d => `events/${id}/sides/${d.id}`))];
    for (const pth of kids) await fb.del(pth);
    await fb.del(`events/${id}`);
    for (const pid of t.eventAdmins || []) if (people[pid]) savePerson(pid, { adminOf: (people[pid].adminOf || []).filter(x => x !== id) });
    ui.confirmDelEv = false; toast(`${t.title} deleted.`); showHome();
  } catch (e) { toast('Not deleted: ' + errText(e)); }
}

function renderEmpty() {
  document.querySelector('.tabs').hidden = !isRealAdmin();
  document.getElementById('view').innerHTML = `<section class="card"><h2>${esc(tour.title)}</h2><div class="pad" style="padding-top:0;display:grid;gap:10px"><span>Nothing has been published yet. The organiser will share the order of play here.</span><div><button class="btn" data-home>My Home</button></div></div></section>`;
  measure(); persist();
}
const evDates = t => { const ds = (t.days || []).map(d => d.date).filter(Boolean).sort(); return ds.length ? (ds[0] === ds[ds.length - 1] ? fmtDate(ds[0]) : `${fmtDate(ds[0])} – ${fmtDate(ds[ds.length - 1])}`) : ''; };
function viewHome() {
  const evs = gate.events;
  const order = { active: 0, planning: 1, complete: 2, archived: 3 };
  const sorted = (evs || []).slice().sort((a, b) => (order[a.data.status] ?? 1) - (order[b.data.status] ?? 1) || String(b.data.days?.[0]?.date || '').localeCompare(String(a.data.days?.[0]?.date || '')));
  const shown = sorted.filter(e => e.data.status !== 'archived' || ui.showArchived);
  const nArch = sorted.length - sorted.filter(e => e.data.status !== 'archived').length;
  const item = e => { const t = e.data; const mine = (t.eventAdmins || []).includes(myPid); const inIt = (t.players || []).some(p => p.id === myPid);
    return `<button class="evitem" data-opentour="${e.id}"><span class="evt"><b>${esc(t.title)}</b>${isStaff() || t.status === 'complete' ? `<span class="stchip st-${t.status}">${statusName(t.status)}</span>` : ''}</span>
      <span class="small muted">${evDates(t)}${t.isTour ? ' · Tour' : ''} · ${(t.players || []).length} players${mine ? ' · <b>You are an event administrator</b>' : isAppAdmin() && !inIt ? '' : ''}</span></button>`; };
  const list = evs === null ? '<span class="muted">Loading your events…</span>' : shown.length ? shown.map(item).join('') : `<span class="muted">${isAppAdmin() ? 'No events yet. Create one below.' : 'You are not in any events that are open yet. Your organiser will let you know.'}</span>`;
  return `<section class="card"><div class="ghead"><div class="eyebrow">${esc(roleName() === 'Player' && isStaff() ? 'Event administrator' : roleName())}</div><h2>My Home</h2></div>
    <div class="pad" style="padding-top:0;display:grid;gap:10px">${gate.err ? `<div class="banner">${esc(gate.err)}</div>` : ''}
      <span class="small muted">${isAppAdmin() ? 'All events.' : 'The events you are in.'} Tap one to open it.</span>
      <div class="evlist">${list}</div>
      ${nArch ? `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="showarch" ${ui.showArchived ? 'checked' : ''}> Show ${nArch} archived</label>` : ''}
      ${isAppAdmin() ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-newtour="blank">Create a new event</button><button class="btn" data-newtour="demo">Create a demo event</button></div>
        <span class="small muted">New events start in Planning, so only administrators can see them until you make them Active. The demo event is an Active two-team Tour with example players, groups and scores.</span>` : ''}
      ${isStaff() ? `<div><button class="btn" data-people>Player directory</button></div>` : ''}
    </div></section>
    <section class="card"><div class="pad small muted" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between"><span>Signed in as <b>${esc(myName())}</b>${roleName() !== 'Player' ? ` (${esc(roleName())})` : ''}. App version ${esc(window.APP_VERSION || 'dev')}.</span>${me && !me.anonymous ? '<button class="btn sm" data-signout>Sign out</button>' : ''}</div></section>`;
}
function viewPeople() {
  const q = (ui.dirQ || '').toLowerCase();
  const all = Object.entries(people).map(([id, x]) => ({ id, ...x, name: x.fullName })).sort(byName);
  const nDemo = all.filter(x => x.demo).length;
  const list = all.filter(x => !x.demo || ui.showDemo);
  const roleTxt = r => (r === 'owner' ? 'Owner' : r === 'appAdmin' ? 'App admin' : '');
  const row = x => {
    const open = ui.pedit === x.id;
    const href = smsHref(x.id);
    const raw = ui.phoneDraft?.[x.id] ?? showPhone(x.phone); const bad = raw && !normPhone(raw);
    return `<div class="prow" ${q && !(x.fullName + ' ' + (x.nick || '')).toLowerCase().includes(q) ? 'hidden' : ''}>
      <button class="phd" data-pedit="${x.id}" aria-expanded="${open}"><span><b>${esc(x.fullName)}</b>${x.nick ? ` <span class="muted">(${esc(x.nick)})</span>` : ''}${x.demo ? ' <span class="hid">Demo</span>' : ''}${roleTxt(x.role) ? ` <span class="stchip st-active">${roleTxt(x.role)}</span>` : ''}${(x.adminOf || []).length ? ' <span class="stchip st-planning">Event admin</span>' : ''}</span><span class="small">HC ${x.hcp ?? '–'} ${linkStatus(x.id)}</span></button>
      ${open ? `<div class="form pform">
        <div class="two"><div class="frow"><label>Full name</label><input type="text" value="${esc(x.fullName)}" data-pp="fullName" data-pid="${x.id}"></div><div class="frow"><label>Nickname</label><input type="text" value="${esc(x.nick || '')}" data-pp="nick" data-pid="${x.id}"></div></div>
        <div class="two"><div class="frow"><label>Mobile</label><input type="tel" inputmode="tel" value="${esc(raw)}" data-pp="phone" data-pid="${x.id}" class="${bad ? 'bad' : ''}"></div><div class="frow"><label>Usual handicap</label><input type="text" inputmode="numeric" value="${x.hcp ?? ''}" data-pp="hcp" data-pid="${x.id}" style="max-width:90px"></div></div>
        ${bad ? '<div class="small err-t">Check this number: an Australian mobile looks like 0412 345 678.</div>' : ''}
        <span class="small muted">The nickname and handicap are the starting values when this person is added to an event. Each event can then change its own.</span>
        ${isAppAdmin() && x.role !== 'owner' ? `<div class="frow"><span class="lab">Role</span><div class="seg" role="group" aria-label="Role">${[['player', 'Player'], ['appAdmin', 'App administrator']].map(([k, l]) => `<button aria-pressed="${(x.role || 'player') === k}" data-role="${k}" data-pid="${x.id}">${l}</button>`).join('')}</div>
          <span class="small muted">App administrators can create and manage every event and the player directory. Event administrators are chosen inside each event.</span></div>` : ''}
        <div class="frow"><span class="lab">Personal link</span><div style="display:flex;gap:8px;flex-wrap:wrap">${href ? `<a class="btn sm primary" href="${href}" data-sent="${x.id}">Text link</a>` : '<button class="btn sm" disabled>Text link</button>'}<button class="btn sm" data-copy="${x.id}" ${x.token ? '' : 'disabled'}>Copy</button>${x.token && isAppAdmin() ? `<button class="btn sm" data-relink="${x.id}">Make a new link</button>` : ''}</div>
          <span class="small muted">Make a new link only if the old one was shared by mistake: phones already signed in keep working, but the old link stops working.</span></div>
        ${isAppAdmin() && x.role !== 'owner' && x.id !== myPid ? (ui.confirmDelPerson === x.id ? `<div class="confirm"><span>Remove <b>${esc(x.fullName)}</b> from the directory? Events they are already in keep their name and scores, but their personal link stops working.</span><div style="display:flex;gap:8px"><button class="btn danger" data-delpersonyes="${x.id}">Remove</button><button class="btn" data-delpersonno>Cancel</button></div></div>` : `<div><button class="btn sm" data-delperson="${x.id}">Remove from directory…</button></div>`) : ''}
      </div>` : ''}</div>`;
  };
  return `<section class="card"><div class="ghead"><div class="eyebrow">All events</div><h2>Player directory</h2></div>
    <div class="pad" style="padding-top:0;display:grid;gap:10px"><span class="small muted">Everyone who has been added to an event. Anyone here can be added to any event. Mobile numbers are only seen by administrators.</span>
      <input type="search" id="dirq" placeholder="Search ${list.length} people" value="${esc(ui.dirQ || '')}">
      ${nDemo ? `<label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="showdemo" ${ui.showDemo ? 'checked' : ''}> Show ${nDemo} demo players</label>` : ''}</div>
    <div class="plist">${list.map(row).join('') || '<div class="pad muted">Nobody yet.</div>'}</div>
    <div class="form addbox"><span class="lab" style="font-weight:700">Add a person</span>
      <div class="newp2"><input type="text" id="dfull" placeholder="Full name" autocomplete="off"><input type="text" id="dnick" placeholder="Nickname (optional)" autocomplete="off"><input type="tel" id="dphone" placeholder="Mobile (optional)" inputmode="tel"><input type="text" id="dhcp" placeholder="HC" inputmode="numeric" style="width:64px"><button class="btn" id="addperson">Add</button></div></div>
    <div class="pad"><button class="btn" data-home>Back to My Home</button></div></section>`;
}
function viewGate() {
  const card = (title, body) => `<section class="card"><h2>${title}</h2><div class="pad" style="padding-top:0;display:grid;gap:12px">${body}</div></section>`;
  if (gate.state === 'loading') return card('Loading…', '<span class="muted">Getting the latest scores.</span>');
  if (gate.state === 'joining') return card('Signing you in…', '<span class="muted">Linking this phone to you.</span>');
  if (gate.state === 'home') return viewHome();
  if (gate.state === 'people') return viewPeople();
  if (gate.state === 'switch') return card('Switch person on this phone?', `<span>This phone is signed in as <b>${esc(gate.from)}</b>. The link you opened is <b>${esc(gate.to)}</b>'s personal link.</span>
    <span class="small muted">Only switch if this is your phone and the link was meant for you.</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-switchyes>Switch to ${esc(gate.to)}</button><button class="btn" data-switchno>Stay as ${esc(gate.from)}</button></div>`);
  if (gate.state === 'error') return card('Something is not right', `<span>${esc(gate.msg)}</span><div style="display:flex;gap:8px;flex-wrap:wrap">${myPid ? '<button class="btn" data-home>My Home</button>' : ''}</div>`);
  return card('Golf Tour Scorer', `${gate.msg ? `<div class="banner" style="margin:0">${esc(gate.msg)}</div>` : ''}
    <span>Open the personal link you were texted. It signs you in on this phone, and after that every event link works, including links posted in WhatsApp.</span>
    <span class="small muted">Lost your link? Ask the organiser to text it again.</span>
    <div><button class="btn sm" data-gsignin>Owner sign-in with Google</button></div>`);
}
function syncPill() {
  if (!tourId || !tour) return '';
  if (!navigator.onLine || sync.cached) return '<span class="pill-sync off">Offline · saved on this phone</span>';
  if (sync.pending) return '<span class="pill-sync">Syncing…</span>';
  return '';
}
window.addEventListener('online', () => safeRender()); window.addEventListener('offline', () => safeRender());

function route() {
  const h = hashParams();
  if (h.join) { claimLink(h.join, h.e); return; }
  if (!me || (!myPid && !isOwner())) { gate = { state: 'landing', msg: h.e ? 'To open this event, first open the personal link you were texted on this phone. Then tap the event link again.' : null }; render(); return; }
  const eid = h.e || load(':tour', null);
  if (eid) openTour(eid); else showHome();
}
function boot() {
  let started = false;
  fb.onAuth(async u => {
    me = u; if (started) return; started = true;
    if (me) await loadIdentity();
    route();
  });
  window.addEventListener('hashchange', () => { const h = hashParams(); if (h.join || (h.e && h.e !== tourId)) route(); });
}

/* ---------- shell ---------- */
const ICONS = {
  day: '<svg viewBox="0 0 24 24"><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></svg>',
  scores: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17M9.5 3.5v17"/></svg>',
  leaders: '<svg viewBox="0 0 24 24"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
  cup: '<svg viewBox="0 0 24 24"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/></svg>',
  setup: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
};
function measure() { document.documentElement.style.setProperty('--toph', document.getElementById('top').offsetHeight + 'px'); }
function render() {
  const tb0 = document.getElementById('tabs');
  const homeBtn = `<button class="homebtn" data-home aria-label="My Home"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7M5.5 9.5V20h13V9.5"/></svg><span>My Home</span></button>`;
  document.querySelector('.top h1').innerHTML = (gate.state === 'ready' || gate.state === 'people') && myPid ? homeBtn : 'Golf Tour Scorer';
  if (gate.state !== 'ready' || !tour) {
    document.getElementById('who').innerHTML = myPerson ? `<span class="evname">${esc(myPerson.nick || myPerson.fullName)}</span><span class="role">${esc(roleName() === 'Player' && isStaff() ? 'Event administrator' : roleName())}</span>` : '';
    document.getElementById('view').innerHTML = viewGate(); tb0.innerHTML = ''; document.querySelector('.tabs').hidden = true; measure(); return;
  }
  document.querySelector('.tabs').hidden = false;
  PIDX = P();
  if (!isRealAdmin()) ui.as = myPid || '__none';
  if (!DAY()) { renderEmpty(); return; }
  ui.day = DAY().id;
  if (ui.tab === 'setup' && !isAdmin()) ui.tab = 'day';
  course = teeOf(DAY());
  applyTeams();
  document.getElementById('who').innerHTML = `<span class="evname">${esc(tour.title)}</span><span class="role">${esc(isAdmin() ? roleName() : PIDX[ui.as]?.name || myPerson?.nick || 'Viewer')}</span>${syncPill()}`;
  const v = document.getElementById('view');
  const previewing = isRealAdmin() && ui.as !== 'admin';
  v.innerHTML = (previewing ? `<div class="banner prev">Previewing as <b>${esc(PIDX[ui.as]?.name || '?')}</b>: this is what they see. <button class="btn sm" data-stoppreview>Stop preview</button></div>` : '') + (syncErr ? `<div class="banner err"><b>Something did not save.</b> ${esc(syncErr)} <button class="btn sm" data-dismiss>OK</button></div>` : '') + (ui.tab === 'day' ? viewDay() : ui.tab === 'scores' ? viewScores() : ui.tab === 'leaders' ? viewLeaders() : ui.tab === 'cup' ? viewCup() : viewSetup());
  if (ui.tab === 'cup' && !isTour()) ui.tab = 'leaders';
  const tabs = [['day', 'Order of Play'], ['scores', 'Scores'], ['leaders', 'Leaders'], ...(isTour() ? [['cup', 'Cup']] : []), ...(isAdmin() ? [['setup', 'Setup']] : [])];
  const tb = document.getElementById('tabs'); tb.style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;
  tb.innerHTML = tabs.map(([k, l]) => `<button data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${ICONS[k]}${l}</button>`).join('');
  measure(); persist(); syncOut();
  if (isRealAdmin() && ui.tab === 'setup' && ui.setup === 'players' && ui.ptab === 'invites') ensureLinks(tour.players.map(p => p.id));
}
function findGroup(did, gid) { return dayById(did).groups.find(g => g.id === gid); }
window.addEventListener('resize', measure);
document.addEventListener('click', e => {
  const sentA = e.target.closest('a[data-sent]');
  if (sentA) { const pid = sentA.dataset.sent; savePerson(pid, { sentAt: fb.now() });
    if ('q' in sentA.dataset && ui.queue) setTimeout(() => { ui.queue.i++; safeRender(); }, 600);
    return; }
  const t = e.target.closest('button, tr.hrow, tr.tap, [data-cancel]'); if (!t) return;
  const d = t.dataset;
  if (d.tab) { ui.tab = d.tab; render(); window.scrollTo(0, 0); }
  else if (d.day) { ui.day = d.day; ui.group = (myGroup() || DAY().groups[0] || {}).id; render(); }
  else if (d.go) { const g = DAY().groups.find(x => x.id === d.go); if (!canSeeGroup(g)) { toast('Other groups are hidden until results are published.'); return; } ui.group = d.go; ui.tab = 'scores'; render(); window.scrollTo(0, 0); }
  else if (d.group) { ui.group = d.group; render(); }
  else if (d.unit) { ui.unit[DAY().id + ':' + ui.group] = +d.unit; render(); }
  else if (d.view) { ui.view = d.view; render(); }
  else if (d.lb) { ui.lb = d.lb; render(); }
  else if (d.scope) { ui.lbScope = d.scope; render(); }
  else if (d.setup) { ui.setup = d.setup; ui.courseErr = null; render(); }
  else if (d.open) { ui.open[d.open] = !(ui.open[d.open] ?? (d.open === 'day:' + DAY().id)); render(); }
  else if (d.vis) { tour.visibility = d.vis; render(); }
  else if (d.swatch) { tour.teams[d.swatch].color = d.c; render(); }
  else if (d.unlock) { delete locks[d.unlock]; render(); toast('Unlocked. Players in the match can now edit.'); }
  else if (d.submit) { if (!document.getElementById('ack')?.checked) return; locks[d.submit] = { at: Date.now(), by: me.uid }; render(); toast('Scores submitted and locked.'); }
  else if (d.relink) { const pid = d.relink; const old = people[pid]?.token; const tk = token();
    fb.set(`links/${tk}`, { personId: pid, name: people[pid].nick || firstName(people[pid].fullName), at: fb.now() }).then(() => { savePerson(pid, { token: tk, sentAt: null }); return old && fb.del(`links/${old}`); }).catch(err => toast('Link not made: ' + errText(err)));
    toast('New link made. Text it to them: the old link no longer works.'); }
  else if (d.copy) { const url = personalUrl(d.copy, tourId); copyText(url, 'Personal link copied.'); }
  else if ('copyevent' in d) { copyText(eventUrl(), 'Event link copied. Paste it into your WhatsApp group.'); }
  else if ('shareevent' in d) { navigator.share({ title: tour.title, text: `${tour.title}: order of play, scores and leaderboards. Tap to open:`, url: eventUrl() }).catch(() => {}); }
  else if (d.selall) { const list = tour.players; ui.sel = {}; if (d.selall === 'all') list.forEach(p => (ui.sel[p.id] = true)); if (d.selall === 'out') list.filter(p => !devCount[p.id]).forEach(p => (ui.sel[p.id] = true)); render(); }
  else if ('textsel' in d) { const ids = tour.players.filter(p => ui.sel?.[p.id]).sort(byName).map(p => p.id);
    const ok = ids.filter(smsHref); const no = ids.filter(id => !smsHref(id));
    if (no.length) toast(`No mobile number for ${no.map(id => PIDX[id]?.name).join(', ')}. Use Copy for them.`);
    if (ok.length) { ui.queue = { ids: ok, i: 0 }; render(); window.scrollTo(0, 0); } }
  else if ('qskip' in d) { ui.queue.i++; render(); }
  else if ('qstop' in d) { ui.queue = null; ui.sel = {}; render(); }
  else if (t.id === 'addp') { const full = document.getElementById('nfull').value.trim(); if (!full) { toast('Enter their full name.'); return; }
    const nick = document.getElementById('nnick').value.trim(); const ph = document.getElementById('nphone').value; const hc = parseInt(document.getElementById('nhcp').value, 10);
    if (ph && !normPhone(ph)) { toast('Check the mobile number: it should look like 0412 345 678.'); return; }
    const pid = newPerson({ fullName: full, nick, phone: normPhone(ph) || '', hcp: isNaN(hc) ? 18 : hc });
    tour.players.push({ id: pid, name: people[pid].nick, team: null, hcp: people[pid].hcp }); render(); toast(`${people[pid].nick} added to the event and the player directory.`); }
  else if (t.id === 'addpicked') { const ids = Object.keys(ui.picks || {}).filter(k => ui.picks[k] && !PIDX[k]); ids.forEach(id => { const x = people[id]; if (x) tour.players.push({ id, name: x.nick || firstName(x.fullName), team: null, hcp: x.hcp ?? 18 }); });
    ui.picks = {}; render(); toast(`${ids.length} added.${isTour() ? ' Set their teams and' : ' Check their'} handicaps for this event.`); }
  else if (t.id === 'addperson') { const full = document.getElementById('dfull').value.trim(); if (!full) { toast('Enter their full name.'); return; }
    const nick = document.getElementById('dnick').value.trim(); const ph = document.getElementById('dphone').value; const hc = parseInt(document.getElementById('dhcp').value, 10);
    if (ph && !normPhone(ph)) { toast('Check the mobile number: it should look like 0412 345 678.'); return; }
    const pid = newPerson({ fullName: full, nick, phone: normPhone(ph) || '', hcp: isNaN(hc) ? 18 : hc }); ensureLinks([pid]); render(); toast(`${full} added to the directory.`); }
  else if (d.pedit) { ui.pedit = ui.pedit === d.pedit ? null : d.pedit; if (ui.pedit) ensureLinks([ui.pedit]); render(); }
  else if (d.role && d.pid) { savePerson(d.pid, { role: d.role }); render(); }
  else if (d.delperson) { ui.confirmDelPerson = d.delperson; render(); }
  else if ('delpersonno' in d) { ui.confirmDelPerson = null; render(); }
  else if (d.delpersonyes) { const pid = d.delpersonyes; const x = people[pid]; ui.confirmDelPerson = null; ui.pedit = null;
    fb.del(`people/${pid}`).then(() => { if (x?.token) fb.del(`links/${x.token}`).catch(() => {}); delete people[pid]; render(); toast(`${x.fullName} removed from the directory.`); }).catch(err => toast('Not removed: ' + errText(err))); }
  else if (d.status) { tour.status = d.status; render(); toast(`Event is now ${statusName(d.status)}. ${STATUS_NOTE[d.status]}`); }
  else if ('delev' in d) { ui.confirmDelEv = true; render(); }
  else if ('delevno' in d) { ui.confirmDelEv = false; render(); }
  else if ('delevyes' in d) { deleteEvent(); }
  else if ('people' in d) { stopWatching(); tourId = null; tour = null; gate = { state: 'people' }; render(); window.scrollTo(0, 0); }
  else if ('home' in d) { ui.queue = null; showHome(); window.scrollTo(0, 0); }
  else if ('switchyes' in d) { claimLink(gate.tok, gate.eid, true); }
  else if ('switchno' in d) { route2Home(); }
  else if (d.ptab) { ui.ptab = d.ptab; render(); }
  else if (d.stoppreview !== undefined) { ui.as = 'admin'; render(); }
  else if (t.id === 'addc') {
    const cn = document.getElementById('cn').value.trim(), tn = document.getElementById('ctn').value.trim(), col = document.getElementById('ctc').value, txt = document.getElementById('cpaste').value;
    try {
      if (!cn || !tn) throw new Error('Enter the course name and the tee.');
      const holes = parseHoles(txt);
      let c = tour.courses.find(x => x.name.toLowerCase() === cn.toLowerCase());
      if (!c) { c = { id: uid('c'), name: cn, tees: [] }; tour.courses.push(c); }
      if (c.tees.find(x => x.name.toLowerCase() === tn.toLowerCase())) throw new Error(`${cn} already has a ${tn} tee.`);
      c.tees.push({ id: uid('t'), name: tn, colour: col, holes }); ui.courseErr = null; render();
      toast(`${cn} · ${tn} added: par ${holes.reduce((a, h) => a + h.par, 0)}.`);
    } catch (err) { ui.courseErr = err.message; render(); document.getElementById('cpaste').value = txt; document.getElementById('cn').value = cn; document.getElementById('ctn').value = tn; }
  }
  else if (d.crsedit) { ui.crsEdit = d.crsedit; ui.crsErr = null; render(); }
  else if ('crscancel' in d) { ui.crsEdit = null; ui.crsErr = null; render(); }
  else if (d.crssave) { const [cid, tid] = d.crssave.split('|'); const c = tour.courses.find(x => x.id === cid); const te = c.tees.find(x => x.id === tid);
    const val = (k, i) => { const el = document.querySelector(`[data-ce="${k}"][data-i="${i}"]`); const v = el ? el.value.trim() : ''; return v === '' ? undefined : Number(v); };
    try {
      const name = document.getElementById('ce-name').value.trim(), tee = document.getElementById('ce-tee').value.trim();
      if (!name || !tee) throw new Error('Enter the course name and the tee.');
      if (c.tees.some(x => x.id !== tid && x.name.toLowerCase() === tee.toLowerCase())) throw new Error(`${name} already has a ${tee} tee.`);
      const holes = holesFromRows(Array.from({ length: 18 }, (_, i) => ['par', 'i1', 'i2', 'i3', 'mi'].map(k => val(k, i))));
      c.name = name; te.name = tee; te.colour = document.getElementById('ce-col').value; te.holes = holes;
      ui.crsEdit = null; ui.crsErr = null; render(); toast(`${name} · ${tee} saved: par ${holes.reduce((a, h) => a + h.par, 0)}.`);
    } catch (err) { const box = document.querySelector('.crs-err'); if (box) box.innerHTML = `<div class="banner" style="margin:0">${esc(err.message)}</div>`; }
  }
  else if (t.id === 'addday') { const last = tour.days[tour.days.length - 1]; const nd = new Date(last.date + 'T00:00'); nd.setDate(nd.getDate() + 1);
    const day = { id: uid('d'), title: 'Session ' + (tour.days.length + 1), scoring: last.scoring || 'stableford', mode: 'edit', date: nd.toISOString().slice(0, 10), courseId: last.courseId, teeId: last.teeId, teamsOn: true, hidden: true, briefing: '', groups: [] };
    tour.days.push(day); ui.open['day:' + day.id] = true; render(); toast(`${day.title} added. It stays hidden from players until you show it.`); }
  else if (d.addgroup) { const day = dayById(d.addgroup); const last = hhmm(day.groups[day.groups.length - 1]?.tee);
    let tee = ''; if (last) { const [h, m] = last.split(':').map(Number); const t = h * 60 + m + 9; tee = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
    day.groups.push({ id: uid('g'), tee, format: isTour() && day.teamsOn !== false ? 'fourball' : 'individual', method: 'front', value: 1, slots: { a: [], b: [] } }); render(); }
  else if (d.delgroup) { const day = dayById(d.did); day.groups = day.groups.filter(g => g.id !== d.delgroup); render(); }
  else if (d.delp) { ui.confirmDel = ui.confirmDel === d.delp ? null : d.delp; render(); }
  else if ('delno' in d) { ui.confirmDel = null; render(); }
  else if (d.delyes) { const pid = d.delyes; const nm = PIDX[pid]?.name;
    tour.players = tour.players.filter(p => p.id !== pid);
    tour.days.forEach(day => day.groups.forEach(g => { g.slots.a = g.slots.a.map(x => (x === pid ? null : x)); g.slots.b = g.slots.b.map(x => (x === pid ? null : x)); }));
    ui.confirmDel = null; render(); toast(`${nm} removed.`); }
  else if (d.tsort) { ui.teamSort = d.tsort; render(); }
  else if (d.grade) { ui.grade = d.grade; render(); }
  else if (d.gmove) { const day = dayById(d.did); const i = day.groups.findIndex(g => g.id === d.gid); const j = i + +d.gmove;
    if (j < 0 || j >= day.groups.length) return;
    // Groups swap places; tee times stay with the slot in the order of play.
    const ti = day.groups[i].tee, tj = day.groups[j].tee;
    [day.groups[i], day.groups[j]] = [day.groups[j], day.groups[i]]; day.groups[i].tee = ti; day.groups[j].tee = tj;
    render(); toast(`Group moved to ${j + 1}${tj ? ` (${teeTxt(tj)})` : ''}.`); }
  else if ('sideedit' in d) { const g = DAY().groups.find(x => x.id === ui.group); const key = DAY().id + ':' + g.id; const sm = sides[key];
    const ps = groupPlayers(g); const half = Math.ceil(ps.length / 2);
    ui.sideEdit = { key, type: sm?.type || (ps.length === 4 ? 'fourball' : ps.length === 3 ? 'cutthroat' : 'singles'), method: sm?.method || 'front', a: sm?.a ? [...sm.a] : ps.slice(0, half), b: sm?.b ? [...sm.b] : ps.slice(half) }; render(); }
  else if ('smcancel' in d) { ui.sideEdit = null; render(); }
  else if (d.smtype) { ui.sideEdit.type = d.smtype; render(); }
  else if (d.smmethod) { ui.sideEdit.method = d.smmethod; render(); }
  else if (d.smside) { const e2 = ui.sideEdit; e2.a = e2.a.filter(x => x !== d.pid); e2.b = e2.b.filter(x => x !== d.pid); e2[d.smside].push(d.pid); render(); }
  else if ('smsave' in d) { const e2 = ui.sideEdit; const [dayId, groupId] = e2.key.split(':'); const g = findGroup(dayId, groupId);
    const doc = e2.type === 'cutthroat' ? { type: 'cutthroat', players: groupPlayers(g) } : { type: e2.type, method: e2.method, a: e2.a, b: e2.b };
    sides[e2.key] = doc; ui.sideEdit = null; ui.unit[e2.key] = 1;
    fb.set(`events/${tourId}/sides/${dayId}_${groupId}`, { ...doc, dayId, groupId, by: me.uid, at: fb.now() }).catch(err => failed('Side match not saved', err));
    render(); toast('Side match set up.'); }
  else if ('sidedel' in d) { const key = DAY().id + ':' + ui.group; delete sides[key]; ui.unit[key] = 0;
    fb.del(`events/${tourId}/sides/${DAY().id}_${ui.group}`).catch(err => failed('Side match not removed', err)); render(); }
  else if ('swapyes' in d) { const w = ui.swap; ui.swap = null; if (w) { findGroup(w.did, w.gid).slots[w.side][w.k] = w.nv; } render(); }
  else if ('swapno' in d) { ui.swap = null; render(); }
  else if (d.mode && d.did) { dayById(d.did).mode = d.mode; render(); toast(d.mode === 'view' ? 'Session is now view only for players.' : 'Players can enter scores again.'); }
  else if (d.scoring && d.did) { dayById(d.did).scoring = d.scoring; render(); }
  else if ('dismiss' in d) { syncErr = null; render(); }
  else if ('gsignin' in d) { ownerSignIn(); }
  else if ('signout' in d) { stopAll(); tourId = null; tour = null; store(':tour', null); fb.signOut().then(() => { me = null; myPid = null; myPerson = null; people = {}; history.replaceState(null, '', location.pathname); gate = { state: 'landing' }; render(); }); }
  else if (d.opentour) { ui.tab = 'day'; ui.as = 'admin'; openTour(d.opentour); window.scrollTo(0, 0); }
  else if (d.newtour) { createTour(d.newtour === 'demo'); }
  else if (t.classList.contains('hrow')) openEntry(+d.hole);
  else if ('cancel' in d) { ui.entry = null; renderSheet(); }
  else if (d.step) { const cur = ui.entry.draft[d.id]; ui.entry.draft[d.id] = Math.min(15, Math.max(1, (typeof cur === 'number' ? cur : course.holes[ui.entry.i].par) + +d.step)); renderSheet(); }
  else if (d.pu) { const cur = ui.entry.draft[d.pu]; ui.entry.draft[d.pu] = cur === 'P' ? course.holes[ui.entry.i].par : 'P'; renderSheet(); }
  else if ('clear' in d) { const s = daySc(DAY().id); for (const id of Object.keys(ui.entry.draft)) (s[id] = s[id] || Array(18).fill(null))[ui.entry.i] = null; ui.entry = null; renderSheet(); render(); }
  else if ('save' in d) { const s = daySc(DAY().id); for (const [id, v] of Object.entries(ui.entry.draft)) (s[id] = s[id] || Array(18).fill(null))[ui.entry.i] = v; ui.entry = null; renderSheet(); render(); }
});
document.addEventListener('change', e => {
  const t = e.target; const d = t.dataset;
  if (t.id === 'as') { ui.as = t.value; const g = myGroup(); if (g) ui.group = g.id; ui.unit = {}; render(); }
  else if (t.id === 'istour') { tour.isTour = t.checked; render(); }
  else if (t.id === 'until') { tour.until = t.value || '12:30'; render(); }
  else if (t.id === 'cbt') { ui.cb = t.checked; render(); }
  else if (t.id === 'ack') { const b = document.querySelector('[data-submit]'); if (b) b.disabled = !t.checked; }
  else if (d.teamname) { tour.teams[d.teamname].name = t.value.trim() || (d.teamname === 't1' ? 'Team 1' : 'Team 2'); render(); }
  else if (d.tf) { if (d.tf === 'pointsToWin') { const n = parseFloat(t.value); if (!isNaN(n)) tour.pointsToWin = n; } else if (d.tf === 'gradeCut') { const n = parseInt(t.value, 10); if (!isNaN(n)) tour.gradeCut = n; } else tour[d.tf] = t.value; render(); }
  else if (t.name === 'evstatus') { tour.status = t.value; render(); toast(`Event is now ${statusName(t.value)}.`); }
  else if (d.phone) { setPhone(d.phone, t.value); }
  else if (d.pp) { const pid = d.pid;
    if (d.pp === 'phone') setPhone(pid, t.value);
    else if (d.pp === 'hcp') { const n = parseInt(t.value, 10); if (!isNaN(n)) savePerson(pid, { hcp: n }); render(); }
    else { const v = t.value.trim(); if (v || d.pp === 'nick') savePerson(pid, { [d.pp]: v }); render(); } }
  else if (d.sel) { ui.sel = ui.sel || {}; ui.sel[d.sel] = t.checked; render(); }
  else if (d.evadmin) { toggleEventAdmin(d.evadmin, t.checked); }
  else if (t.id === 'addadmin') { if (t.value) toggleEventAdmin(t.value, true); }
  else if (t.id === 'showdemo') { ui.showDemo = t.checked; render(); }
  else if (t.id === 'showarch') { ui.showArchived = t.checked; render(); }
  else if (d.pick) { ui.picks = ui.picks || {}; ui.picks[d.pick] = t.checked; render(); }
  else if (d.pf) { const p = tour.players.find(x => x.id === d.pid); if (d.pf === 'hcp') { const n = parseInt(t.value, 10); if (!isNaN(n)) p.hcp = n; } else if (d.pf === 'team') p.team = t.value || null; else p.name = t.value.trim() || p.name; render(); }
  else if (d.df) { const day = dayById(d.did);
    if (d.df === 'course') { const [c, te] = t.value.split('|'); day.courseId = c || null; day.teeId = te || null; }
    else if (d.df === 'teamsOn') day.teamsOn = t.checked;
    else if (d.df === 'multiplier') day.multiplier = t.checked;
    else if (d.df === 'shown') day.hidden = !t.checked; else day[d.df] = t.value; render(); }
  else if (d.gf) { const g = findGroup(d.did, d.gid);
    if (d.gf === 'value') g.value = parseFloat(t.value);
    else if (d.gf === 'format') { g.format = t.value; const f = FORMATS[g.format];
      if (!f.b) { g.slots.a = [...g.slots.a, ...g.slots.b].filter(Boolean); g.slots.b = []; }   // one list of players: keep everyone from both sides
      g.slots.a = g.slots.a.slice(0, f.a); g.slots.b = g.slots.b.slice(0, f.b); if (g.format === 'twoVone') g.value = 0.5; if (g.format.startsWith('ambrose') && !g.ambIds) g.ambIds = g.format === 'ambroseMatch' ? [g.id + '-a', g.id + '-b'] : [g.id + '-t']; }
    else if (d.gf === 'tee') g.tee = hhmm(t.value);
    else g[d.gf] = t.value; render(); }
  else if (d.slot) { const g = findGroup(d.did, d.gid); const side = d.slot[0], k = +d.slot.slice(1); const old = g.slots[side][k]; const nv = t.value || null;
    const held = old && old !== nv && !g.format.startsWith('ambrose') ? scFor(d.did, old).filter(v => v !== null).length : 0;
    if (held) { ui.swap = { did: d.did, gid: d.gid, side, k, old, nv, held }; render(); return; }
    g.slots[side][k] = nv; render(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'bookq') { ui.bookQ = e.target.value; const q = ui.bookQ.toLowerCase();
    document.querySelectorAll('.book:not(.adm) .bk').forEach(l => (l.hidden = q && !l.textContent.toLowerCase().includes(q))); }
  if (e.target.id === 'dirq') { ui.dirQ = e.target.value; const q = ui.dirQ.toLowerCase();
    document.querySelectorAll('.plist .prow').forEach(l => (l.hidden = q && !l.querySelector('.phd b').textContent.concat(' ', l.querySelector('.phd').textContent).toLowerCase().includes(q))); }
});
function copyText(txt, msg) { try { navigator.clipboard.writeText(txt).then(() => toast(msg), () => toast('Select the link and copy it.')); } catch (err) { toast('Select the link and copy it.'); } }
function setPhone(pid, v) {
  const n = normPhone(v); ui.phoneDraft = ui.phoneDraft || {};
  if (!String(v).trim()) { delete ui.phoneDraft[pid]; savePerson(pid, { phone: '' }); }
  else if (n) { delete ui.phoneDraft[pid]; savePerson(pid, { phone: n }); }
  else ui.phoneDraft[pid] = v;
  render();
}
function toggleEventAdmin(pid, on) {
  if (!isAppAdmin()) return;
  const cur = tour.eventAdmins || [];
  tour.eventAdmins = on ? [...new Set([...cur, pid])] : cur.filter(x => x !== pid);
  const of = people[pid]?.adminOf || [];
  savePerson(pid, { adminOf: on ? [...new Set([...of, tourId])] : of.filter(x => x !== tourId) });
  render(); toast(on ? `${PIDX[pid]?.name || people[pid]?.fullName} is now an event administrator.` : 'Event administrator removed.');
}
function route2Home() { if (myPid) showHome(); else { gate = { state: 'landing' }; render(); } }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.entry) { ui.entry = null; renderSheet(); }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.hrow, tr.tap')) { e.preventDefault(); e.target.click(); }
});
boot();
