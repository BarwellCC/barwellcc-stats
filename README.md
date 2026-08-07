# Barwell CC Stats Site

Live at **https://stats.barwellcc.co.uk** (also reachable at
`https://barwellcc.github.io/barwellcc-stats/`). A fully static site — no
live backend — serving Fixtures, Scorecards, Averages and Stats for Barwell
Cricket Club. Built from a SQLite database populated nightly from the
Play-Cricket API, plus a one-off scrape of the club's own site for historic
seasons (2009–2025).

## Architecture

- **`schema.sql`** — one database for both Play-Cricket-era and historic
  matches: `matches`, `innings`, `batting_performances`,
  `bowling_performances`, `fielding_performances`, `players`,
  `player_aliases`.
- **`scripts/sync-playcricket.js`** (`npm run sync`) — the nightly job:
  fetches the season's fixture list, pulls a full scorecard for every
  completed match, and stores it. Idempotent — safe to re-run on the same
  match.
- **`scripts/deriveFielding.js`** (`npm run derive-fielding`) — rebuilds
  `fielding_performances` (catches/stumpings/run-outs) from
  `batting_performances.fielder_name`, since Play-Cricket doesn't give
  fielding figures directly. Runs automatically at the end of `npm run sync`.
- **`scripts/buildStatic.js`** (`npm run build-static`) — the only thing
  that queries `data/barwellcc.db` directly. Dumps everything the site needs
  into plain JSON under `site/data/` (matches, one scorecard per played
  match, flat batting/bowling/fielding rows, the real-player list).
