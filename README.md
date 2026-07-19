# Barwell CC unified stats site — build log

## What's working so far

- **`schema.sql`** — one database for both Play-Cricket-era and historic (Hitssports)
  matches: `matches`, `innings`, `batting_performances`, `bowling_performances`,
  `fielding_performances`, `players`.
- **`scripts/parseMatchDetail.js`** — converts a raw Play-Cricket `match_detail`
  API response into rows matching the schema. Pure function, no network/DB.
- **`scripts/insertMatch.js`** — writes a parsed match into SQLite. Safe to run
  repeatedly on the same match (updates in place rather than duplicating), which
  matters because the nightly sync will re-fetch recently-changed matches.
- **`scripts/db.js`** — SQLite connection + player lookup/creation, matching
  players across matches (and eventually across historic + Play-Cricket data)
  by name, with Play-Cricket's own player IDs used as a stronger match when
  available.
- **`scripts/sync-playcricket.js`** — the actual nightly job: fetches the
  season's fixture list, pulls a full scorecard for every match with a result,
  and stores it.
- **`scripts/matchPlayers.js`** — reconciles Hitssports player names against
  known Play-Cricket players (see "Player matching" below).
- **`scripts/deriveFielding.js`** — rebuilds `fielding_performances`
  (catches/stumpings/run-outs) from `batting_performances.fielder_name`,
  since Play-Cricket doesn't give fielding figures directly. Runs
  automatically at the end of `npm run sync`; `npm run derive-fielding` runs
  it standalone. See the gotchas in "Running the real site locally" below.
- **`server/routes/averages.js`** — real batting/bowling averages
  (`GET /api/averages?team=&season=&comp=`), aggregated in JS from raw
  performance rows rather than in SQL, since cricket-specific rules (overs
  in n.b notation, excluding "did not bat", the not-out asterisk on high
  score) don't map cleanly onto plain SQL aggregates.
- **`server/routes/stats.js`** — real per-innings search: `GET /api/players`
  (every real Barwell player, for the search dropdown) and
  `GET /api/stats/batting` / `GET /api/stats/bowling`
  (`?player=&team=&season=&comp=&min=&max=`), each returning individual
  matching innings rather than season aggregates, same shape as
  Play-Cricket's own player-search page.
- **`server/resultMargin.js`** — turns a match result code + both innings
  into the wording used on Fixtures and the Scorecard ("Won by 4 wickets",
  "Won by 23 runs", "Tied", ...), shared by `server/routes/fixtures.js` and
  `server/routes/matches.js` so the phrasing only lives in one place. See
  the `innings_number` gotcha below if you touch this.
- **`test/`** — an end-to-end test using the real sample payload from
  Play-Cricket's own API documentation, a player-matching test built from
  Barwell's actual 2026 Hitssports export names, and a fielding-derivation
  test covering the is_us join-direction gotcha. Run all three with
  `npm test`. All checks currently pass.
- **`mockups/averages-refresh.html`, `mockups/stats-refresh.html`,
  `mockups/fixtures-refresh.html`, `mockups/scorecard-refresh.html`
  (+ 3 sibling scorecard mockups)** — visual-refresh designs for the
  Averages, Stats, Fixtures & Results and Scorecard pages, built from your
  real data and screenshots of the current Hitssports pages. Mobile-first,
  sortable columns throughout, sticky name column on wide tables, shared
  site nav and dark mode across all of them. See `DESIGN.md` for the full
  token/component reference. These are the preserved design reference —
  `site/` (see "Running the real site locally" below) is where the actual
  wired-up pages live now.

## Player matching (Hitssports ↔ Play-Cricket)

Hitssports exports only have `FirstName`/`Surname` text — no player ID — so
matching them to Play-Cricket's player records (which do have IDs) has to be
done by name, carefully. `npm run match-players` compares every distinct name
in your Hitssports exports against everyone currently in the local database
(populated by `npm run sync`) and sorts them into:

- **Exact matches** — identical name, applied automatically.
- **Nickname matches** — e.g. "Tommy Wright" / "Thomas Wright" — flagged for a
  one-line confirmation, never applied silently.
- **Fuzzy matches** — similar spelling, e.g. a surname typo — also flagged for
  confirmation.
- **No match** — nobody by that name in the Play-Cricket data yet. Usually
  means a genuinely historic-only player, occasionally a spelling too far off
  to catch automatically (worth a manual look).

