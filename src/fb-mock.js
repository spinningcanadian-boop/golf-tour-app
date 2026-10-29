// Test stand-in for Firebase (used only by `npm run build:test`). Data lives in localStorage so two
// pages open side by side behave like two phones syncing; sign-in lives in sessionStorage (per page).
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
// Very small rule check so tests catch obvious permission mistakes: the same intent as firestore.rules.
function allowed(path, data, del) {
  const s = read(); const p = path.split('/');
  if (p[0] !== 'tours') return false;
  const tour = s['tours/' + p[1]];
  const admin = tour && user && tour.adminUids.includes(user.uid);
  if (p.length === 2) return tour ? admin : (user && !user.anonymous && data && data.adminUids.length === 1 && data.adminUids[0] === user.uid);
  const member = user && s[`tours/${p[1]}/members/${user.uid}`];
  if (p[2] === 'members') { if (admin) return true; return !del && user && p[3] === user.uid && !member && s[`tours/${p[1]}/invites/${data.token}`]?.playerId === data.playerId; }
  if (p[2] === 'invites') return admin;
  if (p[2] === 'scores' || p[2] === 'locks') {
    if (admin) return true; if (!member || del) return false;
    const acc = tour.access?.[data.dayId] || {};
    const okGroup = acc[member.playerId] === data.groupId && (p[2] === 'locks' || acc[data.ent] === data.groupId);
    const notLocked = p[2] === 'locks' || !s[`tours/${p[1]}/locks/${data.unitKey}`];
    return okGroup && notLocked;
  }
  return false;
}
const denied = () => Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
export const fb = {
  kind: 'mock',
  onAuth: cb => { authCbs.add(cb); setTimeout(() => cb(user), 0); return () => authCbs.delete(cb); },
  signInAnon: async () => setUser({ uid: 'anon-' + Math.random().toString(36).slice(2, 8), anonymous: true }),
  signInGoogle: async () => setUser({ uid: 'admin-uid', anonymous: false, email: 'admin@example.com', name: 'Admin' }),
  signOut: async () => setUser(null),
  get: async path => read()[path] ?? null,
  set: async (path, data) => { if (!allowed(path, data, false)) return denied(); const s = read(); s[path] = JSON.parse(JSON.stringify(data)); write(s); notify(); },
  del: async path => { if (!allowed(path, read()[path], true)) return denied(); const s = read(); delete s[path]; write(s); notify(); },
  batchSet: async items => { for (const x of items) await fb.set(x.path, x.data); },
  watchDoc: (path, cb) => { const fn = () => cb(read()[path] ?? null, { pending: false, cached: false }); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
  watchColl: (path, cb) => { const fn = () => cb(children(read(), path), { pending: false, cached: false }); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
  adminTours: async uid => children(read(), 'tours').filter(t => t.data.adminUids.includes(uid)),
  now: () => new Date().toISOString(),
  newId: () => Math.random().toString(36).slice(2, 12),
};
