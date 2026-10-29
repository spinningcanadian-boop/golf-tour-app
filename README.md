# Golf Tour App

A phone-first web app for scoring golf tours: hole-by-hole Stableford and stroke scoring, team match play (4-ball, singles, 2 v 1, Ambrose), live leaderboards and a Ryder Cup-style team panel.

**Live app:** https://spinningcanadian-boop.github.io/golf-tour-app/ (once GitHub Pages is switched on)

## How it fits together
- `engine/` – the scoring engine (TypeScript) and its 39 tests. Run `npm test`. `engine/README.md` lists every agreed scoring rule.
- `src/main.js` – the app screens and logic. Storage goes through `src/fb-real.js` (Google Firebase); `src/fb-mock.js` is a stand-in used for testing.
- `src/config.js` – the Firebase web app settings (not secret; access is controlled by the rules).
- `firestore.rules` – database security rules. Paste into Firebase console > Firestore Database > Rules whenever they change.
- `build.mjs` – `npm run build` builds the app into `docs/`, which GitHub Pages publishes. `node build.mjs test` builds a test copy using the stand-in database.
- `docs/` – the built app (do not edit by hand).
- `prototype/` – the earlier single-phone prototype.

## Who can do what
- Administrators sign in with Google and can change anything in their tour.
- Players join from a personal invite link (no password), can enter scores only for their own group, and only until the match is submitted.
- Scores save on the phone first and sync when there is signal.