```
npm run match-players -- batting-2026.xlsx bowling-2026.xlsx          # dry run, just prints the report
npm run match-players -- batting-2026.xlsx bowling-2026.xlsx --apply   # also saves it (exact = confirmed, rest = pending)
```

I tested the matching logic against Barwell's real 2026 player names (from
the files you sent) paired with plausible Play-Cricket-style variants —
nicknames, typos, and three different "Lewis"es that must *not* get confused
with each other. All of that passes; see `test/matchPlayers.test.js`.

**A note on the `xlsx` dependency:** the version of this package published on
npm has two known, unpatched vulnerabilities (SheetJS only ships fixes via
their own site now, not npm). `package.json` points `xlsx` at SheetJS's own
patched build directly rather than the npm one - you shouldn't need to do
anything, but if `npm install` ever complains about that URL, that's why it's
there.

## What I haven't been able to test yet

This sandbox can only reach a fixed allow-list of domains (npm, GitHub, etc.),
not play-cricket.com, so I've validated the code against Play-Cricket's own
documented example data rather than a live API call. Before relying on this,
run it for real with your credentials — see below.

## Try it for real

```
cd barwellcc
npm install
cp .env.example .env       # then fill in your API token, site_id, club_id
npm run sync -- 2026       # syncs the 2026 season
```