- **`site/js/cricket-calc.js`** — every cricket-specific calculation
  (batting/bowling averages, the per-innings search, the "Won by N
  wickets/runs" wording), as plain dependency-free functions. Loaded as a
  `<script>` tag by every page and run **in the browser** — the site has no
  backend at request time, so there's exactly one implementation of these
  rules.
- **`scripts/scrapeClub.js` / `parseFixtureListPage.js` /
  `parseScorecardPage.js` / `insertScrapedMatch.js` / `scrapeAllHistoric.js`**
  (`npm run scrape-historic`) — scrapes historic (pre-Play-Cricket) seasons
  directly from the club's own live site. See "Historic seasons" below.
- **`scripts/matchPlayers.js`** (`npm run match-players`) — reconciles
  xlsx-exported player names against known Play-Cricket players. See
  "Player name matching" below.
- **`scripts/findDuplicatePlayers.js`** (`npm run find-duplicates`) /
  **`site/duplicates.html`** (unlinked, not in the site nav) / **`data/player-merges.json`**
  — flags and (once confirmed) applies duplicate-player merges. See
  "Duplicate player names" below.
- **`scripts/reconcilePlayCricket.js`** (`npm run reconcile-playcricket`) /
  **`site/reconcile.html`** (unlinked, not in the site nav) — audits historic
  matches against Play-Cricket's own record, links matching scorecards,
  imports fixtures Play-Cricket has that we don't. See "Play-Cricket
  reconciliation" below.
- **`mockups/*.html`** — the approved visual-design reference (see
  `DESIGN.md`). `site/` is the real, wired-up implementation, kept as
  separate files from the mockups.
- **`test/`** — covers Play-Cricket parsing/insert, player matching,
  fielding derivation, result-margin wording, the static-export pipeline,
  and the historic scraper (against real saved scorecard pages). Run with
  `npm test`.

## Local development

```
npm install
cp .env.example .env       # fill in PLAY_CRICKET_API_TOKEN / SITE_ID / CLUB_ID
npm run dev
```

`npm run dev` loads the historic-data dump, runs `npm run build-static`
against whatever's in `data/barwellcc.db`, then serves `site/` as static
files on `http://localhost:4000` — nothing more. **The site has no backend
at request time**; every page fetches its data from `site/data/*.json` once
and does all filtering/sorting/aggregation client-side. What you see
locally is exactly what gets published, not an approximation of it.

If you change `data/barwellcc.db` outside of `npm run dev` (e.g. running
`npm run sync` in a separate terminal), re-run `npm run build-static` to
pick it up — the dev server doesn't watch the database.

## Data pipeline

### Current season — Play-Cricket sync

```
npm run sync -- 2026       # syncs a season
```

Creates/updates `data/barwellcc.db`. Only senior teams are synced
(`scripts/teams.js`'s `SENIOR_TEAMS`: 1st/2nd/3rd XI, Midweek XI, Midweek
2nd XI, Sunday XI) — junior fixtures are filtered out before the extra API
call that would fetch their full detail.

### Historic seasons (2009–2025) — scraped from the club's live site

Historic scorecards come from scraping `barwellcc.co.uk` directly (an
ASP.NET RadGrid-based site — see `scripts/parseScorecardPage.js`'s header
comment for the full structure), not from the club's old xlsx exports,
since the live site has full scorecards (real results, team totals with
extras, real dismissal types) where the xlsx exports only gave runs-only
figures. An earlier xlsx-based importer
(`parseHistoricSeason.js`/`insertHistoricMatch.js`/`importHistoric.js`/
`importAllHistoric.js`) was deleted once the scrape proved richer — don't
recreate it. Covers all 6 senior teams, 2009–2025: 1,221 matches, 0
fetch/parse errors. (A few team/season combinations genuinely have zero
fixtures — confirmed as a real gap in the club's own site data, not a
scraper bug, since it's consistent across every team for the affected
seasons.)

The scrape itself is a manual/occasional step (~2,500 page fetches, 20–40
min), not part of the automated build:

```
npm run scrape-historic                                            # all seasons/teams
npm run scrape-historic -- --from=2020 --to=2020 --team="1st XI"    # narrower re-scrape
npm run dump-historic                                               # exports to historic-data/scraped-matches.json
git add historic-data/scraped-matches.json && git commit
```

`npm run load-historic` then loads that checked-in JSON dump into the DB —
fast, no network — and is what every real build actually runs (`npm run
dev`, and the nightly GitHub Action right after `npm run sync`).

Player identity for historic data reuses the same `player_aliases`
mechanism as the current season (see below) — a name confirmed once
applies automatically to historic lookups too (`source='xlsx_export'`).
Anyone not already covered becomes a new historic-only player.

### Play-Cricket reconciliation (historic scrape ↔ Play-Cricket)

`scripts/reconcilePlayCricket.js` (`npm run reconcile-playcricket`) audits
every historic (2009–2025) match against Play-Cricket's own record of the
same fixture — Play-Cricket does have data back to 2009 for this club, even
though the historic scrape (above) doesn't use it as a source. For each
Play-Cricket fixture (senior teams only, matched by season + date + team
name):

- **Result agrees** → linked: `matches.play_cricket_match_id` gets set, so
  the match's Scorecard page shows a real "View on Play-Cricket" link
  (`site/scorecard.html` already renders this whenever the column is set —
  no separate UI work needed).
- **Result disagrees** → flagged as a mismatch, left unlinked, for a human
  to review on `site/reconcile.html` (unlinked, not in the site nav, same
  pattern as `site/duplicates.html`).
- **Play-Cricket has the fixture, we don't** → imported in full (batting,
  bowling, fielding) via the same `match_detail`/`parseMatchDetail`/
  `insertMatch` pipeline `scripts/sync-playcricket.js` uses for the current
  season, then linked automatically.

```
npm run reconcile-playcricket        # audits + mutates the local DB (slow - one API call per season, plus one per imported match)
npm run dump-historic                # refreshes scraped-matches.json with any new play_cricket_match_id links
npm run dump-playcricket-backfill    # writes historic-data/playcricket-backfill.json for anything imported
git add historic-data/ && git commit
```

Like the historic scrape itself, this is a manual/occasional step, not part
of the automated build — re-running it costs real API traffic and none of
the underlying historic data changes on its own. `npm run load-historic` and
`npm run load-playcricket-backfill` (both fast, no network) are what every
real build actually runs, loading the two checked-in dumps into a fresh DB.

Matching is fixture-level (date + team + result), not a full scorecard diff.
Play-Cricket's own coverage is much thinner in early seasons (mostly 1st XI
only before ~2012, broadening to near-full senior-team coverage from around
2021) — a historic match with no matching Play-Cricket record isn't
necessarily wrong, and is shown separately on `site/reconcile.html` rather
than flagged as a mismatch.

### Player name matching (xlsx export ↔ Play-Cricket)

The club's old xlsx exports only have `FirstName`/`Surname` text — no
player ID — so matching them to Play-Cricket's player records has to be
done by name.

