// Test stand-in for Firebase (used only by `node build.mjs test`). Data lives in localStorage so two
// pages open side by side behave like two phones syncing; sign-in lives in sessionStorage (per page).
// The permission checks below follow firestore.rules, so tests catch permission mistakes.
const KEY = 'mockfs';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
const write = s => localStorage.setItem(KEY, JSON.stringify(s));
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn());
window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
let user = JSON.parse(sessionStorage.getItem('mockuser') || 'null');
const authCbs = new Set();
const setUser = u => { user = u; sessionStorage.setItem('mockuser', JSON.stringify(u)); authCbs.forEach(cb => cb(u)); return u; };
const children = (s, path) => { const n = path.split('/').length; return Object.keys(s).filter(k => k.startsWith(path + '/') && k.split('/').length === n + 1).map(k => ({ id: k.split('/').pop(), data: s[k] })); };

function who(s) {
  const dev = user ? s['devices/' + user.uid] : null;
  const pid = dev ? dev.personId : null;
  const person = pid ? s['people/' + pid] : null;
  const gOwner = !!(user && s['app/config'] && s['app/config'].ownerUids.includes(user.uid));
  const owner = gOwner || person?.role === 'owner';
  const appAdmin = owner || person?.role === 'appAdmin';
  const staff = appAdmin || (person?.adminOf || []).length > 0;
  return { pid, gOwner, owner, appAdmin, staff };
}
const ACTIVE = ['active', 'complete'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const visibleOk = d => (ACTIVE.includes(d.status) ? same(d.visibleTo, d.members) : same(d.visibleTo, d.eventAdmins));

function canRead(path, data) {
  const s = read(); const p = path.split('/'); const w = who(s);
  if (!user) return false;
  if (path === 'app/config') return true;
  if (p[0] === 'people') return w.staff || w.pid === p[1];
  if (p[0] === 'links') return true;
  if (p[0] === 'devices') return p[1] === user.uid || w.staff || p.length === 1;
  if (p[0] === 'events') {
    if (p.length === 2) return w.appAdmin || (!!w.pid && !!data && data.visibleTo.includes(w.pid));
    const ev = s['events/' + p[1]]; if (!ev) return false;
    return w.appAdmin || (w.pid && (ev.eventAdmins.includes(w.pid) || ev.visibleTo.includes(w.pid)));
  }
  return false;
}
function allowed(path, data, del) {
  const s = read(); const p = path.split('/'); const w = who(s); const cur = s[path];
  if (!user) return false;
  if (path === 'app/config') return cur ? w.owner : (!user.anonymous && same(data.ownerUids, [user.uid]));
  if (p[0] === 'people') {
    if (del) return w.appAdmin && cur.role !== 'owner';
    if (!cur) return w.appAdmin || (w.staff && data.role === 'player' && !(data.adminOf || []).length);
    if (w.owner) return true;
    if (w.appAdmin && cur.role !== 'owner' && ['player', 'appAdmin'].includes(data.role)) return true;
    if (w.appAdmin && cur.role === 'owner' && data.role === 'owner') return true;
    const changed = Object.keys({ ...cur, ...data }).filter(k => !same(cur[k], data[k]));
    return w.staff && changed.every(k => ['fullName', 'nick', 'phone', 'hcp', 'token', 'sentAt'].includes(k));
  }
  if (p[0] === 'links') return w.staff;
  if (p[0] === 'devices') {
    if (del) return w.appAdmin || p[1] === user.uid;
    return p[1] === user.uid && (s['links/' + data.token]?.personId === data.personId || (w.gOwner && data.token === 'owner'));
  }
  if (p[0] === 'events') {
    const ev = s['events/' + p[1]];
    if (p.length === 2) {
      if (del) return w.appAdmin;
      if (!cur) return w.appAdmin && visibleOk(data);
      if (w.appAdmin) return visibleOk(data);
      return !!w.pid && cur.eventAdmins.includes(w.pid) && visibleOk(data) && same(cur.status, data.status) && same(cur.eventAdmins, data.eventAdmins);
    }
    if (!ev) return false;
    const evAdmin = w.appAdmin || (w.pid && ev.eventAdmins.includes(w.pid));
    if (evAdmin) return true;
    const member = w.pid && ev.visibleTo.includes(w.pid);
    if (!member || (del && p[2] !== 'sides')) return false;
    const acc = ev.access?.[data.dayId] || {};
    if (p[2] === 'locks') return !cur && acc[w.pid] === data.groupId;
    if (p[2] === 'sides') return acc[w.pid] === data.groupId && !acc.__viewonly;
    if (p[2] === 'scores') return acc[w.pid] === data.groupId && acc[data.ent] === data.groupId && !acc.__viewonly && !s[`events/${p[1]}/locks/${data.unitKey}`] && data.holes.length === 18;
  }
  return false;
}
const denied = () => Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
const visibleKids = (path, pred = () => true) => children(read(), path).filter(x => canRead(path + '/' + x.id, x.data) && pred(x.data));
export const fb = {
  kind: 'mock',
  onAuth: cb => { authCbs.add(cb); setTimeout(() => cb(user), 0); return () => authCbs.delete(cb); },
  signInAnon: async () => setUser({ uid: 'anon-' + Math.random().toString(36).slice(2, 8), anonymous: true }),
  signInGoogle: async () => setUser({ uid: 'google-owner', anonymous: false, email: 'owner@example.com', name: 'Graham Carter' }),
  signOut: async () => setUser(null),
  get: async path => { const v = read()[path] ?? null; if (v && !canRead(path, v)) return denied(); return v; },
  set: async (path, data) => { const d = JSON.parse(JSON.stringify(data)); if (!allowed(path, d, false)) return denied(); const s = read(); s[path] = d; write(s); notify(); },
  merge: async (path, data) => { const s0 = read(); const d = { ...(s0[path] || {}), ...JSON.parse(JSON.stringify(data)) }; return fb.set(path, d); },
  del: async path => { if (!allowed(path, read()[path], true)) return denied(); const s = read(); delete s[path]; write(s); notify(); },
  batchSet: async items => { for (const x of items) await fb.set(x.path, x.data); },
  watchDoc: (path, cb, err) => { const fn = () => { const v = read()[path] ?? null; if (v && !canRead(path, v)) { err && err({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }); return; } cb(v, { pending: false, cached: false }); }; listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
  watchColl: (path, cb) => { const fn = () => cb(visibleKids(path), { pending: false, cached: false }); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
  list: async path => visibleKids(path),
  listContains: async (path, field, value) => visibleKids(path, d => (d[field] || []).includes(value)),
  now: () => new Date().toISOString(),
  newId: () => Math.random().toString(36).slice(2, 12),
};
