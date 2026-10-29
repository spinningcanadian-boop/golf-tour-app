// Thin wrapper over Firebase. The app talks only to these functions, so the storage
// can be swapped (a test stand-in here, or another backend later) without touching the screens.
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, getDoc, deleteDoc, query, where, getDocs, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Offline-first: reads come from the phone's cache and writes queue until there is signal.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const ref = path => doc(db, ...path.split('/'));
const cref = path => collection(db, ...path.split('/'));
const userOf = u => (u ? { uid: u.uid, anonymous: u.isAnonymous, email: u.email || null, name: u.displayName || null } : null);

export const fb = {
  kind: 'firebase',
  onAuth: cb => onAuthStateChanged(auth, u => cb(userOf(u))),
  signInAnon: () => signInAnonymously(auth).then(r => userOf(r.user)),
  signInGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()).then(r => userOf(r.user)),
  signOut: () => signOut(auth),
  get: async path => { const s = await getDoc(ref(path)); return s.exists() ? s.data() : null; },
  set: (path, data) => setDoc(ref(path), data),
  del: path => deleteDoc(ref(path)),
  batchSet: async items => { for (let i = 0; i < items.length; i += 400) { const b = writeBatch(db); items.slice(i, i + 400).forEach(x => b.set(ref(x.path), x.data)); await b.commit(); } },
  watchDoc: (path, cb, err) => onSnapshot(ref(path), { includeMetadataChanges: true }, s => cb(s.exists() ? s.data() : null, { pending: s.metadata.hasPendingWrites, cached: s.metadata.fromCache }), err),
  watchColl: (path, cb, err) => onSnapshot(cref(path), { includeMetadataChanges: true }, s => cb(s.docs.map(d => ({ id: d.id, data: d.data() })), { pending: s.metadata.hasPendingWrites, cached: s.metadata.fromCache }), err),
  merge: (path, data) => setDoc(ref(path), data, { merge: true }),
  list: async path => (await getDocs(cref(path))).docs.map(d => ({ id: d.id, data: d.data() })),
  listContains: async (path, field, value) => (await getDocs(query(cref(path), where(field, 'array-contains', value)))).docs.map(d => ({ id: d.id, data: d.data() })),
  now: () => serverTimestamp(),
  newId: () => doc(cref('events')).id,
};