```
npm run match-players -- batting-2026.xlsx bowling-2026.xlsx          # dry run, just prints the report
npm run match-players -- batting-2026.xlsx bowling-2026.xlsx --apply   # saves it (exact = confirmed, rest = pending)
```

Sorts every distinct name into:

- **Exact matches** — applied automatically.
- **Nickname matches** (e.g. "Tommy Wright" / "Thomas Wright") — flagged for
  confirmation.
- **Fuzzy matches** (spelling variants) — flagged for confirmation.
- **No match** — usually a genuinely historic-only player.

See `test/matchPlayers.test.js` for the matching-logic tests.

**Note on the `xlsx` dependency:** the npm-published version has two known,
unpatched vulnerabilities (SheetJS only ships fixes via their own site
now). `package.json` points `xlsx` at SheetJS's own patched build directly
instead — nothing to do unless `npm install` complains about that URL.

### Duplicate player names (historic scrape ↔ Play-Cricket)

Separate from the xlsx matching above: the historic site scraper and the
Play-Cricket sync sometimes capture the same real person under two
different spellings (a nickname, a typo), so they end up as two `players`
rows instead of one — e.g. "Dan King" (historic) and "Daniel King"
(Play-Cricket).

```
npm run find-duplicates       # prints a report of likely duplicate pairs
```

`site/duplicates.html` — an **unlinked** page, not in the site nav — shows the
same report in the browser, with appearance counts and a suggested
canonical name (the Play-Cricket-sourced spelling wins when only one side
has a Play-Cricket ID). Since the site has no backend, this page can only
*flag* candidates, not merge them — confirm a real duplicate by hand and
add it to **`data/player-merges.json`**:

```json
{ "canonical": "Daniel King", "aliases": ["Dan King"] }
```

`scripts/db.js` reads this file on every `openDb()` call and redirects any
alias straight to its canonical name before creating/looking up a player
row — this has to be re-derived every run, not fixed once in the database,
since `data/barwellcc.db` is gitignored and rebuilt from scratch on every
deploy (see "Architecture" above). It also folds in any performances
already recorded against a pre-existing alias row, so it's safe to add a
merge after the alias row already exists in a long-lived local database.