This will create `data/barwellcc.db` (a plain SQLite file) with everything
scored on Play-Cricket this season. Open it with any SQLite browser (e.g. "DB
Browser for SQLite") to sanity-check the numbers against what's on
barwell.play-cricket.com before we build anything on top of it.

If you don't know your `site_id` or `club_id`, they're usually visible in your
Play-Cricket site admin area or in the URLs there — shout if you can't find
them and I'll help track them down.

## Next steps

1. ~~**Design direction**~~ — done: Averages, Stats and Fixtures & Results
   visual refresh, all sharing one nav, see `mockups/` and `DESIGN.md`.
2. ~~**Confirm the live sync looks right**~~ — done: spot-checked repeatedly
   against barwell.play-cricket.com and the live Hitssports site (results,
   scores, kick-off times all matched), including catching and fixing a real
   bug where `W`/`L` was sometimes recorded from the opposition's side
   instead of ours.
3. ~~**Run player matching for real**~~ — done: 65 exact + 5 confirmed
   nicknames (Tommy Wright→Tom Wright, Ady Baker→Adrian Baker, Thomas
   Middleton→Tom Middleton, Joseph Ennis→Joe Ennis, Dan King→Daniel King), all
   written to `player_aliases` with `confirmed=1`. Two Hitssports names had no
   Play-Cricket match: Bradley Richardson (unrecognised — likely historic-only)
   and Harry Flower (a real player who plays rarely, so probably just hasn't
   appeared in a synced 2026 match yet — re-run matching later in the season
   before assuming it's a spelling issue).
4. **Historic import** — once matching is solid on this season (where we can
   cross-check against real Play-Cricket data), the same approach applies to
   older Hitssports-only seasons. Send those exports whenever you're ready.
5. ~~**Stats queries**~~ — done: `GET /api/stats/batting` and
   `GET /api/stats/bowling` return individual innings (not aggregated
   season figures like Averages) so you can search/sort/filter by player,
   team(s), season(s), fixture type, and a score/wickets range - the same
   shape as Play-Cricket's own player-search page. Career records/milestones
   (e.g. "highest score ever", "most wickets in a match") aren't built yet -
   nothing's stopping them, there's just been no request for that view yet.
6. **Frontend** — done: Fixtures, Scorecard, Averages and Stats are all real
   (see below). Nothing left mockup-only.
7. **Scheduling + hosting** — wiring `npm run sync` into a free nightly GitHub
   Actions job, and picking somewhere free/cheap to host the site itself.

## Running the real site locally

```
npm run dev
```
Opens an Express server on `http://localhost:4000` serving `site/` (the real,
data-wired pages) plus a small JSON API under `/api/*` — `GET /api/fixtures`,
`/api/teams`, `/api/seasons`, `/api/matches/:id`, `/api/players`,
`/api/averages`, `/api/stats/batting`, `/api/stats/bowling`, all querying
`data/barwellcc.db` directly via `better-sqlite3` (see `server/`).
`site/fixtures.html`, `site/scorecard.html`, `site/averages.html` and
`site/stats.html` are all fully live now — real fixtures for any
team/season, click any completed match for its real scorecard, real
batting/bowling averages with sortable columns, and a real per-innings
search across every player/team/season/fixture-type combination.

`mockups/*.html` stay untouched as the approved design reference (per
`DESIGN.md`) — `site/` is where the real, wired-up copies live, not the same
files. A few non-obvious things worth knowing if you touch `server/routes/`
or `scripts/deriveFielding.js`:

- `bowling_performances` rows on an innings belong to whichever team did
  *not* bat that innings (a real bug hit and fixed twice already in this
  project — join through the opposition's batting innings for "our" bowling
  figures), and the same is true of `batting_performances.fielder_name` —
  the fielder named on a dismissal belongs to whichever team did *not* bat
  that innings, so `fielding_performances` is only ever derived from
  `is_us = 0` innings.
- the `not_out` column is always `0` even for genuine not-outs — derive it
  from `how_out IN ('not out', 'retired not out')` instead.
- `how_out = 'did not bat'` is a real row Play-Cricket includes for every
  player in the XI who never came in to bat (not the same as `not out`) —
  it has to be excluded from innings-played/runs/average, but still counts
  towards matches-played, since it means the player was in the squad.
- `overs` (on `bowling_performances`) is cricket n.b notation, not a real
  decimal — `4.3` means 4 overs and 3 balls (27 balls), not 4.3 overs.
  Summing or averaging overs needs converting to balls first
  (`oversToBalls`/`ballsToOvers` in `server/routes/averages.js`).
- Play-Cricket sometimes records an unidentified player as the literal
  string `"Unsure"` - as a dismissal's fielder (usually adult scorecards),
  and occasionally as the batsman/bowler themselves (seen on junior
  scorecards, where the scorer doesn't always know every child's name).
  Either way `"Unsure"` isn't one real person - it's several different
  unidentified individuals collapsed into a single row in `players`, since
  `getOrCreatePlayer` matches by exact name. `scripts/deriveFielding.js`,
  `server/routes/stats.js` and `server/routes/averages.js` all exclude it
  explicitly (`p.name != 'Unsure'` / a name check) rather than crediting a
  "player" called Unsure with real people's runs, wickets or catches. If you
  add another query that joins through `players`, check whether it needs
  the same exclusion.
- `innings.innings_number` looks like it should tell you which side batted
  first, but doesn't - Play-Cricket sends `1` for both sides on every
  single-innings-per-side match (confirmed against their own documented
  sample payload in `test/sample-match-detail.json`), because it means
  "this team's Nth innings", not "Nth innings of the match". Batting order
  is instead inferred from `innings.id` (`scripts/insertMatch.js` inserts
  both innings in Play-Cricket's own listed order, inside one transaction,
  every sync - lower id batted first). See `server/resultMargin.js`, which
  needs batting order to tell "won by wickets" (second side batted, beat the
  target) from "won by runs" (first side defended a total) apart.

Run `npm run derive-fielding` any time `fielding_performances` needs
rebuilding from scratch (it also runs automatically at the end of
`npm run sync`, so this is only needed if you're testing the derivation
script in isolation).

## ~~Known gap: upcoming fixtures aren't stored yet~~ — fixed

`syncSeason` now stores upcoming fixtures too, not just completed matches:

- `result_summary.json` (used for completed matches) turns out to be a
  results-only endpoint — it never lists a fixture that hasn't been played,
  so there was no way to get upcoming fixtures from it no matter how the
  "no result yet" check was written.
- Upcoming fixtures instead come from `matches.json`
  (`fetchAllFixtures`/`scripts/parseFixture.js`), which lists every fixture
  for the season regardless of whether it's been played — including, oddly,
  inter-squad "fixtures" like Barwell 2nd XI v Barwell 3rd XI, which
  `parseFixture` filters out (same `home_club_id`/`away_club_id`).
  `matches.json`'s own `result` field is never populated even for matches
  we know are finished, so completed vs upcoming is decided by whether the
  match's `id` already showed up in `result_summary.json`, not by that field.
- `matches` now has a `match_time` column (e.g. `"13:00"`), populated for
  both completed and upcoming matches — it was in the API responses all
  along (`match_time` on both `result_summary.json` and `matches.json`
  entries), just not being read.
- `scripts/db.js` runs a one-line migration (`ALTER TABLE ... ADD COLUMN`)
  on every `openDb()` call, since `schema.sql`'s `CREATE TABLE IF NOT EXISTS`
  never alters a table that already exists on disk. Same pattern to follow
  for any future schema change on an existing installation.

Verified: `npm run sync -- 2026` now reports "Stored 62 upcoming fixtures"
alongside the completed-match count, re-running it is still idempotent (same
144 total rows both times, no duplicates), and `npm test` passes.
