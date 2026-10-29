# Golf Tour App

A phone-first web app for scoring golf tours: hole-by-hole Stableford and stroke scoring, team match play (4-ball, singles, 2 v 1, Ambrose), live leaderboards and a Ryder Cup-style team panel.

- `engine/` – the scoring engine (TypeScript) and its tests. Run `npm test` in `engine/` with Node 22+. See `engine/README.md` for the agreed scoring rules.
- `prototype/` – the single-phone prototype (one HTML file with the engine bundled in) and the demo data builder.

Next: connect to Google Firebase for shared, offline-capable scoring across phones, hosted on GitHub Pages.