A `Jnr`/`Snr`/`Jr`/`Sr` suffix (e.g. "Geoff Hines Jnr" vs "Geoff Hines
Snr") is flagged separately and *not* suggested for auto-merging — that
convention usually marks two different people (commonly a parent and
child both playing for the club), so it needs a human who knows the club
to confirm either way, not a spelling-similarity guess.

Not every candidate is a real duplicate — plenty are just two different
people who share a surname or have similar-sounding first names,
especially when both already have their own distinct Play-Cricket ID.
Reviewing one of those shouldn't mean re-litigating it on every future
rebuild: recording it in **`data/duplicate-dismissals.json`** tells
`scripts/findDuplicatePlayers.js` to stop flagging that specific pair
(matched by name, not id, so the decision survives a full DB rebuild same
as a merge does):

```json
{ "a": "Jack Smith", "b": "Jacob Smith", "reason": "Both have their own Play-Cricket ID, confirmed two different people" }
```

See `test/playerMerges.test.js` for the matching/merge-application tests.

## Known behaviors & gotchas

Non-obvious things worth knowing before touching `scripts/buildStatic.js`,
`site/js/cricket-calc.js`, or `scripts/deriveFielding.js`:

- `bowling_performances` rows on an innings belong to whichever team did
  *not* bat that innings — join through the opposition's batting innings
  for "our" bowling figures. Same for `batting_performances.fielder_name`;
  `fielding_performances` is only ever derived from `is_us = 0` innings.
- `not_out` is always `0` even for genuine not-outs — derive it from
  `how_out IN ('not out', 'retired not out')` instead.
- `how_out = 'did not bat'` marks a squad member who never came in to
  bat — exclude from innings-played/runs/average, but still count towards
  matches-played.
- A handful of `how_out` values are `NULL` rather than `'did not bat'` —
  genuine completed innings where Play-Cricket just never recorded a
  dismissal method (seen on junior scorecards; junior teams are no longer
  synced, but scraped historic dismissals of unknown method use the same
  `NULL` convention). Filter with `how_out !== 'did not bat'` in JS, not
  `how_out != 'did not bat'` in SQL — SQL's `!=` never matches `NULL`, so a
  SQL-side filter silently drops these rows.
- `overs` (on `bowling_performances`) is cricket notation, not decimal —
  `4.3` means 4 overs and 3 balls (27 balls), not 4.3 overs. Convert via
  `oversToBalls`/`ballsToOvers` in `site/js/cricket-calc.js` before
  summing/averaging.
- Play-Cricket sometimes records an unidentified player as the literal
  string `"Unsure"` — as a dismissal's fielder (usually adult scorecards),
  or occasionally as the batsman/bowler themselves (junior scorecards).
  This isn't one real person — every query in `scripts/deriveFielding.js`
  and `scripts/buildStatic.js` that joins through `players` excludes it
  explicitly. Any new query joining through `players` needs the same
  exclusion.
- `innings.innings_number` doesn't tell you which side batted first —
  Play-Cricket sends `1` for both sides' single innings (it means "this
  team's Nth innings", not "Nth innings of the match"). Batting order is
  instead inferred from `innings.id` (`scripts/insertMatch.js` inserts both
  innings in Play-Cricket's own listed order, inside one transaction, every
  sync — lower id batted first). See `describeResult` in
  `site/js/cricket-calc.js`.
- `matches.id` (the autoincrement PK) is **not** stable across rebuilds —
  the nightly Action re-syncs into a fresh `data/barwellcc.db` every run,
  so same-date fixtures aren't guaranteed a stable insertion order. Every
  scorecard link/filename uses `publicMatchId()` (`scripts/buildStatic.js`)
  instead: `play_cricket_match_id` (permanent, from Play-Cricket) when
  available, a deterministic slug otherwise.
- `matches.json` carries `played`/`hasScorecard` flags (computed in
  `buildMatches()`) — Fixtures/Scorecard use those to tell "genuinely
  upcoming" apart from "historic match, no result recorded", rather than
  assuming any match with no `result` is upcoming.
- `scripts/deriveFielding.js`'s rebuild is scoped to `WHERE match_id IN
  (SELECT id FROM matches WHERE source = 'playcricket')` — historic
  (scraped) fielding rows come from `scripts/insertScrapedMatch.js`
  directly, not from this derivation. An unscoped `DELETE FROM
  fielding_performances` here would wipe those out on the next `npm run
  sync`.
- `scripts/db.js` runs a one-line migration (`ALTER TABLE ... ADD COLUMN`)
  on every `openDb()` call, since `schema.sql`'s `CREATE TABLE IF NOT
  EXISTS` never alters a table that already exists on disk — follow the
  same pattern for any future schema change on an existing installation.

## Testing

```
npm test
```

Covers: Play-Cricket API parsing/insert (against Play-Cricket's own
documented sample payload) and re-sync idempotency; player-name matching
(built from Barwell's real xlsx export names); fielding derivation (the
`is_us` join-direction gotcha); result-margin wording (the
`innings_number` gotcha); the full static-export pipeline; and the
historic scraper (fixture-list/scorecard HTML parsing, "did not bat"
detection, re-scrape idempotency, against real saved scorecard pages).

## Hosting

Live at **https://stats.barwellcc.co.uk** (custom domain via `site/CNAME`,
DNS CNAME record to `barwellcc.github.io`) and
`https://barwellcc.github.io/barwellcc-stats/`. `.github/workflows/deploy.yml`
runs nightly (and on every push to `main`, and manually from the Actions
tab): re-syncs the current season from Play-Cricket, loads the
historic-data dump, rebuilds `site/data/*.json`, runs `npm test`, and
publishes `site/` to GitHub Pages. Free forever on a public repo — no
server, no hosting bill.

Two settings only a repo admin can set (needed if this is ever redone on a
fresh repo):

1. **Repo secrets** (Settings → Secrets and variables → Actions):
   `PLAY_CRICKET_API_TOKEN`, `PLAY_CRICKET_SITE_ID`, `PLAY_CRICKET_CLUB_ID`.
2. **Pages source** (Settings → Pages → Build and deployment → Source:
   "GitHub Actions").
3. **Custom domain** (Settings → Pages → Custom domain), plus the DNS
   CNAME record at whichever provider hosts the domain.

Historic-season data doesn't come from the nightly sync — it's scraped
from the club's own live site on a manual/occasional basis (see "Historic
seasons" above) and checked into the repo as
`historic-data/scraped-matches.json`, loaded into the DB on every build.
