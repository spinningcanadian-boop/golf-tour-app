(() => {
  // src/fb-mock.js
  var KEY = "mockfs";
  var read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch (e) {
      return {};
    }
  };
  var write = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  var listeners = /* @__PURE__ */ new Set();
  var notify = () => listeners.forEach((fn) => fn());
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) notify();
  });
  var user = JSON.parse(sessionStorage.getItem("mockuser") || "null");
  var authCbs = /* @__PURE__ */ new Set();
  var setUser = (u) => {
    user = u;
    sessionStorage.setItem("mockuser", JSON.stringify(u));
    authCbs.forEach((cb) => cb(u));
    return u;
  };
  var children = (s, path) => {
    const n = path.split("/").length;
    return Object.keys(s).filter((k) => k.startsWith(path + "/") && k.split("/").length === n + 1).map((k) => ({ id: k.split("/").pop(), data: s[k] }));
  };
  function allowed(path, data, del) {
    const s = read();
    const p = path.split("/");
    if (p[0] !== "tours") return false;
    const tour2 = s["tours/" + p[1]];
    const admin = tour2 && user && tour2.adminUids.includes(user.uid);
    if (p.length === 2) return tour2 ? admin : user && !user.anonymous && data && data.adminUids.length === 1 && data.adminUids[0] === user.uid;
    const member = user && s[`tours/${p[1]}/members/${user.uid}`];
    if (p[2] === "members") {
      if (admin) return true;
      return !del && user && p[3] === user.uid && !member && s[`tours/${p[1]}/invites/${data.token}`]?.playerId === data.playerId;
    }
    if (p[2] === "invites") return admin;
    if (p[2] === "scores" || p[2] === "locks") {
      if (admin) return true;
      if (!member || del) return false;
      const acc = tour2.access?.[data.dayId] || {};
      const okGroup = acc[member.playerId] === data.groupId && (p[2] === "locks" || acc[data.ent] === data.groupId);
      const notLocked = p[2] === "locks" || !s[`tours/${p[1]}/locks/${data.unitKey}`];
      return okGroup && notLocked;
    }
    return false;
  }
  var denied = () => Promise.reject(Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }));
  var fb = {
    kind: "mock",
    onAuth: (cb) => {
      authCbs.add(cb);
      setTimeout(() => cb(user), 0);
      return () => authCbs.delete(cb);
    },
    signInAnon: async () => setUser({ uid: "anon-" + Math.random().toString(36).slice(2, 8), anonymous: true }),
    signInGoogle: async () => setUser({ uid: "admin-uid", anonymous: false, email: "admin@example.com", name: "Admin" }),
    signOut: async () => setUser(null),
    get: async (path) => read()[path] ?? null,
    set: async (path, data) => {
      if (!allowed(path, data, false)) return denied();
      const s = read();
      s[path] = JSON.parse(JSON.stringify(data));
      write(s);
      notify();
    },
    del: async (path) => {
      if (!allowed(path, read()[path], true)) return denied();
      const s = read();
      delete s[path];
      write(s);
      notify();
    },
    batchSet: async (items) => {
      for (const x of items) await fb.set(x.path, x.data);
    },
    watchDoc: (path, cb) => {
      const fn = () => cb(read()[path] ?? null, { pending: false, cached: false });
      listeners.add(fn);
      setTimeout(fn, 0);
      return () => listeners.delete(fn);
    },
    watchColl: (path, cb) => {
      const fn = () => cb(children(read(), path), { pending: false, cached: false });
      listeners.add(fn);
      setTimeout(fn, 0);
      return () => listeners.delete(fn);
    },
    adminTours: async (uid2) => children(read(), "tours").filter((t) => t.data.adminUids.includes(uid2)),
    now: () => (/* @__PURE__ */ new Date()).toISOString(),
    newId: () => Math.random().toString(36).slice(2, 12)
  };

  // engine/src/core.ts
  function indexTiers(indexes) {
    const i1 = indexes[0];
    return [i1, indexes[1] ?? i1 + 18, indexes[2] ?? i1 + 36];
  }
  function strokesOnHole(handicap, indexes) {
    const h = Math.round(handicap);
    if (h < 0) return indexes[0] > 18 + h ? -1 : 0;
    return indexTiers(indexes).filter((i) => i <= h).length;
  }
  function stablefordPoints(par, strokes, score) {
    if (score === null) return null;
    if (score === "P") return 0;
    return Math.max(2 + par + strokes - score, 0);
  }
  function adjustedGross(par, strokes, points) {
    return par + strokes + 2 - points;
  }
  function stablefordCard(course2, handicap, scores2) {
    const holes = course2.holes.map((h, i) => {
      const strokes = strokesOnHole(handicap, h.strokeIndexes);
      const score = scores2[i] ?? null;
      const points2 = stablefordPoints(h.par, strokes, score);
      return {
        hole: h.number,
        par: h.par,
        score,
        strokes,
        points: points2,
        adjustedGross: points2 === null ? null : adjustedGross(h.par, strokes, points2)
      };
    });
    const sum = (from, to) => holes.filter((l) => l.hole >= from && l.hole <= to).reduce((a, l) => a + (l.points ?? 0), 0);
    const holesEntered = holes.filter((l) => l.score !== null).length;
    const complete = holesEntered === course2.holes.length;
    const points = sum(1, 18);
    const coursePar = course2.holes.reduce((a, h) => a + h.par, 0);
    return {
      handicap,
      holes,
      front9: sum(1, 9),
      back9: sum(10, 18),
      points,
      holesEntered,
      complete,
      grossStableford: complete ? coursePar + Math.round(handicap) + (36 - points) : null
    };
  }
  function ambroseTeamHandicap(handicaps) {
    const n = handicaps.length;
    if (n < 2 || n > 4) throw new Error(`Ambrose teams are 2-4 players, got ${n}`);
    return handicaps.reduce((a, b) => a + b, 0) / (2 * n);
  }

  // engine/src/matchplay.ts
  function matchStrokes(course2, sides, method) {
    const low = Math.min(...sides.flat().map((p) => p.handicap));
    return course2.holes.map((h) => sides.map((side) => side.map((p) => method === "front" ? strokesOnHole(p.handicap, h.strokeIndexes) : strokesOnHole(Math.round(p.handicap - low), h.matchIndexes))));
  }
  function playMatch(course2, sides, opts) {
    const value = opts.value ?? 1;
    const names = opts.sideNames ?? [sides[0].map((p) => p.name).join(" & "), sides[1].map((p) => p.name).join(" & ")];
    const strokes = matchStrokes(course2, sides, opts.method);
    const n = course2.holes.length;
    let status = 0;
    let decidedOn = null;
    let holesPlayed = 0;
    const holes = course2.holes.map((h, i) => {
      const pts = sides.map((side, s) => side.map((p, k) => stablefordPoints(h.par, strokes[i][s][k], p.scores[i] ?? null)));
      const best = pts.map((arr) => {
        const vals = arr.filter((x) => x !== null);
        return vals.length ? Math.max(...vals) : null;
      });
      const allIn = pts.every((arr) => arr.every((x) => x !== null));
      let winner2 = null;
      if (allIn && best[0] !== null && best[1] !== null) {
        winner2 = best[0] === best[1] ? "halved" : best[0] > best[1] ? 0 : 1;
        holesPlayed = i + 1;
        if (decidedOn === null) {
          if (winner2 === 0) status++;
          if (winner2 === 1) status--;
          if (n - (i + 1) > 0 && Math.abs(status) > n - (i + 1)) decidedOn = h.number;
        }
      }
      const display = status === 0 ? "AS" : `${names[status > 0 ? 0 : 1]} ${Math.abs(status)} up`;
      const dormie2 = winner2 !== null && decidedOn === null && status !== 0 && Math.abs(status) === n - (i + 1);
      return { hole: h.number, strokes: strokes[i], points: pts, best, winner: winner2, status, display, holesRemaining: n - (i + 1), dormie: dormie2 };
    });
    const finished = decidedOn !== null || holesPlayed === n;
    let winner = null;
    let resultText = null;
    if (finished) {
      if (status === 0) {
        winner = "halved";
        resultText = "Halved";
      } else {
        winner = status > 0 ? 0 : 1;
        const remaining = n - (decidedOn ?? n);
        resultText = remaining > 0 ? `${Math.abs(status)} and ${remaining}` : `${Math.abs(status)} up`;
      }
    }
    const points = winner === null ? [0, 0] : winner === "halved" ? [value / 2, value / 2] : winner === 0 ? [value, 0] : [0, value];
    const toPlay = n - holesPlayed;
    const dormie = !finished && holesPlayed > 0 && status !== 0 && Math.abs(status) === toPlay;
    const liveText = finished ? winner === "halved" ? "Halved" : `${names[winner]} won ${resultText}` : holesPlayed === 0 ? "Not started" : `${status === 0 ? "AS" : `${names[status > 0 ? 0 : 1]} ${Math.abs(status)} up`} with ${toPlay} to play${dormie ? " (dormie)" : ""}`;
    return { holes, holesPlayed, finished, winner, resultText, decidedOn, points, liveText, toPlay, dormie };
  }

  // engine/src/leaderboard.ts
  function stablefordKeys(c) {
    const p = (h) => c.holes[h - 1].points ?? 0;
    const range = (a, b) => {
      let s = 0;
      for (let h = a; h <= b; h++) s += p(h);
      return s;
    };
    const keys = [
      { label: "back 9", value: range(10, 18) },
      { label: "last 6", value: range(13, 18) },
      { label: "last 3", value: range(16, 18) }
    ];
    for (let h = 18; h >= 10; h--) keys.push({ label: `hole ${h}`, value: p(h) });
    keys.push({ label: "front 9", value: range(1, 9) }, { label: "front last 6", value: range(4, 9) }, { label: "front last 3", value: range(7, 9) });
    for (let h = 9; h >= 1; h--) keys.push({ label: `hole ${h}`, value: p(h) });
    return keys;
  }
  function strokeKeys(holeScores, H) {
    const range = (a, b) => {
      let s = 0;
      for (let h = a; h <= b; h++) s += holeScores[h - 1];
      return s;
    };
    const keys = [
      { label: "back 9", value: range(10, 18) - H / 2 },
      { label: "last 6", value: range(13, 18) - H / 3 },
      { label: "last 3", value: range(16, 18) - H / 6 }
    ];
    for (let h = 18; h >= 10; h--) keys.push({ label: `hole ${h}`, value: holeScores[h - 1] - H / 18 });
    keys.push({ label: "front 9", value: range(1, 9) - H / 2 }, { label: "front last 6", value: range(4, 9) - H / 3 }, { label: "front last 3", value: range(7, 9) - H / 6 });
    for (let h = 9; h >= 1; h--) keys.push({ label: `hole ${h}`, value: holeScores[h - 1] - H / 18 });
    return keys;
  }
  var EPS = 1e-9;
  function rankWith(entries, primary, better, keys) {
    const sign = better === "higher" ? -1 : 1;
    const cmpKeys = (a, b) => {
      if (!keys) return { c: 0 };
      const ka = keys(a), kb = keys(b);
      for (let i = 0; i < ka.length; i++) {
        const d = ka[i].value - kb[i].value;
        if (Math.abs(d) > EPS) return { c: sign * d, label: ka[i].label };
      }
      return { c: 0 };
    };
    const cmp = (a, b) => {
      const d = primary(a) - primary(b);
      if (Math.abs(d) > EPS) return sign * d;
      return cmpKeys(a, b).c;
    };
    const sorted = [...entries].sort(cmp);
    const out = [];
    sorted.forEach((e, i) => {
      const prev = sorted[i - 1];
      const sameAsPrev = prev !== void 0 && cmp(prev, e) === 0;
      const rank = sameAsPrev ? out[i - 1].rank : i + 1;
      out.push({ rank, tied: false, entry: e });
      if (sameAsPrev) {
        out[i - 1].tied = true;
        out[i].tied = true;
      }
      if (prev && Math.abs(primary(prev) - primary(e)) < EPS && !sameAsPrev) {
        const lbl = cmpKeys(prev, e).label;
        if (lbl) out[i].countbackNote = `beaten on countback (${lbl})`;
      }
    });
    return out;
  }
  function dayGrossStablefordLeaderboard(entries) {
    const done = entries.filter((e) => e.card.complete);
    return rankWith(done, (e) => e.card.grossStableford, "lower", null);
  }
  function rankLabel(r) {
    if (r.dq) return "DQ";
    return (r.tied ? "T" : "") + r.rank;
  }
  function aggregateLeaderboard(entries, better = "higher") {
    const total = (e) => e.rounds.reduce((a2, r) => a2 + (r ?? 0), 0);
    const full = entries.filter((e) => e.rounds.every((r) => r !== null));
    const partial = entries.filter((e) => e.rounds.some((r) => r === null));
    const a = rankWith(full, total, better, null).map((r) => ({ ...r, total: total(r.entry), missedRounds: false }));
    const b = rankWith(partial, total, better, null).map((r) => ({ ...r, rank: r.rank + full.length, total: total(r.entry), missedRounds: true }));
    return [...a, ...b];
  }
  function liveOrder(rows, primary, better, keys) {
    const sign = better === "higher" ? -1 : 1;
    const cb = (a, b) => {
      const ka = keys(a), kb = keys(b);
      for (let i = 0; i < ka.length; i++) {
        const d = ka[i].value - kb[i].value;
        if (Math.abs(d) > EPS) return { c: sign * d, label: ka[i].label };
      }
      return { c: 0 };
    };
    const cmp = (a, b) => {
      const d = primary(a) - primary(b);
      if (Math.abs(d) > EPS) return sign * d;
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      if (a.complete && b.complete) return cb(a, b).c;
      return b.thru - a.thru;
    };
    const out = [...rows].sort(cmp);
    out.forEach((r, i) => {
      const prev = out[i - 1];
      const level = prev && Math.abs(primary(prev) - primary(r)) < EPS;
      const sameRank = level && (!prev.complete || !r.complete || cb(prev, r).c === 0);
      r.rank = sameRank ? prev.rank : i + 1;
      r.tied = false;
      if (sameRank) {
        prev.tied = true;
        r.tied = true;
      }
      if (level && prev.complete && r.complete) {
        const res = cb(prev, r);
        if (res.c === 0) {
          prev.tiedAllCountbacks = true;
          r.tiedAllCountbacks = true;
        } else prev.aheadOn = { other: r.player, label: res.label };
      }
    });
    return out;
  }
  function liveStablefordLeaderboard(entries) {
    const rows = entries.filter((e) => e.card.holesEntered > 0).map((e) => ({
      player: e.player,
      card: e.card,
      thru: e.card.holesEntered,
      complete: e.card.complete,
      rank: 0,
      tied: false
    }));
    return liveOrder(rows, (r) => r.card.points, "higher", (r) => stablefordKeys(r.card));
  }
  function liveNetLeaderboard(entries) {
    const ok = [], dq = [];
    for (const e of entries) {
      if (e.card.holesEntered === 0) continue;
      const played = e.card.holes.filter((l) => l.score !== null);
      const base = { player: e.player, card: e.card, thru: e.card.holesEntered, complete: e.card.complete, rank: 0, tied: false };
      if (played.some((l) => l.score === "P")) {
        dq.push({ ...base, dq: true });
        continue;
      }
      const gross = played.reduce((a, l) => a + l.score, 0);
      const netToPar = played.reduce((a, l) => a + l.score - l.par - l.strokes, 0);
      ok.push({ ...base, gross, netToPar, net: e.card.complete ? gross - e.card.handicap : void 0 });
    }
    const ordered = liveOrder(ok, (r) => r.netToPar, "lower", (r) => strokeKeys(r.card.holes.map((l) => l.score), r.card.handicap));
    return [...ordered, ...dq.map((r) => ({ ...r, rank: 0 }))];
  }

  // engine/src/ambrose.ts
  function ambroseCard(course2, team) {
    const teamHandicap = ambroseTeamHandicap(team.handicaps);
    const n = (x) => typeof x === "number" ? x : 0;
    const sum = (a, b) => team.scores.slice(a - 1, b).reduce((t, x) => t + n(x), 0);
    const pickups = team.scores.filter((x) => x === "P").length;
    const complete = team.scores.length === course2.holes.length && team.scores.every((x) => x !== null);
    const gross = sum(1, 18);
    const par = course2.holes.reduce((t, h) => t + h.par, 0);
    return {
      team: team.name,
      teamHandicap,
      front9: sum(1, 9),
      back9: sum(10, 18),
      gross,
      pickups,
      dq: pickups > 0,
      net: pickups > 0 ? null : gross - teamHandicap,
      toPar: gross - par,
      complete
    };
  }
  function playAmbroseMatch(course2, teams, opts = {}) {
    const caps = teams.map((t) => ambroseTeamHandicap(t.handicaps));
    const difference = caps[0] - caps[1];
    const deemed = opts.deemedStrokes ?? Math.round(Math.abs(difference));
    const strokesReceived = difference > 0 ? [deemed, 0] : difference < 0 ? [0, deemed] : [0, 0];
    const players = teams.map((t, i) => ({ name: t.name, handicap: strokesReceived[i], scores: t.scores }));
    const m = playMatch(course2, [[players[0]], [players[1]]], {
      method: (opts.index ?? "stroke") === "stroke" ? "front" : "back",
      value: opts.value,
      sideNames: [teams[0].name, teams[1].name]
    });
    return { ...m, teamHandicaps: caps, difference, strokesReceived };
  }

  // src/demo-seed.json
  var demo_seed_default = { tour: { title: "Demo tour", teams: { t1: { name: "Red", color: "#c8372d" }, t2: { name: "Blue", color: "#2a5fb0" } }, pointsToWin: 4.5, visibility: "live", until: "12:30", players: [{ id: "graham", name: "Graham", team: "t1", hcp: 6 }, { id: "col", name: "Col", team: "t1", hcp: 16 }, { id: "nic", name: "Nic", team: "t2", hcp: 9 }, { id: "glen", name: "Glen", team: "t2", hcp: 25 }, { id: "mitch", name: "Mitch", team: "t1", hcp: 6 }, { id: "larry", name: "Larry", team: "t1", hcp: 16 }, { id: "shae", name: "Shae", team: "t2", hcp: 9 }, { id: "gavan", name: "Gavan", team: "t2", hcp: 25 }, { id: "tiger", name: "Tiger", team: "t1", hcp: 25 }, { id: "simon", name: "Simon", team: "t2", hcp: 34 }, { id: "brett", name: "Brett", team: "t1", hcp: 18 }, { id: "chris", name: "Chris", team: "t2", hcp: 23 }, { id: "peter", name: "Peter", team: "t1", hcp: 36 }, { id: "scotty", name: "Scotty O", team: "t2", hcp: 6 }, { id: "scottf", name: "Scott F", team: "t1", hcp: 34 }, { id: "tony", name: "Tony", team: "t2", hcp: 19 }, { id: "dave", name: "Dave", team: "t1", hcp: 18 }, { id: "waz", name: "Waz O", team: "t1", hcp: 24 }, { id: "karl", name: "Karl", team: "t2", hcp: 28 }, { id: "murph", name: "Murph", team: "t1", hcp: 6 }, { id: "lord", name: "Lord", team: "t1", hcp: 17 }, { id: "nugs", name: "Nugs", team: "t2", hcp: 9 }, { id: "bill", name: "Bill", team: "t2", hcp: 25 }, { id: "brian", name: "Brian", team: null, hcp: 15 }, { id: "jon", name: "Jon", team: null, hcp: 18 }, { id: "matty", name: "Matty T", team: null, hcp: 20 }, { id: "al", name: "Al", team: null, hcp: 25 }, { id: "rob", name: "Rob (guest)", team: null, hcp: 14 }, { id: "steve", name: "Steve (guest)", team: null, hcp: 20 }], courses: [{ id: "woolooware", name: "Woolooware GC", tees: [{ id: "blue", name: "Blue", colour: "#2a5fb0", holes: [{ number: 1, par: 4, strokeIndexes: [1, 19, 37], matchIndexes: [18, 36, 54] }, { number: 2, par: 4, strokeIndexes: [3, 22, 40], matchIndexes: [8, 26, 44] }, { number: 3, par: 4, strokeIndexes: [11, 29, 47], matchIndexes: [12, 30, 48] }, { number: 4, par: 3, strokeIndexes: [18, 35, 53], matchIndexes: [3, 21, 39] }, { number: 5, par: 4, strokeIndexes: [9, 23, 41], matchIndexes: [14, 32, 50] }, { number: 6, par: 4, strokeIndexes: [17, 31, 49], matchIndexes: [6, 24, 42] }, { number: 7, par: 4, strokeIndexes: [5, 27, 45], matchIndexes: [10, 28, 46] }, { number: 8, par: 5, strokeIndexes: [7, 20, 38], matchIndexes: [1, 19, 37] }, { number: 9, par: 3, strokeIndexes: [14, 33, 51], matchIndexes: [16, 34, 52] }, { number: 10, par: 3, strokeIndexes: [15, 36, 54], matchIndexes: [5, 23, 41] }, { number: 11, par: 4, strokeIndexes: [12, 30, 48], matchIndexes: [11, 29, 47] }, { number: 12, par: 5, strokeIndexes: [6, 21, 39], matchIndexes: [2, 20, 38] }, { number: 13, par: 4, strokeIndexes: [4, 25, 43], matchIndexes: [15, 33, 51] }, { number: 14, par: 5, strokeIndexes: [13, 26, 44], matchIndexes: [7, 25, 43] }, { number: 15, par: 4, strokeIndexes: [8, 28, 46], matchIndexes: [13, 31, 49] }, { number: 16, par: 3, strokeIndexes: [16, 34, 52], matchIndexes: [4, 22, 40] }, { number: 17, par: 3, strokeIndexes: [10, 32, 50], matchIndexes: [17, 35, 53] }, { number: 18, par: 4, strokeIndexes: [2, 24, 42], matchIndexes: [9, 27, 45] }] }] }], days: [{ id: "d1", title: "Day 1", date: "2026-10-29", courseId: "woolooware", teeId: "blue", teamsOn: true, briefing: 'Demo only. Groups 1, 2 and 6 use your mockup scores; the rest are generated examples. Meet at the pro shop 7:10. Nearest the pin on 4 and 16. Group 3 is still on the course, so try entering holes 12 to 18. Use "Viewing as" below to see the app as a player or as the administrator.', groups: [{ id: "g1", tee: "7:30", format: "fourball", method: "front", value: 1, slots: { a: ["graham", "col"], b: ["nic", "glen"] } }, { id: "g2", tee: "7:39", format: "fourball", method: "back", value: 1, slots: { a: ["mitch", "larry"], b: ["shae", "gavan"] } }, { id: "g3", tee: "7:48", format: "singles", method: "front", value: 1, slots: { a: ["tiger", "brett"], b: ["simon", "chris"] } }, { id: "g4", tee: "7:57", format: "singles", method: "back", value: 1, slots: { a: ["peter", "scottf"], b: ["scotty", "tony"] } }, { id: "g5", tee: "8:06", format: "twoVone", method: "back", value: 0.5, slots: { a: ["dave", "waz"], b: ["karl"] } }, { id: "g6", tee: "8:15", format: "ambroseMatch", method: "front", value: 1, slots: { a: ["murph", "lord"], b: ["nugs", "bill"] }, ambIds: ["amb-red", "amb-blue"] }, { id: "g7", tee: "8:24", format: "ambroseStroke", method: "front", value: 1, slots: { a: ["brian", "jon", "matty"], b: [] }, ambIds: ["amb-3"] }, { id: "g8", tee: "8:33", format: "individual", method: "front", value: 1, slots: { a: ["al", "rob", "steve"], b: [] } }] }] }, scores: { d1: { graham: [5, 4, 6, 3, 5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 4], col: [5, 5, 4, 5, 4, 5, 5, 6, 5, 3, 6, 6, 6, 8, 5, 3, 4, 5], nic: [4, 4, 4, 4, 5, 5, 5, 5, 4, 2, 4, 5, 5, 5, 4, 5, 3, 3], glen: ["P", 5, 6, 4, 5, 5, 4, 6, 5, 5, 3, 7, 6, 8, 6, 4, 4, 5], mitch: [5, 4, 6, 3, 5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 4], larry: [5, 5, 4, 5, 4, 5, 5, 6, 5, 3, 6, 6, 6, 8, 5, 3, 4, 5], shae: [4, 4, 4, 4, 5, 5, 5, 5, 4, 2, 4, 5, 5, 5, 4, 5, 3, 3], gavan: ["P", 5, 6, 4, 5, 5, 4, 6, 5, 5, 3, 7, 6, 8, 6, 4, 4, 5], tiger: [6, 8, 8, 4, 6, 5, 4, 7, 4, 4, 5, null, null, null, null, null, null, null], simon: [7, 7, 8, 6, 6, 7, 7, 7, 5, 3, 6, null, null, null, null, null, null, null], brett: [4, 5, 5, 3, 5, 4, 5, 6, 6, 4, 5, null, null, null, null, null, null, null], chris: [6, 6, 6, 5, 6, 6, 6, 7, 4, 4, 5, null, null, null, null, null, null, null], peter: [6, 5, 6, 6, 6, 5, 5, 8, 4, 4, 5, 7, 5, 7, 6, 5, 5, 6], scotty: [6, 5, 4, 3, 5, 4, 7, 5, 4, 4, 4, 7, 5, 5, 4, 4, 3, 4], scottf: [7, 6, 6, 6, 5, 6, 7, 7, 5, 4, 6, 7, 6, 7, 6, 4, 5, 6], tony: [6, 5, 6, 4, 5, 5, 5, 7, 3, 4, 6, 7, 5, 6, 6, 4, 4, 5], dave: [7, 4, 5, 3, 4, 4, 5, 8, 4, 4, 4, 6, 5, 7, 4, 3, 4, 5], waz: [7, 7, 5, 4, 8, 5, 5, 8, 3, 3, 4, 7, 5, 6, 7, 5, 5, 6], karl: [6, 5, 5, 5, 6, 5, 8, 6, 4, 7, 6, 9, 6, 7, 5, 5, 6, 8], "amb-red": [4, 3, 4, 3, 3, 3, 5, 5, 3, 3, 3, 4, 5, 4, 4, 2, 3, 4], "amb-blue": [4, 4, 4, 3, 4, 4, 4, 5, 3, 3, 4, 5, 4, 5, 4, 3, 3, 4], "amb-3": [5, 4, 4, 4, 4, 4, 3, 6, 3, 3, 4, 6, 4, 4, 4, 4, 2, 4], al: [6, 7, 6, 4, 8, 6, 5, 7, 4, 5, 7, 8, 8, 6, 5, 3, 4, 7], rob: [6, 6, 6, 3, 5, 5, 7, 6, 5, 3, 5, 7, 4, 6, 6, 4, 7, 5], steve: [6, 4, 5, 5, 7, 5, 4, 6, 4, 4, 7, 5, "P", 7, 5, 5, 4, 6] } } };

  // src/main.js
  var KEY2 = "golf-tour-app";
  var clone = (o) => o === void 0 ? void 0 : JSON.parse(JSON.stringify(o));
  var load = (k, d) => {
    try {
      const s = localStorage.getItem(KEY2 + k);
      return s ? JSON.parse(s) : d;
    } catch (e) {
      return d;
    }
  };
  var store = (k, v) => {
    try {
      localStorage.setItem(KEY2 + k, JSON.stringify(v));
    } catch (e) {
    }
  };
  var me = null;
  var tourId = null;
  var tour = null;
  var scores = {};
  var locks = {};
  var invites = {};
  var members = {};
  var myPlayerId = null;
  var gate = { state: "loading" };
  var sync = { pending: false, cached: false };
  var server = { tour: null, scores: {}, locks: {} };
  var unsubs = [];
  var ui = Object.assign({ tab: "day", day: null, group: null, unit: {}, view: "gross", lb: "stab", lbScope: "day", as: "admin", cb: true, open: {}, setup: "tour" }, load(":ui", {}), { entry: null });
  var persist = () => store(":ui", { tab: ui.tab, day: ui.day, group: ui.group, unit: ui.unit, view: ui.view, lb: ui.lb, lbScope: ui.lbScope, as: ui.as, cb: ui.cb, setup: ui.setup });
  var esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  var uid = (p) => p + Math.random().toString(36).slice(2, 8);
  var token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
  var frac = (n) => {
    const w = Math.floor(n), f = n - w;
    const s = f === 0.5 ? "\xBD" : f === 0.25 ? "\xBC" : f === 0.75 ? "\xBE" : "";
    return (w || !s ? w : "") + s;
  };
  var toParTxt = (n) => n === 0 ? "E" : n > 0 ? "+" + n : "\u2212" + Math.abs(n);
  var fmtDate = (iso) => {
    try {
      return (/* @__PURE__ */ new Date(iso + "T00:00")).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
    } catch (e) {
      return iso;
    }
  };
  var toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.hidden = true, 2800);
  }
  var P = () => Object.fromEntries(tour.players.map((p) => [p.id, p]));
  var PIDX = {};
  var dayById = (id) => tour.days.find((d) => d.id === id);
  var DAY = () => dayById(ui.day) || tour.days[0];
  var teeOf = (day) => {
    const c = tour.courses.find((c2) => c2.id === day.courseId);
    const t = c && c.tees.find((t2) => t2.id === day.teeId);
    return c && t ? { name: c.name, tee: t.name, colour: t.colour, holes: t.holes, par: t.holes.reduce((a, h) => a + h.par, 0) } : null;
  };
  var course = null;
  var daySc = (dayId) => scores[dayId] = scores[dayId] || {};
  var scFor = (dayId, id) => daySc(dayId)[id] || Array(18).fill(null);
  var sc = (id) => scFor(DAY().id, id);
  var tName = (t) => t ? tour.teams[t].name : "";
  var FORMATS = {
    fourball: { label: "4-ball", a: 2, b: 2, match: true },
    singles: { label: "Two singles", a: 2, b: 2, match: true },
    twoVone: { label: "2 v 1 singles", a: 2, b: 1, match: true },
    ambroseMatch: { label: "2-man Ambrose match", a: 2, b: 2, match: true },
    ambroseStroke: { label: "Ambrose \xB7 stroke", a: 4, b: 0, match: false, min: 2 },
    individual: { label: "Individual Stableford", a: 4, b: 0, match: false, min: 1 }
  };
  function groupLabel(g) {
    const f = FORMATS[g.format];
    const meth = f.match && g.format !== "ambroseMatch" ? ` \xB7 ${g.method === "back" ? "back" : "front"} of card` : "";
    const val = f.match && g.value !== 1 ? ` \xB7 ${frac(g.value)} pt each` : "";
    if (g.format === "ambroseStroke") return `${g.slots.a.filter(Boolean).length}-man Ambrose \xB7 stroke`;
    return f.label + meth + val;
  }
  var groupPlayers = (g) => [...g.slots.a, ...g.slots.b].filter(Boolean);
  function ambTeams(g) {
    if (g.format === "ambroseMatch") {
      const ids = g.ambIds || [g.id + "-a", g.id + "-b"];
      return [{ id: ids[0], players: g.slots.a.filter(Boolean) }, { id: ids[1], players: g.slots.b.filter(Boolean) }].map((t) => ({ ...t, name: t.players.map((id) => PIDX[id]?.name).join(" & "), team: PIDX[t.players[0]]?.team || null }));
    }
    if (g.format === "ambroseStroke") {
      const id = (g.ambIds || [g.id + "-t"])[0];
      const ps = g.slots.a.filter(Boolean);
      return [{ id, players: ps, name: ps.map((x) => PIDX[x]?.name).join(", ").replace(/, ([^,]*)$/, " & $1"), team: null }];
    }
    return [];
  }
  function unitsOf(day, g) {
    const key = (i) => `${day.id}:${g.id}:${i}`;
    const teamsOn = day.teamsOn !== false;
    if (g.format === "ambroseMatch") {
      const [a, b] = ambTeams(g);
      if (!a.players.length || !b.players.length) return [];
      return [{ key: key(0), g, day, kind: "ambroseMatch", sides: [[a.id], [b.id]], teams: teamsOn ? [a.team, b.team] : ["n1", "n2"], label: `${a.name} v ${b.name}`, value: g.value, ents: [a.id, b.id], teamsOn }];
    }
    if (g.format === "ambroseStroke") {
      const [t] = ambTeams(g);
      return t.players.length ? [{ key: key(0), g, day, kind: "ambroseStroke", ents: [t.id], label: t.name }] : [];
    }
    if (g.format === "individual") return [{ key: key(0), g, day, kind: "individual", ents: g.slots.a.filter(Boolean), label: "All players" }];
    let pairs;
    if (g.format === "fourball") pairs = [[g.slots.a.filter(Boolean), g.slots.b.filter(Boolean)]];
    else if (g.format === "singles") pairs = [0, 1].map((i) => [[g.slots.a[i]].filter(Boolean), [g.slots.b[i]].filter(Boolean)]);
    else pairs = [0, 1].map((i) => [[g.slots.a[i]].filter(Boolean), [g.slots.b[0]].filter(Boolean)]);
    return pairs.filter((p) => p[0].length && p[1].length).map((sides, i) => {
      if (teamsOn && PIDX[sides[0][0]].team === "t2" && PIDX[sides[1][0]].team === "t1") sides = [sides[1], sides[0]];
      return {
        key: key(i),
        g,
        day,
        kind: "match",
        sides,
        teams: teamsOn ? sides.map((s) => PIDX[s[0]].team) : ["n1", "n2"],
        value: g.value,
        ents: [...sides[0], ...sides[1]],
        label: sides.map((s) => s.map((id) => PIDX[id].name).join(" & ")).join(" v "),
        teamsOn
      };
    });
  }
  var allAmb = () => tour.days.flatMap((d) => d.groups.flatMap(ambTeams));
  var ambTeam = (id) => allAmb().find((a) => a.id === id);
  var entName = (id) => PIDX[id] ? PIDX[id].name : ambTeam(id)?.name || "?";
  var entTeam = (id) => PIDX[id] ? PIDX[id].team : ambTeam(id)?.team;
  var entHcp = (id) => PIDX[id] ? PIDX[id].hcp : ambroseTeamHandicap(ambTeam(id).players.map((p) => PIDX[p].hcp));
  function matchOf(u) {
    const crs = teeOf(u.day);
    const s = (id) => scFor(u.day.id, id);
    if (u.kind === "match") return playMatch(crs, u.sides.map((x) => x.map((id) => ({ name: PIDX[id].name, handicap: PIDX[id].hcp, scores: s(id) }))), { method: u.g.method, value: u.value, sideNames: u.sides.map((x) => x.map((id) => PIDX[id].name).join(" & ")) });
    if (u.kind === "ambroseMatch") return playAmbroseMatch(crs, u.sides.map((x) => {
      const a = ambTeam(x[0]);
      return { name: a.name, handicaps: a.players.map((p) => PIDX[p].hcp), scores: s(x[0]) };
    }), { value: u.value });
    return null;
  }
  var cardOf = (id, day = DAY()) => stablefordCard(teeOf(day), PIDX[id].hcp, scFor(day.id, id));
  var thruOf = (id) => sc(id).filter((v) => v !== null).length;
  var unitComplete = (u) => u.ents.every((id) => scFor(u.day.id, id).filter((v) => v !== null).length === 18);
  var isAdmin = () => isRealAdmin() && ui.as === "admin";
  function myUnits(day = DAY()) {
    return isAdmin() ? [] : day.groups.flatMap((g) => unitsOf(day, g)).filter((u) => u.ents.includes(ui.as) || u.kind.startsWith("ambrose") && groupPlayers(u.g).includes(ui.as));
  }
  function myGroup(day = DAY()) {
    return isAdmin() ? null : day.groups.find((g) => groupPlayers(g).includes(ui.as));
  }
  function boardsLive() {
    if (tour.visibility === "live") return true;
    if (tour.visibility === "hidden") return false;
    const [h, m] = (tour.until || "12:30").split(":").map(Number);
    const now = /* @__PURE__ */ new Date();
    return now.getHours() * 60 + now.getMinutes() < h * 60 + m;
  }
  var canSeeAll = () => isAdmin() || boardsLive();
  var canSeeGroup = (g) => canSeeAll() || myGroup() && myGroup().id === g.id;
  var canEdit = (u) => isAdmin() || !locks[u.key] && myUnits(u.day).some((x) => x.key === u.key);
  var SWATCHES = [["Red", "#c8372d"], ["Blue", "#2a5fb0"], ["Aussie green", "#00843d"], ["Gold", "#f2b705"], ["Orange", "#e06c1f"], ["Purple", "#6b3fa0"], ["Black", "#26292e"], ["Teal", "#0f8b8d"]];
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = n >> 16, g = n >> 8 & 255, b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? "#1d1a10" : "#ffffff";
  }
  function applyTeams() {
    const r = document.documentElement.style;
    for (const t of ["t1", "t2"]) {
      r.setProperty("--" + t, tour.teams[t].color);
      r.setProperty("--" + t + "-ink", inkFor(tour.teams[t].color));
    }
    r.setProperty("--tee", course ? course.colour : "#2a5fb0");
  }
  function marker(score, par) {
    if (score === null || score === void 0) return '<span class="empty-cell">\xB7</span>';
    if (score === "P") return '<span class="mk pu">P</span>';
    const d = score - par;
    const cls = d <= -2 ? "eagle" : d === -1 ? "birdie" : d === 1 ? "bogey" : d >= 2 ? "dbl" : "";
    return `<span class="mk ${cls}">${score}</span>`;
  }
  var withShots = (inner, n) => `<span class="cv">${inner}${n > 0 ? `<span class="shots" aria-label="${n} shot${n > 1 ? "s" : ""}">${"<i></i>".repeat(n)}</span>` : ""}</span>`;
  function chev(st, teams, { deep = false, text = null, big = false } = {}) {
    if (st === 0) return `<span class="chev as ${deep ? "deep" : ""} ${big ? "big" : ""}">${text || "AS"}</span>`;
    const side = st > 0 ? 0 : 1;
    return `<span class="chev ${side === 0 ? "l" : "r"} ${teams[side]} ${deep ? "deep" : ""} ${big ? "big" : ""}">${text || Math.abs(st) + " UP"}</span>`;
  }
  function matchState(u, m, big = false) {
    if (!m || !m.holesPlayed) return { chip: `<span class="chev ns ${big ? "big" : ""}">Not started</span>`, sub: "" };
    if (m.finished) {
      if (m.winner === "halved") return { chip: chev(0, u.teams, { deep: true, text: "AS", big }), sub: "Halved" };
      return { chip: chev(m.winner === 0 ? 1 : -1, u.teams, { deep: true, text: m.resultText.replace(" and ", " & ").toUpperCase(), big }), sub: u.teamsOn ? `${tName(u.teams[m.winner])} won` : `${entNames(u.sides[m.winner])} won` };
    }
    const st = m.holes[m.holesPlayed - 1].status;
    return { chip: chev(st, u.teams, { big, text: st === 0 ? "AS" : null }), sub: m.dormie ? `Dormie \xB7 ${m.toPlay} to play` : `${m.toPlay} to play` };
  }
  var entNames = (ids) => ids.map((id) => esc(entName(id))).join(" & ");
  function mlineHTML(u, m, opts = {}) {
    const st = matchState(u, m, opts.big);
    const pts = (side) => m && m.finished ? `<b>${frac(m.points[side])}</b>` : "";
    return `<div class="mline"><div class="a"><span class="dot ${u.teams[0]}"></span>${entNames(u.sides[0])}${opts.pts ? pts(0) : ""}</div>
    <div class="c">${st.chip}<span class="sub">${st.sub}</span></div>
    <div class="b">${entNames(u.sides[1])}<span class="dot ${u.teams[1]}" style="margin:0 0 0 5px"></span>${opts.pts ? pts(1) : ""}</div></div>`;
  }
  function miniPlayer(id, day = DAY()) {
    const c = cardOf(id, day);
    const block = (from) => {
      const ls = c.holes.slice(from, from + 9);
      const sum = (f) => ls.reduce((t, l) => t + (f(l) ?? 0), 0);
      const gross = ls.reduce((t, l) => t + (typeof l.score === "number" ? l.score : 0), 0);
      return `<tr class="hd"><th>Hole</th>${ls.map((l) => `<th>${l.hole}</th>`).join("")}<th class="tot">${from ? "IN" : "OUT"}</th></tr>
      <tr><td>Par</td>${ls.map((l) => `<td>${l.par}</td>`).join("")}<td class="tot">${sum((l) => l.par)}</td></tr>
      <tr><td>Strokes</td>${ls.map((l) => `<td>${l.score === null ? "" : marker(l.score, l.par)}</td>`).join("")}<td class="tot">${gross || ""}</td></tr>
      <tr><td>Shots</td>${ls.map((l) => `<td>${l.strokes || ""}</td>`).join("")}<td class="tot">${sum((l) => l.strokes)}</td></tr>
      <tr><td>Points</td>${ls.map((l) => `<td>${l.points ?? ""}</td>`).join("")}<td class="tot">${sum((l) => l.points)}</td></tr>`;
    };
    return `<table class="mini">${block(0)}${block(9)}</table>`;
  }
  function miniMatch(u, m) {
    const crs = teeOf(u.day);
    const s = (id) => scFor(u.day.id, id);
    const block = (from) => {
      const hs = crs.holes.slice(from, from + 9);
      const row = (id, side, k) => `<tr><td><span class="dot ${u.teams[side]}"></span>${esc(entName(id))}</td>${hs.map((h, j) => {
        const i = from + j;
        const mh = m.holes[i];
        const p = mh.points[side][k];
        const win = mh.winner === side && p !== null && p === mh.best[side] && !(m.decidedOn && h.number > m.decidedOn);
        return `<td class="${win ? "win-" + u.teams[side] : ""}">${marker(s(id)[i], h.par)}</td>`;
      }).join("")}<td class="tot">${s(id).slice(from, from + 9).reduce((t, v) => t + (typeof v === "number" ? v : 0), 0) || ""}</td></tr>`;
      const status = `<tr><td>Match</td>${hs.map((h) => {
        const mh = m.holes[h.number - 1];
        if (mh.winner === null || m.decidedOn && h.number > m.decidedOn) return "<td></td>";
        const st = mh.status;
        const fin = m.decidedOn === h.number || m.finished && !m.decidedOn && h.number === 18;
        return `<td><span class="ms ${st === 0 ? "as" : u.teams[st > 0 ? 0 : 1]} ${fin ? "deep" : ""}">${st === 0 ? "AS" : Math.abs(st)}</span></td>`;
      }).join("")}<td></td></tr>`;
      return `<tr class="hd"><th>Hole</th>${hs.map((h) => `<th>${h.number}</th>`).join("")}<th class="tot">${from ? "IN" : "OUT"}</th></tr>
      <tr><td>Par</td>${hs.map((h) => `<td>${h.par}</td>`).join("")}<td class="tot">${hs.reduce((t, h) => t + h.par, 0)}</td></tr>
      ${u.sides[0].map((id, k) => row(id, 0, k)).join("")}${status}${u.sides[1].map((id, k) => row(id, 1, k)).join("")}`;
    };
    return `<table class="mini">${block(0)}${block(9)}</table>`;
  }
  function daySwitch() {
    if (tour.days.length < 2) return "";
    return `<div class="chips" role="toolbar" aria-label="Days">${tour.days.map((d) => `<button aria-pressed="${d.id === DAY().id}" data-day="${d.id}">${esc(d.title)} \xB7 ${fmtDate(d.date)}</button>`).join("")}</div>`;
  }
  function viewDay() {
    const day = DAY();
    const viewing = !isRealAdmin() ? "" : `<section class="card"><div class="pad"><div class="frow"><label for="as">Preview as <span class="muted small">(administrators only: see the app as a player would)</span></label>
    <select id="as"><option value="admin" ${isAdmin() ? "selected" : ""}>Administrator</option>${tour.players.map((p) => `<option value="${p.id}" ${ui.as === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div></div></section>`;
    if (!course) return viewing + daySwitch() + `<section class="card"><div class="pad">${esc(day.title)} has no course yet. ${isAdmin() ? "Choose one in Setup > Days." : ""}</div></section>`;
    const order = day.groups.map((g, gi) => {
      const units = unitsOf(day, g);
      const visible = canSeeGroup(g);
      const ents = units.flatMap((u) => u.ents);
      const thru = ents.length ? Math.min(...ents.map(thruOf)) : 0;
      const status = thru === 18 ? "Finished" : thru === 0 ? "Not started" : `Thru ${thru}`;
      let lines;
      if (FORMATS[g.format].match) lines = units.map((u) => mlineHTML(u, visible ? matchOf(u) : null)).join("");
      else lines = `<div class="mline"><div class="a" style="grid-column:1/-1">${groupPlayers(g).map((id) => `<span class="dot ${PIDX[id]?.team || ""}"></span>${esc(PIDX[id]?.name)}`).join("&ensp;")}</div></div>`;
      return `<li><button class="gbtn" data-go="${g.id}"><span class="teet">${esc(g.tee || "")}<small>Group ${gi + 1}</small></span>
      <span><span class="lbl"><span>${esc(groupLabel(g))}</span><span>${visible ? status : ""}</span></span>${lines}</span></button></li>`;
    }).join("");
    return `${viewing}${daySwitch()}
  <section class="card"><div class="pad coursebar"><span><span class="eyebrow">${esc(day.title)} \xB7 ${fmtDate(day.date)}</span><br><b>${esc(course.name)}</b></span><span class="tee"><i></i>${esc(course.tee)} tees \xB7 Par ${course.par}</span></div></section>
  ${day.briefing ? `<section class="card"><h2>Briefing</h2><div class="pad" style="padding-top:0;white-space:pre-line">${esc(day.briefing)}</div></section>` : ""}
  <section class="card"><h2>Order of play</h2>${day.groups.length ? `<ol class="order">${order}</ol>` : `<div class="pad muted">No groups posted yet.</div>`}</section>
  <p class="small muted" style="margin:0">Scores save on your phone first and sync when there is signal.</p>`;
  }
  function viewScores() {
    const day = DAY();
    if (!course) return daySwitch() + `<section class="card"><div class="pad">No course set for this day yet.</div></section>`;
    const groups = day.groups.filter(canSeeGroup);
    if (!groups.length) return daySwitch() + `<section class="card"><div class="pad">${day.groups.length ? "You are not in a group on this day." : "No groups posted yet."}</div></section>`;
    if (!groups.find((g2) => g2.id === ui.group)) ui.group = (myGroup() || groups[0]).id;
    const g = day.groups.find((x) => x.id === ui.group);
    const gn = day.groups.indexOf(g) + 1;
    const units = unitsOf(day, g);
    if (!units.length) return daySwitch() + `<section class="card"><div class="pad">Group ${gn} has no players yet.</div></section>`;
    const uk = day.id + ":" + g.id;
    if (ui.unit[uk] === void 0 || !units[ui.unit[uk]]) {
      const mine = units.findIndex((u2) => myUnits().some((x) => x.key === u2.key));
      ui.unit[uk] = Math.max(0, mine);
    }
    const u = units[ui.unit[uk]];
    const m = matchOf(u);
    const isMatch = !!m;
    const views = [["gross", "Gross"], ...u.kind === "ambroseStroke" ? [] : [["stab", u.kind === "ambroseMatch" ? "Points" : "Stableford"]], ...u.kind === "match" ? [["match", "Match"]] : []];
    if (!views.find((v) => v[0] === ui.view)) ui.view = "gross";
    const chips = groups.length > 1 ? `<div class="chips" role="toolbar" aria-label="Groups">${groups.map((x) => `<button aria-pressed="${x.id === g.id}" data-group="${x.id}">Group ${day.groups.indexOf(x) + 1}</button>`).join("")}</div>` : "";
    const unitSeg = units.length > 1 ? `<div class="seg" role="group" aria-label="Match">${units.map((x, i) => `<button aria-pressed="${i === ui.unit[uk]}" data-unit="${i}">${esc(x.label)}</button>`).join("")}</div>` : "";
    const viewSeg = `<div class="seg" role="group" aria-label="Scorecard view">${views.map(([k, l]) => `<button aria-pressed="${ui.view === k}" data-view="${k}">${l}</button>`).join("")}</div>`;
    const left = isMatch ? u.sides[0] : u.ents, right = isMatch ? u.sides[1] : [];
    const cards = Object.fromEntries(u.ents.filter((id) => PIDX[id]).map((id) => [id, cardOf(id)]));
    const sideOf = (id) => u.sides[0].includes(id) ? 0 : 1;
    const kOf = (id) => u.sides[sideOf(id)].indexOf(id);
    const shotsAt = (id, i) => u.kind === "ambroseStroke" ? 0 : u.kind === "ambroseMatch" || ui.view === "match" ? m.holes[i].strokes[sideOf(id)][kOf(id)] : cards[id].holes[i].strokes;
    const head = (id) => `<th><span class="nm">${esc(entName(id))}</span><span class="hc">HC ${+entHcp(id).toFixed(2)}</span><span class="bar ${entTeam(id) || ""}"></span></th>`;
    const colgroup = `<colgroup><col class="hole">${left.map(() => "<col>").join("")}${isMatch ? '<col class="mid">' : ""}${right.map(() => "<col>").join("")}</colgroup>`;
    const pointsAt = (id, i) => ui.view === "match" || u.kind === "ambroseMatch" ? m.holes[i].points[sideOf(id)][kOf(id)] : cards[id].holes[i].points;
    const cell = (id, i) => {
      const h = course.holes[i];
      const s = sc(id)[i];
      let inner;
      if (ui.view === "gross") inner = marker(s, h.par);
      else {
        const p = pointsAt(id, i);
        inner = p === null ? '<span class="empty-cell">\xB7</span>' : `<span class="pts ${p === 0 ? "zero" : ""}">${p}</span>`;
      }
      let win = "";
      if (isMatch) {
        const mh = m.holes[i];
        const side = sideOf(id);
        const p = mh.points[side][kOf(id)];
        if (mh.winner === side && p !== null && p === mh.best[side] && !(m.decidedOn && h.number > m.decidedOn)) win = "win-" + u.teams[side];
      }
      return `<td class="c ${win}">${withShots(inner, shotsAt(id, i))}</td>`;
    };
    const mid = (i) => {
      const h = course.holes[i];
      const mh = m.holes[i];
      if (mh.winner === null) return '<td class="c mid"></td>';
      if (m.decidedOn && h.number > m.decidedOn) return '<td class="c mid"><span class="muted">\u2013</span></td>';
      const fin = m.decidedOn === h.number || m.finished && !m.decidedOn && h.number === 18;
      if (fin) return `<td class="c mid">${m.winner === "halved" ? chev(0, u.teams, { deep: true, text: "AS" }) : chev(m.winner === 0 ? 1 : -1, u.teams, { deep: true, text: m.resultText.replace(" and ", "&").replace(" up", " UP") })}</td>`;
      return `<td class="c mid">${chev(mh.status, u.teams)}${mh.dormie ? '<span class="dm">dormie</span>' : ""}</td>`;
    };
    const total = (id, a, b) => {
      if (ui.view === "gross") {
        let t2 = 0, any = false;
        for (let i = a; i < b; i++) {
          const v = sc(id)[i];
          if (typeof v === "number") {
            t2 += v;
            any = true;
          }
        }
        return `<td>${any ? t2 : ""}</td>`;
      }
      let t = 0;
      for (let i = a; i < b; i++) t += pointsAt(id, i) ?? 0;
      return `<td>${t}</td>`;
    };
    const ro = !canEdit(u);
    const parSum = (a, b) => course.holes.slice(a, b).reduce((t, h) => t + h.par, 0);
    const totRow = (lbl, a, b) => `<tr class="tot"><td class="h">${lbl} <span>${parSum(a, b)}</span></td>${left.map((id) => total(id, a, b)).join("")}${isMatch ? "<td></td>" : ""}${right.map((id) => total(id, a, b)).join("")}</tr>`;
    const rows = [];
    for (let i = 0; i < 18; i++) {
      const h = course.holes[i];
      const idx = u.kind === "match" && g.method === "back" && ui.view === "match" ? `M${h.matchIndexes[0]}` : h.strokeIndexes[0];
      rows.push(`<tr class="hrow ${ro ? "ro" : ""}" data-hole="${i}" tabindex="0" aria-label="Hole ${h.number}${ro ? "" : ": enter scores"}"><td class="h"><b>${h.number}</b><span>P${h.par} \xB7 ${idx}</span></td>${left.map((id) => cell(id, i)).join("")}${isMatch ? mid(i) : ""}${right.map((id) => cell(id, i)).join("")}</tr>`);
      if (i === 8) rows.push(totRow("OUT", 0, 9));
    }
    rows.push(totRow("IN", 9, 18));
    rows.push(totRow("TOT", 0, 18));
    let summary = isMatch ? `<section class="card"><h2>Match</h2><div class="pad" style="padding-top:0">${mlineHTML(u, m, { big: true })}</div>${submitHTML(u)}</section>` : `<section class="card"><h2>Sign and submit</h2>${submitHTML(u)}</section>`;
    if (u.kind.startsWith("ambrose")) {
      summary += `<section class="card"><h2>Ambrose</h2><table class="lb"><thead><tr><th>Team</th><th class="thru">Thru</th><th class="num">HC</th><th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody>${u.ents.map((id) => {
        const a = ambTeam(id);
        const c = ambroseCard(course, { name: a.name, handicaps: a.players.map((p) => PIDX[p].hcp), scores: sc(id) });
        const t = thruOf(id);
        return `<tr><td><span class="dot ${a.team || ""}"></span>${esc(a.name)}</td><td class="thru ${t === 18 ? "f" : ""}">${t === 18 ? "F" : t}</td><td class="num" style="font-weight:500">${+c.teamHandicap.toFixed(2)}</td><td class="num">${c.gross || "\u2013"}</td><td class="num">${t < 18 ? "\u2013" : c.dq ? "DQ" : +c.net.toFixed(2)}</td></tr>`;
      }).join("")}</tbody></table>${u.kind === "ambroseMatch" ? `<div class="pad small muted">Team handicaps ${m.teamHandicaps.map((v) => +v.toFixed(2)).join(" v ")}: ${Math.max(...m.strokesReceived)} shots to ${esc(m.strokesReceived[0] ? entName(u.sides[0][0]) : entName(u.sides[1][0]))} on the stroke index.</div>` : ""}</section>`;
    } else {
      summary += `<section class="card"><h2>Group ${gn} scores</h2><table class="lb"><thead><tr><th>Player</th><th class="thru">Thru</th><th class="num">Pts</th><th class="num">Gross Stab</th><th class="num">Net</th></tr></thead><tbody>${groupPlayers(g).map((id) => {
        const c = cardOf(id);
        const t = c.holesEntered;
        const pu = sc(id).some((v) => v === "P");
        const played = c.holes.filter((l) => typeof l.score === "number");
        const ntp = played.reduce((a, l) => a + l.score - l.par - l.strokes, 0);
        const gross = played.reduce((a, l) => a + l.score, 0);
        const net = pu ? "DQ" : t === 18 ? `${gross - c.handicap}` : t ? toParTxt(ntp) : "\u2013";
        return `<tr><td><span class="dot ${PIDX[id].team || ""}"></span>${esc(PIDX[id].name)}</td><td class="thru ${t === 18 ? "f" : ""}">${t === 18 ? "F" : t}</td><td class="num">${c.points}</td><td class="num">${c.grossStableford ?? "\u2013"}</td><td class="num">${net}</td></tr>`;
      }).join("")}</tbody></table></section>`;
    }
    return `${daySwitch()}<section class="card"><div class="pad coursebar"><span><b>${esc(course.name)}</b></span><span class="tee"><i></i>${esc(course.tee)} tees \xB7 Par ${course.par}</span></div></section>
  ${chips}
  <section class="card">
    <div class="ghead"><div class="t"><div><div class="eyebrow">Group ${gn} \xB7 ${esc(g.tee || "")}</div><h2>${esc(groupLabel(g))}</h2></div>${locks[u.key] ? '<span class="small" style="color:var(--ok);font-weight:600">Submitted</span>' : ""}</div>${unitSeg}${viewSeg}</div>
    <table class="sc">${colgroup}<thead><tr><th style="text-align:left;padding-left:8px">Hole</th>${left.map(head).join("")}${isMatch ? "<th>Match</th>" : ""}${right.map(head).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>
    <div class="legend"><span><span class="mk eagle">3</span>Eagle or better</span><span><span class="mk birdie">3</span>Birdie</span><span><span class="mk bogey">5</span>Bogey</span><span><span class="mk dbl">6</span>Double bogey +</span>${isMatch ? `<span><span class="sw" style="background:var(--${u.teams[0]}-soft)"></span><span class="sw" style="background:var(--${u.teams[1]}-soft)"></span>Winning score on the hole</span>` : ""}<span>${ro ? locks[u.key] ? "Scores locked" : "View only" : "Tap a hole to enter scores"}</span></div>
  </section>${summary}`;
  }
  function submitHTML(u) {
    if (locks[u.key]) return `<div class="submit"><span class="ok">Scores submitted and locked.</span><span class="small muted">If something is wrong, ask an administrator to change it.</span>${isAdmin() ? `<div><button class="btn" data-unlock="${u.key}">Unlock for changes</button></div>` : ""}</div>`;
    if (!canEdit(u)) return `<div class="submit"><span class="small muted">Only players in this ${u.kind === "individual" ? "group" : "match"} can enter and submit these scores.</span></div>`;
    const done = unitComplete(u);
    return `<div class="submit"><label class="switch"><input type="checkbox" id="ack" ${done ? "" : "disabled"}> I confirm these scores are correct</label>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" data-submit="${u.key}" disabled>Submit scores</button><span class="small muted">${done ? "Once submitted, scores are locked." : "Submit once all 18 holes are entered."}</span></div></div>`;
  }
  var hiddenNote = () => `<section class="card"><div class="pad">Leaderboards are hidden until the administrator publishes results. You can still see your own group on the Scores tab.</div></section>`;
  function viewLeaders() {
    if (!canSeeAll()) return hiddenNote();
    const day = DAY();
    const multi = tour.days.length > 1;
    const scope = multi ? ui.lbScope : "day";
    const tabs = scope === "tour" ? [["stab", "Stableford"], ["gross", "Gross Stab"]] : [["stab", "Stableford"], ["gross", "Gross Stab"], ["net", "Net"], ["amb", "Ambrose"]];
    if (!tabs.find((t) => t[0] === ui.lb)) ui.lb = "stab";
    const seg = `<div class="seg" role="group" aria-label="Leaderboard">${tabs.map(([k, l]) => `<button aria-pressed="${ui.lb === k}" data-lb="${k}">${l}</button>`).join("")}</div>`;
    const scopeSeg = multi ? `<div class="seg" role="group" aria-label="Day or tour">${[["day", esc(day.title)], ["tour", "Tour to date"]].map(([k, l]) => `<button aria-pressed="${scope === k}" data-scope="${k}">${l}</button>`).join("")}</div>` : "";
    const nm = (id) => `<span class="dot ${PIDX[id]?.team || ""}"></span>${esc(PIDX[id]?.name)}`;
    const thruTd = (t) => `<td class="thru ${t === 18 ? "f" : ""}">${t === 18 ? "F" : t}</td>`;
    const cbNote = (r) => {
      if (!ui.cb) return "";
      if (r.tiedAllCountbacks) return '<span class="note">Tied on all countbacks</span>';
      if (r.aheadOn) return `<span class="note">Ahead of ${esc(PIDX[r.aheadOn.other].name)} on countback (${esc(r.aheadOn.label)})</span>`;
      return "";
    };
    const expandable = (id, cols, rowHtml, detail) => {
      const open = ui.open["lb:" + id];
      return `<tr class="tap" data-open="lb:${id}" tabindex="0" aria-expanded="${!!open}">${rowHtml}<td class="pm">${open ? "\u2212" : "+"}</td></tr>${open ? `<tr class="detail"><td colspan="${cols + 1}">${detail()}</td></tr>` : ""}`;
    };
    let head = "", body = "", note = "";
    if (scope === "tour") {
      const playedDays = tour.days.filter((d) => teeOf(d));
      const ids = tour.players.map((p) => p.id).filter((id) => playedDays.some((d) => d.groups.some((g) => !g.format.startsWith("ambrose") && groupPlayers(g).includes(id))));
      const roundOf = (id, d) => {
        const inDay = d.groups.some((g) => !g.format.startsWith("ambrose") && groupPlayers(g).includes(id));
        if (!inDay) return null;
        const c = cardOf(id, d);
        if (!c.holesEntered) return null;
        return ui.lb === "stab" ? c.points : c.complete ? c.grossStableford : null;
      };
      const lb = aggregateLeaderboard(ids.map((id) => ({ player: id, rounds: playedDays.map((d) => roundOf(id, d)) })), ui.lb === "stab" ? "higher" : "lower");
      head = `<th>Pos</th><th>Player</th>${playedDays.map((d, i) => `<th class="num">R${i + 1}</th>`).join("")}<th class="num">Total</th><th></th>`;
      body = lb.map((r) => expandable(r.entry.player, playedDays.length + 3, `<td class="pos">${rankLabel(r)}</td><td>${nm(r.entry.player)}${r.missedRounds ? '<span class="note">Missing a round</span>' : ""}</td>${r.entry.rounds.map((v) => `<td class="num" style="font-weight:500">${v ?? "\u2013"}</td>`).join("")}<td class="num">${r.total}</td>`, () => playedDays.map((d) => `<div class="small muted" style="padding:8px 8px 0">${esc(d.title)}</div>${miniPlayer(r.entry.player, d)}`).join(""))).join("");
      note = ui.lb === "stab" ? "Total Stableford points across the tour. No countback: equal totals share the place. Anyone missing a round is listed at the bottom." : "Gross Stableford totals for finished rounds. Lower is better.";
    } else {
      const ids = day.groups.filter((g) => !g.format.startsWith("ambrose")).flatMap(groupPlayers);
      const entries = ids.map((id) => ({ player: id, card: cardOf(id) }));
      if (ui.lb === "stab") {
        const lb = liveStablefordLeaderboard(entries);
        head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Pts</th><th></th>';
        body = lb.map((r) => expandable(r.player, 4, `<td class="pos">${rankLabel(r)}</td><td>${nm(r.player)}${cbNote(r)}</td>${thruTd(r.thru)}<td class="num">${r.card.points}</td>`, () => miniPlayer(r.player))).join("");
        note = "Points through the holes played. Finished ties split on countback; anyone still playing sits below those they are level with.";
      } else if (ui.lb === "gross") {
        const lb = dayGrossStablefordLeaderboard(entries);
        head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Gross</th><th></th>';
        body = lb.map((r) => expandable(r.entry.player, 4, `<td class="pos">${rankLabel(r)}</td><td>${nm(r.entry.player)}</td>${thruTd(18)}<td class="num">${r.entry.card.grossStableford}</td>`, () => miniPlayer(r.entry.player))).join("");
        note = "Finished rounds only. Course par + handicap + (36 \u2212 points). No tie-breakers.";
      } else if (ui.lb === "net") {
        const lb = liveNetLeaderboard(entries);
        head = '<th>Pos</th><th>Player</th><th class="thru">Thru</th><th class="num">Net</th><th></th>';
        body = lb.map((r) => expandable(r.player, 4, `<td class="pos">${r.dq ? "DQ" : rankLabel(r)}</td><td>${nm(r.player)}${r.dq ? '<span class="note">Picked up</span>' : cbNote(r)}</td>${thruTd(r.thru)}<td class="num">${r.dq ? "DQ" : r.complete ? `${r.net}<span class="sub">${toParTxt(r.netToPar)}</span>` : toParTxt(r.netToPar)}</td>`, () => miniPlayer(r.player))).join("");
        note = `Relative to par while playing; total net once finished (par ${course.par}). Any pickup is DQ.`;
      } else {
        const teams = day.groups.flatMap(ambTeams).map((a) => ({ a, c: ambroseCard(course, { name: a.name, handicaps: a.players.map((id) => PIDX[id].hcp), scores: sc(a.id) }) })).filter((t) => t.c.complete);
        const lb = aggregateLeaderboard(teams.map((t) => ({ player: t.a.id, rounds: [t.c.dq ? null : t.c.net] })), "lower");
        const by = Object.fromEntries(teams.map((t) => [t.a.id, t]));
        head = '<th>Pos</th><th>Team</th><th class="thru">Thru</th><th class="num">Gross</th><th class="num">Net</th>';
        body = lb.map((r) => {
          const t = by[r.entry.player];
          return `<tr><td class="pos">${r.missedRounds ? "DQ" : rankLabel(r)}</td><td><span class="dot ${t.a.team || ""}"></span>${esc(t.a.name)}<span class="note">HC ${+t.c.teamHandicap.toFixed(2)}</span></td>${thruTd(18)}<td class="num" style="font-weight:500">${t.c.gross}</td><td class="num">${r.missedRounds ? "DQ" : +t.c.net.toFixed(2)}</td></tr>`;
        }).join("");
        note = "Finished teams only. Gross \u2212 team handicap; ties share the position.";
      }
    }
    const banner = isAdmin() && !boardsLive() ? '<div class="banner">Players cannot see leaderboards right now. You can see them as the administrator.</div>' : "";
    return `${banner}${daySwitch()}<section class="card"><div class="ghead"><div class="t"><div><div class="eyebrow">${esc(tour.title)}</div><h2>Leaderboards</h2></div>
    ${scope === "day" && (ui.lb === "stab" || ui.lb === "net") ? `<label class="switch"><input type="checkbox" id="cbt" ${ui.cb ? "checked" : ""}> Countback details</label>` : ""}</div>${scopeSeg}${seg}</div>
    <div class="pad small muted" style="padding-block:8px 4px">${note}${ui.lb !== "amb" ? " Tap a player to see their card." : ""}</div>
    <div style="overflow-x:auto"><table class="lb"><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">No scores yet.</td></tr>'}</tbody></table></div></section>`;
  }
  function viewCup() {
    if (!canSeeAll()) return hiddenNote();
    const sessions = tour.days.filter((d) => d.teamsOn !== false && teeOf(d)).map((d) => {
      const ms = d.groups.flatMap((g) => unitsOf(d, g)).filter((u) => (u.kind === "match" || u.kind === "ambroseMatch") && u.teams[0] && u.teams[1]).map((u) => ({ u, m: matchOf(u) }));
      const tot2 = [0, 0];
      ms.forEach(({ u, m }) => {
        const s = u.teams[0] === "t1" ? 0 : 1;
        tot2[0] += m.points[s];
        tot2[1] += m.points[1 - s];
      });
      return { d, ms, tot: tot2 };
    });
    const tot = sessions.reduce((t, s) => [t[0] + s.tot[0], t[1] + s.tot[1]], [0, 0]);
    const available = sessions.reduce((t, s) => t + s.ms.reduce((a, x) => a + x.u.value, 0), 0);
    const done = sessions.reduce((t, s) => t + s.ms.filter((x) => x.m.finished).length, 0), count = sessions.reduce((t, s) => t + s.ms.length, 0);
    const sess = sessions.map(({ d, ms, tot: tot2 }) => `<details class="sess" ${d.id === DAY().id ? "open" : ""}><summary><span class="pm"></span><span>${esc(d.title)} \xB7 ${fmtDate(d.date)}</span><span style="font:700 16px/1 var(--f-display)"><span style="color:var(--t1-text)">${frac(tot2[0])}</span> \u2013 <span style="color:var(--t2-text)">${frac(tot2[1])}</span></span></summary>
    ${ms.map(({ u, m }) => {
      const open = ui.open["cup:" + u.key];
      const gn = d.groups.indexOf(u.g) + 1;
      return `<div class="xrow"><button data-open="cup:${u.key}" aria-expanded="${!!open}"><span class="pm">${open ? "\u2212" : "+"}</span>
        <span><span class="small muted">Group ${gn} \xB7 ${u.value === 1 ? "1 point" : frac(u.value) + " point"}</span>${mlineHTML(u, m, { pts: true })}</span></button>
        ${open ? `<div class="det">${m.holesPlayed ? miniMatch(u, m) : '<span class="small muted">Not started.</span>'}</div>` : ""}</div>`;
    }).join("") || '<div class="pad small muted">No team matches on this day.</div>'}</details>`).join("");
    const banner = isAdmin() && !boardsLive() ? '<div class="banner">Players cannot see the Cup right now. You can see it as the administrator.</div>' : "";
    return `${banner}<section class="card">
    <div class="cup"><div class="side"><span class="tn" style="color:var(--t1-text)">${esc(tName("t1"))}</span><b style="color:var(--t1-text)">${frac(tot[0])}</b></div><div class="vs">v</div><div class="side"><span class="tn" style="color:var(--t2-text)">${esc(tName("t2"))}</span><b style="color:var(--t2-text)">${frac(tot[1])}</b></div></div>
    <div class="towin">${tour.pointsToWin} points to win \xB7 ${available} available \xB7 ${done} of ${count} matches finished</div>
    ${sess}
    <div class="legend"><span>${chev(1, ["t1", "t2"], { text: "2 UP" })} Leading</span><span>${chev(1, ["t1", "t2"], { deep: true, text: "WON" })} Won</span><span>${chev(0, ["t1", "t2"])} All square</span><span>${chev(0, ["t1", "t2"], { deep: true, text: "HALVED" })} Halved</span><span>Tap a match for hole by hole</span></div>
  </section>`;
  }
  function viewSetup() {
    const tabs = [["tour", "Tour"], ["players", "Players"], ["courses", "Courses"], ["days", "Days & groups"]];
    const seg = `<div class="seg" role="group" aria-label="Setup section">${tabs.map(([k, l]) => `<button aria-pressed="${ui.setup === k}" data-setup="${k}">${l}</button>`).join("")}</div>`;
    const body = ui.setup === "tour" ? setupTour() : ui.setup === "players" ? setupPlayers() : ui.setup === "courses" ? setupCourses() : setupDays();
    return `<section class="card"><div class="ghead"><div class="eyebrow">Administrator</div><h2>Set-up</h2>${seg}</div>${body}</section>
    <section class="card"><div class="pad" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between"><span class="small muted">Signed in as ${esc(me.email || "administrator")}.</span><span style="display:flex;gap:8px"><button class="btn" data-mytours>My tours</button><button class="btn" data-signout>Sign out</button></span></div></section>`;
  }
  function setupTour() {
    return `<div class="form">
    <div class="frow"><label for="t-title">Tour name</label><input type="text" id="t-title" data-tf="title" value="${esc(tour.title)}"></div>
    ${["t1", "t2"].map((t, i) => `<div class="frow"><label for="tn-${t}">Team ${i + 1}</label><input type="text" id="tn-${t}" value="${esc(tour.teams[t].name)}" data-teamname="${t}">
      <div class="swatches" role="group" aria-label="Team ${i + 1} colour">${SWATCHES.map(([n, c]) => `<button style="background:${c}" aria-label="${n}" title="${n}" aria-pressed="${tour.teams[t].color === c}" data-swatch="${t}" data-c="${c}"></button>`).join("")}</div></div>`).join("")}
    <div class="frow"><label for="t-ptw">Points to win the Cup</label><input type="text" inputmode="decimal" id="t-ptw" data-tf="pointsToWin" value="${tour.pointsToWin}" style="max-width:120px"></div>
    <div class="frow"><span class="lab">Live leaderboards for players</span>
      <div class="seg" role="group">${[["live", "Live"], ["hidden", "Hidden"], ["until", "Live until"]].map(([k, l]) => `<button aria-pressed="${tour.visibility === k}" data-vis="${k}">${l}</button>`).join("")}</div>
      ${tour.visibility === "until" ? `<input type="time" id="until" value="${tour.until}" aria-label="Hide leaderboards at" style="max-width:140px">` : ""}
      <span class="small muted">${tour.visibility === "hidden" ? "Players see only their own group until you publish." : tour.visibility === "until" ? `Players see live leaderboards until ${tour.until}, then only their own group.` : "Players can follow every group live."}</span></div></div>`;
  }
  function setupPlayers() {
    const rows = tour.players.map((p) => `<tr><td><input type="text" value="${esc(p.name)}" data-pf="name" data-pid="${p.id}" aria-label="Name"></td>
    <td><select data-pf="team" data-pid="${p.id}" aria-label="Team"><option value="">None</option><option value="t1" ${p.team === "t1" ? "selected" : ""}>${esc(tName("t1"))}</option><option value="t2" ${p.team === "t2" ? "selected" : ""}>${esc(tName("t2"))}</option></select></td>
    <td><input type="text" inputmode="numeric" value="${p.hcp}" data-pf="hcp" data-pid="${p.id}" aria-label="Playing handicap" style="width:52px"></td>
    <td><button class="btn sm" data-invite="${p.id}">${invites[p.id] ? "Link" : "Invite"}</button>${members[p.id] ? '<span class="joined" title="Signed in">\u2713 in</span>' : ""}</td></tr>
    ${ui.open["inv:" + p.id] && invites[p.id] ? `<tr><td colspan="4"><div class="invite"><span class="small">Text this link to ${esc(p.name)}. Tapping it signs them in on their phone.</span><code>${esc(inviteUrl(p))}</code><div style="display:flex;gap:8px"><button class="btn sm" data-copy="${p.id}">Copy link</button><button class="btn sm" data-reinvite="${p.id}">New link</button></div></div></td></tr>` : ""}`).join("");
    return `<div class="pad small muted" style="padding-bottom:0">Nicknames are what everyone sees. Handicap is the playing handicap for this tour. ${tour.players.length} players.</div>
    <div style="overflow-x:auto"><table class="lb ed"><thead><tr><th>Name</th><th>Team</th><th>HC</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="form" style="padding-top:12px"><div class="frow"><label for="np">Add a player</label><div style="display:flex;gap:8px"><input type="text" id="np" placeholder="Nickname"><button class="btn" id="addp">Add</button></div></div></div>`;
  }
  var inviteUrl = (p) => `${location.origin}${location.pathname}#t=${tourId}&join=${invites[p.id]}`;
  function setupCourses() {
    const list = tour.courses.map((c) => c.tees.map((t) => {
      const open = ui.open["crs:" + c.id + t.id];
      return `<div class="xrow"><button data-open="crs:${c.id}${t.id}" aria-expanded="${!!open}"><span class="pm">${open ? "\u2212" : "+"}</span><span><b>${esc(c.name)}</b> <span class="tee" style="--tee:${t.colour}"><i style="background:${t.colour}"></i>${esc(t.name)} \xB7 Par ${t.holes.reduce((a, h) => a + h.par, 0)}</span></span></button>
      ${open ? `<div class="det" style="overflow-x:auto"><table class="mini holes"><tr class="hd"><th>Hole</th><th>Par</th><th>Index</th><th>19-36</th><th>37-54</th><th>Match</th></tr>${t.holes.map((h) => `<tr><td>${h.number}</td><td>${h.par}</td><td>${h.strokeIndexes[0]}</td><td>${h.strokeIndexes[1] ?? ""}</td><td>${h.strokeIndexes[2] ?? ""}</td><td>${h.matchIndexes[0]}</td></tr>`).join("")}</table></div>` : ""}</div>`;
    }).join("")).join("");
    const err = ui.courseErr ? `<div class="banner" style="margin:0">${esc(ui.courseErr)}</div>` : "";
    return `<div class="pad small muted" style="padding-bottom:6px">Your course library. Each day picks a course and tee from here.</div>${list}
    <div class="form" style="padding-top:14px;border-top:1px solid var(--rule)"><span class="lab" style="font-weight:700">Add a course and tee</span>
      <div class="frow"><label for="cn">Course</label><input type="text" id="cn" list="courselist" placeholder="e.g. Barnbougle Lost Farm"><datalist id="courselist">${tour.courses.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist></div>
      <div class="frow"><label for="ctn">Tee</label><div style="display:flex;gap:8px;align-items:center"><input type="text" id="ctn" placeholder="e.g. Blue"><select id="ctc" aria-label="Tee colour">${[["Blue", "#2a5fb0"], ["White", "#f4f4f4"], ["Black", "#26292e"], ["Red", "#c8372d"], ["Gold", "#f2b705"], ["Green", "#00843d"]].map(([n, c]) => `<option value="${c}">${n}</option>`).join("")}</select></div></div>
      <div class="frow"><label for="cpaste">Paste 18 rows from your hole-index workbook</label>
        <span class="small muted">One row per hole, in order: Par, Index (1-18), then optionally Index 19-36, Index 37-54 and the Match play index. Copy the cells in Excel and paste here.</span>
        <textarea id="cpaste" rows="6" placeholder="4	1	19	37	18&#10;4	3	22	40	8&#10;\u2026"></textarea></div>
      ${err}<div><button class="btn primary" id="addc">Check and add</button></div></div>`;
  }
  function parseHoles(text) {
    const rows = text.trim().split(/\r?\n/).map((r) => r.trim()).filter(Boolean).map((r) => r.split(/[\t,; ]+/).map(Number));
    if (rows.length !== 18) throw new Error(`Found ${rows.length} rows; there must be 18, one per hole.`);
    rows.forEach((r, i) => {
      if (r.length < 2 || r.some(isNaN)) throw new Error(`Row ${i + 1} needs at least a par and an index (numbers only).`);
      if (r[0] < 3 || r[0] > 6) throw new Error(`Row ${i + 1}: par ${r[0]} looks wrong.`);
    });
    const perm = (col, lo) => {
      const v = rows.map((r) => r[col]);
      if (v.some((x) => x === void 0)) return null;
      const s = [...v].sort((a, b) => a - b);
      return s.every((x, i) => x === lo + i) ? v : "bad";
    };
    const i1 = perm(1, 1);
    if (i1 === "bad") throw new Error("The index column must use each number 1 to 18 once.");
    const i2 = perm(2, 19);
    if (i2 === "bad") throw new Error("The 19-36 column must use each number 19 to 36 once.");
    const i3 = perm(3, 37);
    if (i3 === "bad") throw new Error("The 37-54 column must use each number 37 to 54 once.");
    const mi = perm(4, 1);
    if (mi === "bad") throw new Error("The match play column must use each number 1 to 18 once.");
    return rows.map((r, i) => ({ number: i + 1, par: r[0], strokeIndexes: [r[1], ...i2 ? [r[2]] : [], ...i3 ? [r[3]] : []], matchIndexes: [mi ? r[4] : r[1]] }));
  }
  function setupDays() {
    const crsOpts = (d) => tour.courses.flatMap((c) => c.tees.map((t) => `<option value="${c.id}|${t.id}" ${d.courseId === c.id && d.teeId === t.id ? "selected" : ""}>${esc(c.name)} \xB7 ${esc(t.name)}</option>`)).join("");
    return tour.days.map((d) => {
      const open = ui.open["day:" + d.id] ?? d.id === DAY().id;
      const check = assignmentCheck(d);
      return `<div class="xrow"><button data-open="day:${d.id}" aria-expanded="${!!open}"><span class="pm">${open ? "\u2212" : "+"}</span><span><b>${esc(d.title)}</b> \xB7 ${fmtDate(d.date)} <span class="small muted">${d.groups.length} groups</span></span></button>
    ${open ? `<div class="form">
      <div class="two"><div class="frow"><label>Name</label><input type="text" value="${esc(d.title)}" data-df="title" data-did="${d.id}"></div><div class="frow"><label>Date</label><input type="date" value="${d.date}" data-df="date" data-did="${d.id}"></div></div>
      <div class="frow"><label>Course and tee</label><select data-df="course" data-did="${d.id}"><option value="">Choose\u2026</option>${crsOpts(d)}</select></div>
      <label class="switch"><input type="checkbox" data-df="teamsOn" data-did="${d.id}" ${d.teamsOn !== false ? "checked" : ""}> Matches count towards the ${esc(tName("t1"))} v ${esc(tName("t2"))} Cup</label>
      <div class="frow"><label>Briefing</label><textarea rows="3" data-df="briefing" data-did="${d.id}" placeholder="Meeting time, format, nearest the pins\u2026">${esc(d.briefing || "")}</textarea></div>
      <div class="frow"><span class="lab">Groups</span>${check}</div>
      ${d.groups.map((g, i) => groupEditor(d, g, i)).join("")}
      <div><button class="btn" data-addgroup="${d.id}">Add group</button></div></div>` : ""}</div>`;
    }).join("") + `<div class="pad"><button class="btn primary" id="addday">Add a day</button></div>`;
  }
  function assignmentCheck(d) {
    const counts = {};
    d.groups.forEach((g) => groupPlayers(g).forEach((id) => counts[id] = (counts[id] || 0) + 1));
    const dup = Object.keys(counts).filter((id) => counts[id] > 1).map((id) => PIDX[id]?.name);
    const missing = tour.players.filter((p) => !counts[p.id]).map((p) => p.name);
    if (!dup.length && !missing.length) return `<span class="small" style="color:var(--ok);font-weight:600">Every player is in exactly one group.</span>`;
    return `<div class="banner" style="margin:0">${dup.length ? `In more than one group: ${dup.map(esc).join(", ")}. ` : ""}${missing.length ? `Not in a group: ${missing.map(esc).join(", ")}.` : ""}</div>`;
  }
  function groupEditor(d, g, i) {
    const f = FORMATS[g.format];
    const used = new Set(d.groups.flatMap(groupPlayers));
    const slot = (side, k) => {
      const v = g.slots[side][k] || "";
      return `<select data-slot="${side}${k}" data-did="${d.id}" data-gid="${g.id}" aria-label="Player"><option value="">\u2014</option>${tour.players.map((p) => `<option value="${p.id}" ${p.id === v ? "selected" : ""}>${esc(p.name)}${used.has(p.id) && p.id !== v ? " \u2713" : ""}</option>`).join("")}</select>`;
    };
    const sideA = Array.from({ length: f.a }, (_, k) => slot("a", k)).join("");
    const sideB = Array.from({ length: f.b }, (_, k) => slot("b", k)).join("");
    return `<div class="gedit"><div class="ghd"><b>Group ${i + 1}</b><input type="text" value="${esc(g.tee || "")}" data-gf="tee" data-did="${d.id}" data-gid="${g.id}" aria-label="Tee time" placeholder="Tee time" style="width:80px"><button class="btn sm" data-delgroup="${g.id}" data-did="${d.id}" aria-label="Remove group ${i + 1}">Remove</button></div>
    <div class="two"><select data-gf="format" data-did="${d.id}" data-gid="${g.id}" aria-label="Format">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === g.format ? "selected" : ""}>${v.label}</option>`).join("")}</select>
    ${f.match ? `<div style="display:flex;gap:6px">${g.format !== "ambroseMatch" ? `<select data-gf="method" data-did="${d.id}" data-gid="${g.id}" aria-label="Handicap method"><option value="front" ${g.method !== "back" ? "selected" : ""}>Front of card</option><option value="back" ${g.method === "back" ? "selected" : ""}>Back of card</option></select>` : ""}
      <select data-gf="value" data-did="${d.id}" data-gid="${g.id}" aria-label="Points per match"><option value="1" ${g.value === 1 ? "selected" : ""}>1 pt</option><option value="0.5" ${g.value === 0.5 ? "selected" : ""}>\xBD pt</option></select></div>` : "<span></span>"}</div>
    ${f.match ? `<div class="slots"><div>${sideA}</div><span class="v">v</span><div>${sideB}</div></div><span class="small muted">${g.format === "singles" ? "Top left plays top right; bottom left plays bottom right." : g.format === "twoVone" ? "Both players on the left each play the single player on the right." : "Left pair v right pair."}</span>` : `<div class="slots one">${sideA}</div>`}</div>`;
  }
  function curUnit() {
    const day = DAY();
    const g = day.groups.find((x) => x.id === ui.group);
    return unitsOf(day, g)[ui.unit[day.id + ":" + g.id] || 0];
  }
  function openEntry(i) {
    const u = curUnit();
    if (!canEdit(u)) {
      toast(locks[u.key] ? "Scores are locked. Ask an administrator to make a change." : "You can only enter scores for your own match.");
      return;
    }
    ui.entry = { i, draft: Object.fromEntries(u.ents.map((id) => [id, sc(id)[i] ?? course.holes[i].par])) };
    renderSheet();
  }
  function renderSheet() {
    const box = document.getElementById("overlay");
    if (!ui.entry) {
      box.innerHTML = "";
      return;
    }
    const u = curUnit();
    const { i, draft } = ui.entry;
    const h = course.holes[i];
    const order = u.sides ? [...u.sides[0], ...u.sides[1]] : u.ents;
    box.innerHTML = `<div class="scrim" data-cancel></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Scores for hole ${h.number}"><div class="in">
    <div class="hd"><h3>Hole ${h.number}</h3><span class="muted small">Par ${h.par} \xB7 Index ${h.strokeIndexes[0]} \xB7 ${esc(u.label)}</span></div>
    ${order.map((id) => {
      const v = draft[id];
      const isP = v === "P";
      const team = !PIDX[id];
      const shots = team ? 0 : strokesOnHole(PIDX[id].hcp, h.strokeIndexes);
      return `<div class="erow"><div class="nm"><span class="dot ${entTeam(id) || ""}"></span>${esc(entName(id))}<small>${team ? "Team score" : `HC ${PIDX[id].hcp}${shots ? ` \xB7 ${shots} shot${shots > 1 ? "s" : ""}` : ""}`}</small></div>
        <div class="stepper"><button data-step="-1" data-id="${id}" aria-label="One less for ${esc(entName(id))}" ${isP ? "disabled" : ""}>\u2212</button>
        <span class="val">${isP ? '<span class="mk pu">P</span>' : marker(v, h.par)}</span>
        <button data-step="1" data-id="${id}" aria-label="One more for ${esc(entName(id))}" ${isP ? "disabled" : ""}>+</button>
        <button class="p" data-pu="${id}" aria-pressed="${isP}" aria-label="Pickup for ${esc(entName(id))}">P</button></div></div>`;
    }).join("")}
    <div class="acts"><button class="btn" data-cancel>Cancel</button><button class="btn" data-clear>Clear</button><button class="btn primary" data-save>Save</button></div>
  </div></div>`;
  }
  var hashParams = () => Object.fromEntries(location.hash.replace(/^#/, "").split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
  var isRealAdmin = () => !!(me && tour && (tour.adminUids || []).includes(me.uid));
  var errText = (e) => e && e.code === "permission-denied" ? "You do not have permission to do that." : e && e.code === "unavailable" ? "No signal: it will sync when you are back in range." : e && e.message || "Something went wrong.";
  function accessMap(t) {
    const a = {};
    for (const d of t.days) {
      a[d.id] = {};
      for (const g of d.groups) {
        [...g.slots.a, ...g.slots.b].filter(Boolean).forEach((id) => a[d.id][id] = g.id);
        if (g.format === "ambroseMatch") (g.ambIds || [g.id + "-a", g.id + "-b"]).forEach((id) => a[d.id][id] = g.id);
        if (g.format === "ambroseStroke") (g.ambIds || [g.id + "-t"]).forEach((id) => a[d.id][id] = g.id);
      }
    }
    return a;
  }
  var tourForSave = (t) => {
    const c = clone(t);
    delete c.access;
    return c;
  };
  var tourTimer = null;
  function queueTourSave() {
    clearTimeout(tourTimer);
    tourTimer = setTimeout(() => {
      const data = tourForSave(tour);
      data.access = accessMap(tour);
      fb.set(`tours/${tourId}`, data).catch((e) => toast("Set-up not saved: " + errText(e)));
    }, 350);
  }
  function unitKeyFor(dayId, ent) {
    const day = dayById(dayId);
    if (!day) return "";
    for (const g of day.groups) {
      const u = unitsOf(day, g).find((x) => x.ents.includes(ent));
      if (u) return u.key;
    }
    return "";
  }
  function syncOut() {
    if (!tourId || !tour) return;
    if (isRealAdmin() && JSON.stringify(tourForSave(tour)) !== JSON.stringify(tourForSave(server.tour))) {
      server.tour = clone(tour);
      queueTourSave();
    }
    const acc = accessMap(tour);
    for (const [dayId, ents] of Object.entries(scores)) for (const [ent, holes] of Object.entries(ents)) {
      if (JSON.stringify(server.scores[dayId]?.[ent]) === JSON.stringify(holes)) continue;
      (server.scores[dayId] = server.scores[dayId] || {})[ent] = clone(holes);
      fb.set(`tours/${tourId}/scores/${dayId}_${ent}`, { dayId, ent, holes, groupId: acc[dayId]?.[ent] || "", unitKey: unitKeyFor(dayId, ent), by: me.uid, at: fb.now() }).catch((e) => {
        toast("Score not saved: " + errText(e));
      });
    }
    for (const k of Object.keys(locks)) if (!server.locks[k]) {
      server.locks[k] = locks[k];
      const [dayId, groupId] = k.split(":");
      fb.set(`tours/${tourId}/locks/${k}`, { dayId, groupId, by: me.uid, at: fb.now() }).catch((e) => toast("Not submitted: " + errText(e)));
    }
    for (const k of Object.keys(server.locks)) if (!locks[k]) {
      delete server.locks[k];
      fb.del(`tours/${tourId}/locks/${k}`).catch((e) => toast("Not unlocked: " + errText(e)));
    }
  }
  var pendingRender = false;
  function safeRender() {
    const a = document.activeElement;
    if (a && a.closest && a.closest("#view") && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" && /text|date|time|number/.test(a.type))) {
      pendingRender = true;
      return;
    }
    render();
  }
  document.addEventListener("focusout", () => setTimeout(() => {
    if (pendingRender) {
      pendingRender = false;
      safeRender();
    }
  }, 0));
  function stopWatching() {
    unsubs.forEach((u) => u && u());
    unsubs = [];
  }
  function openTour(id) {
    stopWatching();
    tourId = id;
    tour = null;
    scores = {};
    locks = {};
    invites = {};
    members = {};
    server.tour = null;
    server.scores = {};
    server.locks = {};
    store(":tour", id);
    gate = { state: "loading" };
    render();
    unsubs.push(fb.watchDoc(`tours/${id}`, (data, meta) => {
      if (!data) {
        gate = { state: "error", msg: "This tour could not be found, or you do not have access to it." };
        render();
        return;
      }
      tour = data;
      server.tour = clone(data);
      sync.cached = meta.cached;
      if (isRealAdmin() && !unsubs.adminWatch) startAdminWatch();
      gate = { state: "ready" };
      safeRender();
    }, (e) => {
      gate = { state: "error", msg: errText(e) };
      render();
    }));
    unsubs.push(fb.watchColl(`tours/${id}/scores`, (docs, meta) => {
      const s = {};
      docs.forEach(({ data }) => (s[data.dayId] = s[data.dayId] || {})[data.ent] = data.holes);
      scores = s;
      server.scores = clone(s);
      sync.pending = meta.pending;
      sync.cached = meta.cached;
      if (tour) safeRender();
    }, () => {
    }));
    unsubs.push(fb.watchColl(`tours/${id}/locks`, (docs) => {
      const l = {};
      docs.forEach(({ id: k, data }) => l[k] = data);
      locks = l;
      server.locks = clone(l);
      if (tour) safeRender();
    }, () => {
    }));
  }
  function startAdminWatch() {
    unsubs.adminWatch = true;
    unsubs.push(fb.watchColl(`tours/${tourId}/invites`, (docs) => {
      const m = {};
      docs.forEach(({ id: t, data }) => m[data.playerId] = t);
      invites = m;
      if (tour) safeRender();
    }, () => {
    }));
    unsubs.push(fb.watchColl(`tours/${tourId}/members`, (docs) => {
      const m = {};
      docs.forEach(({ data }) => m[data.playerId] = (m[data.playerId] || 0) + 1);
      members = m;
      if (tour) safeRender();
    }, () => {
    }));
  }
  async function claimInvite(tid, tok) {
    gate = { state: "joining" };
    render();
    try {
      if (!me) me = await fb.signInAnon();
      const existing = await fb.get(`tours/${tid}/members/${me.uid}`).catch(() => null);
      if (!existing) {
        const inv = await fb.get(`tours/${tid}/invites/${tok}`);
        if (!inv) throw new Error("This invite link is no longer valid. Ask your administrator for a new one.");
        await fb.set(`tours/${tid}/members/${me.uid}`, { playerId: inv.playerId, token: tok, at: fb.now() });
        myPlayerId = inv.playerId;
      } else myPlayerId = existing.playerId;
      store(":me:" + tid, myPlayerId);
      openTour(tid);
    } catch (e) {
      gate = { state: "error", msg: errText(e) };
      render();
    }
  }
  async function showMyTours() {
    gate = { state: "tours", tours: null };
    render();
    try {
      gate = { state: "tours", tours: await fb.adminTours(me.uid) };
    } catch (e) {
      gate = { state: "tours", tours: [], err: errText(e) };
    }
    render();
  }
  async function createTour(demo) {
    const id = fb.newId();
    const base = demo ? clone(demo_seed_default.tour) : {
      title: "New tour",
      teams: { t1: { name: "Red", color: "#c8372d" }, t2: { name: "Blue", color: "#2a5fb0" } },
      pointsToWin: 0,
      visibility: "live",
      until: "12:30",
      players: [],
      courses: clone(demo_seed_default.tour.courses),
      days: [{ id: "d1", title: "Day 1", date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), courseId: demo_seed_default.tour.courses[0].id, teeId: demo_seed_default.tour.courses[0].tees[0].id, teamsOn: true, briefing: "", groups: [] }]
    };
    base.adminUids = [me.uid];
    base.access = accessMap(base);
    try {
      await fb.set(`tours/${id}`, base);
      if (demo) {
        const items = [];
        for (const [dayId, ents] of Object.entries(demo_seed_default.scores)) for (const [ent, holes] of Object.entries(ents))
          items.push({ path: `tours/${id}/scores/${dayId}_${ent}`, data: { dayId, ent, holes, groupId: base.access[dayId][ent] || "", unitKey: "", by: me.uid, at: fb.now() } });
        await fb.batchSet(items);
      }
      location.hash = "t=" + id;
      openTour(id);
    } catch (e) {
      toast("Could not create the tour: " + errText(e));
    }
  }
  function viewGate() {
    const card = (title, body) => `<section class="card"><h2>${title}</h2><div class="pad" style="padding-top:0;display:grid;gap:12px">${body}</div></section>`;
    if (gate.state === "loading") return card("Loading\u2026", '<span class="muted">Getting the latest scores.</span>');
    if (gate.state === "joining") return card("Joining the tour\u2026", '<span class="muted">Signing you in on this phone.</span>');
    if (gate.state === "error") return card("Something is not right", `<span>${esc(gate.msg)}</span><div style="display:flex;gap:8px;flex-wrap:wrap">${me && !me.anonymous ? '<button class="btn" data-mytours>My tours</button>' : ""}<button class="btn" data-signout>Sign out</button></div>`);
    if (gate.state === "tours") {
      const list = gate.tours === null ? '<span class="muted">Loading your tours\u2026</span>' : gate.tours.length ? gate.tours.map((t) => `<button class="btn" style="text-align:left" data-opentour="${t.id}"><b>${esc(t.data.title)}</b> <span class="muted small">${t.data.players.length} players \xB7 ${t.data.days.length} day${t.data.days.length === 1 ? "" : "s"}</span></button>`).join("") : '<span class="muted">You have no tours yet.</span>';
      return card("My tours", `<span class="small muted">Signed in as ${esc(me.email || me.name || "administrator")}.</span>${gate.err ? `<div class="banner">${esc(gate.err)}</div>` : ""}${list}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-newtour="blank">Create a new tour</button><button class="btn" data-newtour="demo">Create a demo tour</button><button class="btn" data-signout>Sign out</button></div>
      <span class="small muted">The demo tour has the example players, groups and scores, so you can try everything with real phones.</span>`);
    }
    return card("Golf Tour Scorer", `<span>Players: open the personal link your tour administrator sent you. It signs you in on this phone.</span>
    <span class="small muted">Lost your link? Ask the administrator to send it again.</span>
    <div><button class="btn primary" data-gsignin>Administrator sign-in with Google</button></div>`);
  }
  function syncPill() {
    if (!tourId || !tour) return "";
    if (!navigator.onLine || sync.cached) return '<span class="pill-sync off">Offline \xB7 saved on this phone</span>';
    if (sync.pending) return '<span class="pill-sync">Syncing\u2026</span>';
    return "";
  }
  window.addEventListener("online", () => safeRender());
  window.addEventListener("offline", () => safeRender());
  function boot() {
    const h = hashParams();
    fb.onAuth(async (u) => {
      me = u;
      if (h.join && h.t) {
        const known = load(":me:" + h.t, null);
        if (me && known) {
          myPlayerId = known;
          openTour(h.t);
        } else claimInvite(h.t, h.join);
        return;
      }
      if (!me) {
        gate = { state: "landing" };
        render();
        return;
      }
      const tid = h.t || load(":tour", null);
      if (me.anonymous) {
        if (tid) {
          myPlayerId = load(":me:" + tid, null);
          openTour(tid);
        } else {
          gate = { state: "landing" };
          render();
        }
        return;
      }
      if (tid) openTour(tid);
      else showMyTours();
    });
  }
  var ICONS = {
    day: '<svg viewBox="0 0 24 24"><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></svg>',
    scores: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17M9.5 3.5v17"/></svg>',
    leaders: '<svg viewBox="0 0 24 24"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
    cup: '<svg viewBox="0 0 24 24"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 20h8"/></svg>',
    setup: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>'
  };
  function measure() {
    document.documentElement.style.setProperty("--toph", document.getElementById("top").offsetHeight + "px");
  }
  function render() {
    const tb0 = document.getElementById("tabs");
    if (gate.state !== "ready" || !tour) {
      document.getElementById("who").innerHTML = esc(me && !me.anonymous ? me.email || "Administrator" : "");
      document.getElementById("view").innerHTML = viewGate();
      tb0.innerHTML = "";
      document.querySelector(".tabs").hidden = true;
      measure();
      return;
    }
    document.querySelector(".tabs").hidden = false;
    PIDX = P();
    if (!isRealAdmin()) ui.as = myPlayerId || "__none";
    if (!dayById(ui.day)) ui.day = tour.days[0].id;
    if (ui.tab === "setup" && !isAdmin()) ui.tab = "day";
    course = teeOf(DAY());
    applyTeams();
    document.getElementById("who").innerHTML = `${esc(isAdmin() ? "Administrator" : PIDX[ui.as]?.name || "Viewer")}<br>${esc(tour.title)}${syncPill()}`;
    const v = document.getElementById("view");
    v.innerHTML = ui.tab === "day" ? viewDay() : ui.tab === "scores" ? viewScores() : ui.tab === "leaders" ? viewLeaders() : ui.tab === "cup" ? viewCup() : viewSetup();
    const tabs = [["day", "Day"], ["scores", "Scores"], ["leaders", "Leaders"], ["cup", "Cup"], ...isAdmin() ? [["setup", "Setup"]] : []];
    const tb = document.getElementById("tabs");
    tb.style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;
    tb.innerHTML = tabs.map(([k, l]) => `<button data-tab="${k}" ${ui.tab === k ? 'aria-current="page"' : ""}>${ICONS[k]}${l}</button>`).join("");
    measure();
    persist();
    syncOut();
  }
  function findGroup(did, gid) {
    return dayById(did).groups.find((g) => g.id === gid);
  }
  window.addEventListener("resize", measure);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, tr.hrow, tr.tap, [data-cancel]");
    if (!t) return;
    const d = t.dataset;
    if (d.tab) {
      ui.tab = d.tab;
      render();
      window.scrollTo(0, 0);
    } else if (d.day) {
      ui.day = d.day;
      ui.group = (myGroup() || DAY().groups[0] || {}).id;
      render();
    } else if (d.go) {
      const g = DAY().groups.find((x) => x.id === d.go);
      if (!canSeeGroup(g)) {
        toast("Other groups are hidden until results are published.");
        return;
      }
      ui.group = d.go;
      ui.tab = "scores";
      render();
      window.scrollTo(0, 0);
    } else if (d.group) {
      ui.group = d.group;
      render();
    } else if (d.unit) {
      ui.unit[DAY().id + ":" + ui.group] = +d.unit;
      render();
    } else if (d.view) {
      ui.view = d.view;
      render();
    } else if (d.lb) {
      ui.lb = d.lb;
      render();
    } else if (d.scope) {
      ui.lbScope = d.scope;
      render();
    } else if (d.setup) {
      ui.setup = d.setup;
      ui.courseErr = null;
      render();
    } else if (d.open) {
      ui.open[d.open] = !(ui.open[d.open] ?? d.open === "day:" + DAY().id);
      render();
    } else if (d.vis) {
      tour.visibility = d.vis;
      render();
    } else if (d.swatch) {
      tour.teams[d.swatch].color = d.c;
      render();
    } else if (d.unlock) {
      delete locks[d.unlock];
      render();
      toast("Unlocked. Players in the match can now edit.");
    } else if (d.submit) {
      if (!document.getElementById("ack")?.checked) return;
      locks[d.submit] = { at: Date.now(), by: me.uid };
      render();
      toast("Scores submitted and locked.");
    } else if (d.invite) {
      const pid = d.invite;
      ui.open["inv:" + pid] = !ui.open["inv:" + pid];
      if (!invites[pid]) {
        const tk = token();
        invites[pid] = tk;
        fb.set(`tours/${tourId}/invites/${tk}`, { playerId: pid, at: fb.now() }).catch((err) => toast("Invite not saved: " + errText(err)));
      }
      render();
    } else if (d.reinvite) {
      const pid = d.reinvite;
      const old = invites[pid];
      const tk = token();
      invites[pid] = tk;
      fb.set(`tours/${tourId}/invites/${tk}`, { playerId: pid, at: fb.now() }).then(() => old && fb.del(`tours/${tourId}/invites/${old}`)).catch((err) => toast("Invite not saved: " + errText(err)));
      render();
      toast("New link made. The old link no longer works for new phones.");
    } else if (d.copy) {
      const p = tour.players.find((x) => x.id === d.copy);
      const txt = inviteUrl(p);
      try {
        navigator.clipboard.writeText(txt).then(() => toast("Link copied."), () => toast("Select the link and copy it."));
      } catch (err) {
        toast("Select the link and copy it.");
      }
    } else if (t.id === "addp") {
      const n = document.getElementById("np").value.trim();
      if (!n) return;
      tour.players.push({ id: uid("p"), name: n, team: null, hcp: 18 });
      render();
      toast(`${n} added. Set their team and handicap.`);
    } else if (t.id === "addc") {
      const cn = document.getElementById("cn").value.trim(), tn = document.getElementById("ctn").value.trim(), col = document.getElementById("ctc").value, txt = document.getElementById("cpaste").value;
      try {
        if (!cn || !tn) throw new Error("Enter the course name and the tee.");
        const holes = parseHoles(txt);
        let c = tour.courses.find((x) => x.name.toLowerCase() === cn.toLowerCase());
        if (!c) {
          c = { id: uid("c"), name: cn, tees: [] };
          tour.courses.push(c);
        }
        if (c.tees.find((x) => x.name.toLowerCase() === tn.toLowerCase())) throw new Error(`${cn} already has a ${tn} tee.`);
        c.tees.push({ id: uid("t"), name: tn, colour: col, holes });
        ui.courseErr = null;
        render();
        toast(`${cn} \xB7 ${tn} added: par ${holes.reduce((a, h) => a + h.par, 0)}.`);
      } catch (err) {
        ui.courseErr = err.message;
        render();
        document.getElementById("cpaste").value = txt;
        document.getElementById("cn").value = cn;
        document.getElementById("ctn").value = tn;
      }
    } else if (t.id === "addday") {
      const last = tour.days[tour.days.length - 1];
      const nd = /* @__PURE__ */ new Date(last.date + "T00:00");
      nd.setDate(nd.getDate() + 1);
      const day = { id: uid("d"), title: "Day " + (tour.days.length + 1), date: nd.toISOString().slice(0, 10), courseId: last.courseId, teeId: last.teeId, teamsOn: true, briefing: "", groups: [] };
      tour.days.push(day);
      ui.open["day:" + day.id] = true;
      render();
      toast(`${day.title} added.`);
    } else if (d.addgroup) {
      const day = dayById(d.addgroup);
      day.groups.push({ id: uid("g"), tee: "", format: "fourball", method: "front", value: 1, slots: { a: [], b: [] } });
      render();
    } else if (d.delgroup) {
      const day = dayById(d.did);
      day.groups = day.groups.filter((g) => g.id !== d.delgroup);
      render();
    } else if ("gsignin" in d) {
      fb.signInGoogle().then((u) => {
        me = u;
        showMyTours();
      }).catch((err) => toast("Sign-in did not complete: " + errText(err)));
    } else if ("signout" in d) {
      stopWatching();
      tourId = null;
      tour = null;
      store(":tour", null);
      fb.signOut().then(() => {
        location.hash = "";
        gate = { state: "landing" };
        render();
      });
    } else if ("mytours" in d) {
      stopWatching();
      tourId = null;
      tour = null;
      store(":tour", null);
      location.hash = "";
      showMyTours();
    } else if (d.opentour) {
      location.hash = "t=" + d.opentour;
      openTour(d.opentour);
    } else if (d.newtour) {
      createTour(d.newtour === "demo");
    } else if (t.classList.contains("hrow")) openEntry(+d.hole);
    else if ("cancel" in d) {
      ui.entry = null;
      renderSheet();
    } else if (d.step) {
      const cur = ui.entry.draft[d.id];
      ui.entry.draft[d.id] = Math.min(15, Math.max(1, (typeof cur === "number" ? cur : course.holes[ui.entry.i].par) + +d.step));
      renderSheet();
    } else if (d.pu) {
      const cur = ui.entry.draft[d.pu];
      ui.entry.draft[d.pu] = cur === "P" ? course.holes[ui.entry.i].par : "P";
      renderSheet();
    } else if ("clear" in d) {
      const s = daySc(DAY().id);
      for (const id of Object.keys(ui.entry.draft)) (s[id] = s[id] || Array(18).fill(null))[ui.entry.i] = null;
      ui.entry = null;
      renderSheet();
      render();
    } else if ("save" in d) {
      const s = daySc(DAY().id);
      for (const [id, v] of Object.entries(ui.entry.draft)) (s[id] = s[id] || Array(18).fill(null))[ui.entry.i] = v;
      ui.entry = null;
      renderSheet();
      render();
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    const d = t.dataset;
    if (t.id === "as") {
      ui.as = t.value;
      const g = myGroup();
      if (g) ui.group = g.id;
      ui.unit = {};
      render();
    } else if (t.id === "until") {
      tour.until = t.value || "12:30";
      render();
    } else if (t.id === "cbt") {
      ui.cb = t.checked;
      render();
    } else if (t.id === "ack") {
      const b = document.querySelector("[data-submit]");
      if (b) b.disabled = !t.checked;
    } else if (d.teamname) {
      tour.teams[d.teamname].name = t.value.trim() || (d.teamname === "t1" ? "Team 1" : "Team 2");
      render();
    } else if (d.tf) {
      if (d.tf === "pointsToWin") {
        const n = parseFloat(t.value);
        if (!isNaN(n)) tour.pointsToWin = n;
      } else tour[d.tf] = t.value;
      render();
    } else if (d.pf) {
      const p = tour.players.find((x) => x.id === d.pid);
      if (d.pf === "hcp") {
        const n = parseInt(t.value, 10);
        if (!isNaN(n)) p.hcp = n;
      } else if (d.pf === "team") p.team = t.value || null;
      else p.name = t.value.trim() || p.name;
      render();
    } else if (d.df) {
      const day = dayById(d.did);
      if (d.df === "course") {
        const [c, te] = t.value.split("|");
        day.courseId = c || null;
        day.teeId = te || null;
      } else if (d.df === "teamsOn") day.teamsOn = t.checked;
      else day[d.df] = t.value;
      render();
    } else if (d.gf) {
      const g = findGroup(d.did, d.gid);
      if (d.gf === "value") g.value = parseFloat(t.value);
      else if (d.gf === "format") {
        g.format = t.value;
        const f = FORMATS[g.format];
        g.slots.a = g.slots.a.slice(0, f.a);
        g.slots.b = g.slots.b.slice(0, f.b);
        if (g.format === "twoVone") g.value = 0.5;
        if (g.format.startsWith("ambrose") && !g.ambIds) g.ambIds = g.format === "ambroseMatch" ? [g.id + "-a", g.id + "-b"] : [g.id + "-t"];
      } else g[d.gf] = t.value;
      render();
    } else if (d.slot) {
      const g = findGroup(d.did, d.gid);
      const side = d.slot[0], k = +d.slot.slice(1);
      g.slots[side][k] = t.value || null;
      render();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.entry) {
      ui.entry = null;
      renderSheet();
    }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr.hrow, tr.tap")) {
      e.preventDefault();
      e.target.click();
    }
  });
  boot();
})();
