// Dumps everything the site needs out of data/barwellcc.db into plain JSON
// files under site/data/, so site/*.html can run entirely as static pages -
// no server, no live queries. Every page fetches these once on load and does
// its own filtering/aggregation in the browser via site/js/cricket-calc.js
// (the exact same logic - there's no separate "live API" version of these
// rules to drift out of sync with).
//
// Run after every sync (npm run build-static, or as part of the nightly
// GitHub Action) so the published site reflects the latest results.

const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { describeResult } = require('../site/js/cricket-calc');
const { findDuplicatePlayers, findSuspiciousNames, promoteSuspiciousToPairs, getBarwellPlayers } = require('./findDuplicatePlayers');
const { excludedPlayersClause, loadExcludedPlayerNames } = require('./excludedPlayers');

const MERGES_PATH = path.join(__dirname, '..', 'data', 'player-merges.json');
const DISMISSALS_PATH = path.join(__dirname, '..', 'data', 'duplicate-dismissals.json');
const RECONCILIATION_PATH = path.join(__dirname, '..', 'historic-data', 'reconciliation-report.json');
const RECONCILIATION_RESOLUTIONS_PATH = path.join(__dirname, '..', 'data', 'reconciliation-resolutions.json');

const OUT_DIR = process.env.STATIC_OUT_DIR || path.join(__dirname, '..', 'site', 'data');

// Friendlies show up everywhere like any other match (Type = "Friendly"),
// except a couple of long-running named fixtures the club doesn't want
// lost among every other friendly - these count as "Cup" for filtering/
// grouping purposes (competition_type, row.comp) instead, with their own
// name kept on display via a second "display_type" field that only the
// Type column/scorecard subtitle read, so the fixture reads identically
// everywhere on the site no matter which recorded variant this particular
// row happens to carry.
// season isn't selected by every query that calls applySpecialFriendlyOverride
// (buildScorecards doesn't need it for anything else), but match_date always
// is - falls back to the year out of that instead of adding season to every
// SELECT just for this.
function yearOf(row) {
  return row.season != null ? row.season : parseInt(row.match_date.slice(0, 4), 10);
}

// First played in 1807 - the 2007 fixture was celebrated as the 200th
// playing, which this formula (year - 1807 + 1) puts one higher, at 201st;
// the discrepancy is most likely a handful of wartime years where the
// fixture was, in fact, missed despite the "unbroken since 1807" reputation,
// which this simple year-based count has no way to know about. Flagged here
// rather than silently trusted - if the club has the actual match-by-match
// count, swap this formula for a lookup instead.
const FIRST_COVENTRY_YEAR = 1807;

const SPECIAL_FRIENDLY_CATEGORIES = [
  {
    // Barwell v Coventry & North Warwickshire - the oldest continuous club
    // cricket fixture in the world (dating to the Napoleonic Wars).
    // Opposition name has appeared as "Coventry & N Warwickshire", "Coventry
    // & North Warwickshire CC 1st XI" and "...CC Sunday 1st XI" across
    // seasons - matching on both words rather than a single fixed string
    // covers all of them without also matching the unrelated "North
    // Warwickshire" club. Team has also varied (e.g. "Sunday XI" in 2011) -
    // always shown as "1st XI", who play it every year.
    likePatterns: ['%Coventry%', '%Warwickshire%'],
    test: (opp) => /coventry.*warwickshire/i.test(opp || ''),
    teamName: '1st XI',
    category: 'Cup',
    displayType: 'Oldest Fixture',
    // Separate from displayType (the constant label used for filtering/
    // grouping - see site/fixtures.html's activeTypeFilter/specialTypeLink)
    // so a specific year's count never breaks the "link to every playing of
    // this fixture" behaviour there.
    detail: (row) => String(yearOf(row) - FIRST_COVENTRY_YEAR + 1),
    oppositionName: 'Coventry & North Warwickshire CC',
    // Every recorded year of this fixture is played at Barwell except 2011,
    // where home_or_away simply wasn't captured by the historic scrape (null,
    // not really "Away") - filled in here rather than left to render as
    // Away by default. Only fills a genuine gap, doesn't overwrite a real
    // recorded value, in case the fixture is ever actually played away.
    homeOrAway: 'H',
  },
  {
    // Barwell v Earl Shilton for the Albert Lord - a separate long-running
    // friendly, distinct from the Coventry fixture above.
    likePatterns: ['%Albert Lord%'],
    test: (opp) => /albert lord/i.test(opp || ''),
    category: 'Cup',
    displayType: 'Albert Lord',
    oppositionName: 'Earl Shilton',
  },
];

function findSpecialFriendlyCategory(oppositionName) {
  return SPECIAL_FRIENDLY_CATEGORIES.find((c) => c.test(oppositionName));
}

// Mutates and returns row: applies the matching category's team/category/
// opposition-name/home_or_away overrides, if any, and always sets
// display_type (equal to the (possibly just-overridden) competition_type
// for every other row) so callers never need their own fallback logic.
// display_label is the fuller text actually shown in the Type column/
// scorecard subtitle - same as display_type except for a category with a
// `detail` (e.g. "Oldest Fixture (219)") - kept separate so filtering/
// linking (which needs one constant value per category, not one that
// changes every year) can still key off the plain display_type.
function applySpecialFriendlyOverride(row) {
  const special = findSpecialFriendlyCategory(row.opposition_name);
  if (special) {
    if (special.teamName) row.team_name = special.teamName;
    row.competition_type = special.category;
    if (special.oppositionName) row.opposition_name = special.oppositionName;
    if (special.homeOrAway && !row.home_or_away) row.home_or_away = special.homeOrAway;
  }
  row.display_type = (special && special.displayType) || row.competition_type;
  row.display_label = special && special.detail
    ? `${row.display_type} (${special.detail(row)})`
    : row.display_type;
  return row;
}

function writeJson(relPath, data) {
  const fullPath = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data));
}

// A stable identifier for a match that survives nightly rebuilds from an
// empty database. matches.id (the autoincrement PK) depends on insertion
// order, which Play-Cricket's API doesn't guarantee stable for same-date
// fixtures (very common - several teams often play the same Saturday) - a
// scorecard URL built from it could silently start pointing at a different
// match after the next nightly sync. play_cricket_match_id is permanent,
// assigned once by Play-Cricket itself, so use that whenever we have it.
// Historic matches, once imported, won't have one - fall back
// to a slug built from fields that are fixed for a given real fixture (a
// team can't play the same opponent twice on the same day), so it stays
// stable as long as the imported source data itself doesn't change.
function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function publicMatchId(match) {
  if (match.play_cricket_match_id) return `pc${match.play_cricket_match_id}`;
  return `h-${match.match_date}-${slugify(match.team_name)}-${slugify(match.opposition_name)}`;
}

function buildMatches(db) {
  // LEFT JOIN innings (rather than a per-match lookup) so upcoming fixtures
  // with no scorecard yet still come back as one row with ui/oi null.
  const rows = db
    .prepare(
      `SELECT m.id, m.source, m.play_cricket_match_id, m.match_date, m.match_time, m.team_name, m.season,
       m.opposition_name, m.home_or_away, m.competition_type, m.result,
       ui.id AS us_innings_id, ui.runs AS us_runs, ui.wickets AS us_wickets,
       oi.id AS opp_innings_id, oi.runs AS opp_runs, oi.wickets AS opp_wickets
       FROM matches m
       LEFT JOIN innings ui ON ui.match_id = m.id AND ui.is_us = 1
       LEFT JOIN innings oi ON oi.match_id = m.id AND oi.is_us = 0
       ORDER BY m.match_date ASC`
    )
    .all();

  const matches = rows.map((r) => {
    applySpecialFriendlyOverride(r);
    const usInnings = r.us_innings_id ? { id: r.us_innings_id, runs: r.us_runs, wickets: r.us_wickets } : null;
    const oppInnings = r.opp_innings_id ? { id: r.opp_innings_id, runs: r.opp_runs, wickets: r.opp_wickets } : null;
    return {
      id: publicMatchId(r),
      date: r.match_date,
      time: r.match_time,
      team: r.team_name,
      season: r.season,
      opp: r.opposition_name,
      venue: r.home_or_away,
      comp: r.competition_type,
      // Same as comp except for the couple of special friendlies folded into
      // "Cup" - this carries their own name for display (the Type column),
      // while comp/competition_type stays "Cup" for filtering/grouping.
      type: r.display_type,
      // What the Type column actually renders as text - same as `type`
      // except for a per-year detail like "Oldest Fixture (219th)" - see
      // applySpecialFriendlyOverride's own comment for why this has to be a
      // separate field rather than folded into `type` itself.
      typeLabel: r.display_label,
      result: r.result,
      resultSummary: describeResult(r.result, usInnings, oppInnings),
      // Historic matches never carry a result (the historic xlsx exports don't
      // have one - see scripts/parseScorecardPage.js), but they did happen,
      // unlike a genuinely upcoming Play-Cricket fixture with no result yet -
      // the frontend needs to tell those two "no result" cases apart rather
      // than labelling a 2015 match "Upcoming".
      played: r.source === 'historic' || !!r.result,
      hasScorecard: !!r.result || !!usInnings || !!oppInnings,
    };
  });
  writeJson('matches.json', matches);
  return matches.length;
}

function buildScorecards(db) {
  // A match counts as "played" (gets a scorecard file) if it has a result
  // code (Play-Cricket, including abandoned/conceded matches with no parsed
  // innings) or any innings data at all (historic matches, which never have
  // a result but do have real batting/bowling figures - see
  // scripts/parseScorecardPage.js). Excludes genuinely upcoming fixtures.
  const playedMatches = db
    .prepare(
      `SELECT id, source, play_cricket_match_id, match_date, match_time, team_name, opposition_name, venue,
       home_or_away, competition_name, competition_type, result, result_description, our_total, opposition_total
       FROM matches
       WHERE (result IS NOT NULL OR id IN (SELECT match_id FROM innings))`
    )
    .all();

  let count = 0;
  for (const match of playedMatches) {
    applySpecialFriendlyOverride(match);
    const usInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 1').get(match.id);
    const oppInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 0').get(match.id);
    match.resultSummary = describeResult(match.result, usInnings, oppInnings);
    // Link out to the match's result/scorecard page on the club's own
    // Play-Cricket site, for matches synced via the API (historic/scraped
    // matches have no play_cricket_match_id, hence no such page to link to).
    // /website/results/{id} (not /match_details?id={id}, which is just the
    // bare fixture metadata, no scorecard).
    match.playCricketUrl = match.play_cricket_match_id
      ? `https://barwell.play-cricket.com/website/results/${match.play_cricket_match_id}`
      : null;
    const publicId = publicMatchId(match);
    match.id = publicId;
    delete match.play_cricket_match_id;

    // Abandoned/conceded matches can carry a result code with no parsed
    // scorecard - write empty tables rather than skipping the file, so the
    // scorecard page still has something to show instead of a 404.
    if (!usInnings || !oppInnings) {
      writeJson(`scorecards/${publicId}.json`, {
        match, usInnings: usInnings || null, oppInnings: oppInnings || null, batting: [], bowling: [],
      });
      count += 1;
      continue;
    }

    // Every name in scripts/excludedPlayers.js is kept off buildBattingRows/
    // buildBowlingRows/buildFieldingRows/buildPlayers below - a name that
    // isn't a real, distinct person shouldn't get its own career stats or
    // show up as a duplicate-merge candidate. A scorecard is different: it's
    // a record of the actual line-up that played, so *dropping* the row
    // instead would silently leave the team a player short (a "68/10"
    // innings rendered with only 9 visible batters isn't a faithful record
    // of the game) - whether the name is one of the generic sentinel
    // placeholders ("Unsure", "A.N. Other", "T.B.C", etc.) or a specific
    // record a human ruled out via site/duplicates.html (see
    // data/excluded-players.json), the line-up genuinely had that slot, we
    // just don't have (or trust) a real identity for it. So every excluded
    // name is kept and relabelled to the one consistent "Unsure", with
    // whatever real figures - runs, how out, overs, wickets - Play-Cricket
    // has for it, and never linked to a player profile, since there's no
    // real player behind any of these names to link to (see
    // site/scorecard.html's renderBatting()/renderBowling()/nameCell()).
    const excludedNames = new Set(loadExcludedPlayerNames());
    const sanitizeRow = (r) => (excludedNames.has(r.name) ? { ...r, name: 'Unsure' } : r);

    const batting = db
      .prepare(
        `SELECT bp.batting_position AS pos, p.name, bp.runs, bp.balls_faced AS balls,
         bp.fours, bp.sixes, bp.how_out
         FROM batting_performances bp
         JOIN players p ON p.id = bp.player_id
         WHERE bp.innings_id = ?
         ORDER BY bp.id`
      )
      .all(usInnings.id)
      .map(sanitizeRow);

    // bowling_performances on an innings belong to the team that did NOT bat
    // that innings - our bowling figures live on the opposition's batting innings.
    const bowling = db
      .prepare(
        `SELECT p.name, bwp.overs, bwp.maidens, bwp.runs_conceded AS runs, bwp.wickets AS wkts
         FROM bowling_performances bwp
         JOIN players p ON p.id = bwp.player_id
         WHERE bwp.innings_id = ?
         ORDER BY bwp.id`
      )
      .all(oppInnings.id)
      .map(sanitizeRow);

    writeJson(`scorecards/${publicId}.json`, { match, usInnings, oppInnings, batting, bowling });
    count += 1;
  }
  return count;
}

// Every query below is scoped to a genuine Barwell appearance (the is_us
// join-direction gotcha, and the "Unsure"/"Selected member not found"/
// "A.N. Other" fake-player exclusions, are both applied here) but otherwise
// unfiltered by team/season/comp - that filtering, and all the aggregation,
// happens client-side in site/js/cricket-calc.js. "Selected member not
// found" is the club site's own placeholder for an unresolvable player
// record (same class of bug as "Unsure", just from the historic scraper
// rather than Play-Cricket) - scripts/parseScorecardPage.js now skips it at
// parse time for any future scrape, but this guard also cleans the rows
// already sitting in the checked-in historic-data dump without needing a
// re-scrape. "A.N. Other" is a third variant of the same problem - the
// club's own convention for an unnamed/unidentified squad member, so it's
// several different real (or entirely absent) people collapsed into one
// fake "player" if left unfiltered, same as "Unsure".
function buildBattingRows(db) {
  const { clause, params } = excludedPlayersClause('p.name');
  const rows = db
    .prepare(
      // batting_position is only ever populated for playcricket-sourced rows
      // (the historic scraper's source page doesn't expose a numeric batting
      // order) - stays null for historic rows rather than a guessed value,
      // so any position-based aggregation client-side just has less history
      // to work with for a player who only played pre-2026 seasons.
      `SELECT bp.player_id, p.name, bp.runs, bp.how_out, bp.fours, bp.sixes, bp.batting_position AS position,
       m.id AS match_id, m.play_cricket_match_id, m.match_date, m.team_name, m.season,
       m.competition_type, m.opposition_name, m.home_or_away
       FROM batting_performances bp
       JOIN innings i ON i.id = bp.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bp.player_id
       WHERE i.is_us = 1 AND ${clause}`
    )
    .all(...params);
  // match_id (the autoincrement PK) stays internal, used only to count
  // distinct matches per player - match_public_id is the one exposed in
  // scorecard links, see publicMatchId() above for why they need to differ.
  for (const r of rows) {
    applySpecialFriendlyOverride(r);
    r.match_public_id = publicMatchId(r);
    delete r.play_cricket_match_id;
    delete r.display_type; delete r.display_label; // display-only, not read anywhere off this row shape
  }
  writeJson('batting.json', rows);
  return rows.length;
}

function buildBowlingRows(db) {
  // bowling_performances on an innings belongs to the team that did NOT bat
  // that innings - our figures live on the innings where the opposition
  // batted (is_us = 0).
  const { clause, params } = excludedPlayersClause('p.name');
  const rows = db
    .prepare(
      `SELECT bw.player_id, p.name, bw.overs, bw.maidens, bw.runs_conceded, bw.wickets,
       m.id AS match_id, m.play_cricket_match_id, m.match_date, m.team_name, m.season,
       m.competition_type, m.opposition_name, m.home_or_away
       FROM bowling_performances bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bw.player_id
       WHERE i.is_us = 0 AND ${clause}`
    )
    .all(...params);
  for (const r of rows) {
    applySpecialFriendlyOverride(r);
    r.match_public_id = publicMatchId(r);
    delete r.play_cricket_match_id;
    delete r.display_type; delete r.display_label; // display-only, not read anywhere off this row shape
  }
  writeJson('bowling.json', rows);
  return rows.length;
}

function buildFieldingRows(db) {
  // Same "Unsure"/"Selected member not found"/"A.N. Other" exclusion as
  // buildBattingRows/buildBowlingRows/buildPlayers - defense in depth. These
  // rows already can't affect what's shown (site/js/cricket-calc.js's
  // buildBatting() only ever reads a fielding tally for a player_id that
  // also appears in the batting-rows Map, which excludes these names), but a
  // bad scrape has produced hundreds of bogus "A.N. Other" fielding rows
  // before (see scripts/scrapeAllHistoric.js's batting-row sanity check) -
  // no reason to let that data sit in the published JSON at all, silently
  // relying on a downstream function never reading it.
  const { clause, params } = excludedPlayersClause('p.name');
  const rows = db
    .prepare(
      `SELECT fp.player_id, fp.catches, fp.stumpings, m.id AS match_id, m.team_name, m.season, m.competition_type,
       m.opposition_name
       FROM fielding_performances fp
       JOIN matches m ON m.id = fp.match_id
       JOIN players p ON p.id = fp.player_id
       WHERE ${clause}`
    )
    .all(...params);
  for (const r of rows) {
    applySpecialFriendlyOverride(r);
    delete r.opposition_name;
    delete r.display_type; delete r.display_label; // display-only, not read anywhere off this row shape
  }
  writeJson('fielding.json', rows);
  return rows.length;
}

function buildPlayers(db) {
  const { clause, params } = excludedPlayersClause('p.name');
  const rows = db
    .prepare(
      `SELECT DISTINCT p.name FROM players p
       WHERE ${clause} AND (EXISTS (
         SELECT 1 FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
         WHERE bp.player_id = p.id AND i.is_us = 1
           AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')
       ) OR EXISTS (
         SELECT 1 FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
         WHERE bw.player_id = p.id AND i.is_us = 0
       ))
       ORDER BY p.name`
    )
    .all(...params);
  const names = rows.map((r) => r.name);
  writeJson('players.json', names);
  return names.length;
}

// Feeds site/duplicates.html (an unlinked, staff-only page - see README.md's
// "Duplicate player names" section): every remaining likely-duplicate pair
// among genuine Barwell `players` rows (getBarwellPlayers() excludes
// opposition players and no-shows - see its comment in
// scripts/findDuplicatePlayers.js for why the raw table isn't safe to scan
// directly), with appearance counts so a human can judge which side is the
// real record without needing direct DB access. Merges already confirmed in
// data/player-merges.json are folded into one row by scripts/db.js before
// this runs, so they don't show up here again.
// Counts only the appearances that actually count as "playing for Barwell"
// (same is_us direction as getBarwellPlayers()) - a raw COUNT(*) across both
// tables would silently include any opposition-side rows still sitting on
// this player_id, overstating how real a low-count candidate looks. Shared
// by buildDuplicateCandidates() and buildSuspiciousNames() below.
function appearancesFor(db, id) {
  const bat = db.prepare(
    `SELECT COUNT(*) c FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
     WHERE bp.player_id = ? AND i.is_us = 1 AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')`
  ).get(id).c;
  const bowl = db.prepare(
    `SELECT COUNT(*) c FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
     WHERE bw.player_id = ? AND i.is_us = 0`
  ).get(id).c;
  return bat + bowl;
}

// A suspicious name (see findSuspiciousNames() below) with at least one
// same-surname candidate is really a possible-duplicate lead, so it's
// folded into the same "Needs review" pair list buildDuplicateCandidates()
// writes - see promoteSuspiciousToPairs()'s own comment for why. Only a
// suspicious name with nothing to compare against stays in "Suspicious
// names" (buildSuspiciousNames() below). Both functions need this same
// split, so it's computed once and passed to each rather than recomputed.
function buildDuplicateCandidates(db, promoted) {
  const players = getBarwellPlayers(db);
  // Two different shapes here: a normal pair from findDuplicatePlayers()
  // (single `b`) vs a promoted "incomplete name" entry from
  // promoteSuspiciousToPairs() (a `candidates` array, possibly more than
  // one - see that function's own comment for why they stay grouped as one
  // entry rather than fanning out).
  const pairs = findDuplicatePlayers(players).map((c) => ({
    a: { ...c.a, appearances: appearancesFor(db, c.a.id) },
    b: { ...c.b, appearances: appearancesFor(db, c.b.id) },
    matchType: c.matchType,
    confidence: c.confidence,
    reason: c.reason,
  }));
  const promotedWithAppearances = promoted.map((c) => ({
    a: { ...c.a, appearances: appearancesFor(db, c.a.id) },
    candidates: c.candidates.map((cand) => ({ ...cand, appearances: appearancesFor(db, cand.id) })),
    matchType: c.matchType,
    confidence: c.confidence,
    reason: c.reason,
  }));
  const candidates = [...pairs, ...promotedWithAppearances];
  writeJson('duplicate-candidates.json', candidates);
  return candidates.length;
}

// Feeds site/duplicates.html's "Suspicious names" section - individual
// players table rows that don't look like a real name at all (test/
// placeholder data, or Play-Cricket's bare "- Surname" convention for a
// scorer-added player with no first name on record) and have no plausible
// fuller-name candidate to compare against - a different problem from
// buildDuplicateCandidates() above (two rows for the same real person).
// See scripts/findDuplicatePlayers.js's findSuspiciousNames() for the
// detection rules.
function buildSuspiciousNames(db, stillSuspicious) {
  const suspicious = stillSuspicious.map((s) => ({
    player: { ...s.player, appearances: appearancesFor(db, s.player.id) },
    reason: s.reason,
    candidates: [],
  }));
  writeJson('suspicious-names.json', suspicious);
  return suspicious.length;
}

// Copies the confirmed-merges config into site/data/ purely so
// site/duplicates.html can show "already merged" for transparency - the file
// under data/ is what scripts/db.js actually reads to apply merges. Each
// alias already carries its own play_cricket_id (see
// data/player-merges.json and scripts/db.js's aliasName() comment for why -
// an alias row no longer exists in the DB to look this up live once the
// merge has been applied, so it has to be recorded at merge time instead).
// The canonical side's badge, unlike the aliases', *is* looked up live -
// it's a real, current players row, so there's no reason to let its
// recorded play_cricket_id/appearances go stale in the checked-in config.
//
// The master (canonical) side always shows its own live state plainly - a
// real Play-Cricket id if it has one, "Historic" if it doesn't - and never
// repeats or hides behind a special label. Every alias's id is judged
// against that one live id:
//   - matches it -> this alias *is* where that id came from (or is simply
//     the same real record under a different scorecard entry) - showing
//     the number again would be a redundant repeat of the master's own
//     badge, so it's labelled "Renamed" instead.
//   - a different real id -> a genuinely separate Play-Cricket record that
//     didn't win the merge (see scripts/db.js's applyPlayerMerges() - a
//     SQLite UNIQUE constraint on play_cricket_id means only one id can
//     survive per merged identity, and load order, not correctness,
//     decides which). Kept visible for traceability but flagged "unlinked"
//     so it doesn't read as an equally-valid Play-Cricket link.
//   - no id at all, and it's the *only* alias, and the master has no id
//     either -> there's nothing here to disambiguate at all (no Play-Cricket
//     record on either side, no other alias it could be confused with) -
//     it's unambiguously the same single historic record under a fuller
//     name, so "Renamed" fits just as well as the id-matching case above
//     (e.g. "G Orton" -> "George Orton"). Doesn't apply once there's more
//     than one alias (e.g. "B Kilbourne"/"B Kilbourn" -> "Billy Kilbourne")
//     - that's genuinely reconciling several recorded variants, not just
//     relabelling one.
//   - no id at all, otherwise -> a plain historic-only name variant.
function buildPlayerMerges(db) {
  const merges = fs.existsSync(MERGES_PATH) ? JSON.parse(fs.readFileSync(MERGES_PATH, 'utf8')) : [];
  const enriched = merges.map((m) => {
    // The canonical side is normally just a name string, but can also be
    // `{ name, play_cricket_id }` when scripts/db.js's applyPlayerMerges()
    // needs to force a specific id onto the merged row (see its own
    // comment) - same two-shape pattern as an alias.
    const canonicalName = typeof m.canonical === 'string' ? m.canonical : m.canonical.name;
    const canonicalRow = db.prepare('SELECT id, play_cricket_id FROM players WHERE name = ?').get(canonicalName);
    const canonicalPcId = canonicalRow ? canonicalRow.play_cricket_id : null;
    const onlyUnlinkedAlias = !canonicalPcId && m.aliases.length === 1;
    const aliases = m.aliases.map((a) => {
      const alias = typeof a === 'string' ? { name: a, play_cricket_id: null } : a;
      const matchesMaster = Boolean(alias.play_cricket_id) && alias.play_cricket_id === canonicalPcId;
      const renamed = matchesMaster || (onlyUnlinkedAlias && !alias.play_cricket_id);
      return {
        ...alias,
        renamed,
        adHoc: Boolean(alias.play_cricket_id) && !matchesMaster,
      };
    });
    return {
      canonical: {
        name: canonicalName,
        play_cricket_id: canonicalPcId,
        appearances: canonicalRow ? appearancesFor(db, canonicalRow.id) : 0,
      },
      aliases,
    };
  });
  writeJson('player-merges.json', enriched);
  return enriched.length;
}

// Copies the confirmed-not-duplicate list into site/data/ purely for
// display on site/duplicates.html - the file under data/ is what
// scripts/findDuplicatePlayers.js actually reads to stop re-flagging a
// pair someone has already reviewed and ruled out.
function buildDismissedDuplicates() {
  const dismissals = fs.existsSync(DISMISSALS_PATH) ? JSON.parse(fs.readFileSync(DISMISSALS_PATH, 'utf8')) : [];
  writeJson('duplicate-dismissals.json', dismissals);
  return dismissals.length;
}

// Copies the checked-in Play-Cricket reconciliation report (produced by
// scripts/reconcilePlayCricket.js - see README.md's "Play-Cricket
// reconciliation" section) into site/data/, purely for
// site/reconcile.html (an unlinked, staff-only page, same pattern as
// site/duplicates.html) to display. Absent until that script has been run
// at least once.
//
// data/reconciliation-resolutions.json holds human decisions on individual
// mismatches (keyed by play_cricket_match_id, same pattern as
// data/duplicate-dismissals.json) - a mismatch with a matching resolution is
// split out of "open" into "resolved" here at display time, so working
// through the list doesn't mean re-litigating the same 24 matches every time
// scripts/reconcilePlayCricket.js is re-run. This never mutates
// matches.play_cricket_match_id itself - a "keep_ours" resolution just stops
// nagging about a mismatch that's been checked and explained; only actually
// linking a match (when a resolution decides Play-Cricket was right) goes
// through the normal DB update + npm run dump-historic.
function buildReconciliation(db) {
  if (!fs.existsSync(RECONCILIATION_PATH)) {
    writeJson('reconciliation.json', null);
    return null;
  }
  const report = JSON.parse(fs.readFileSync(RECONCILIATION_PATH, 'utf8'));
  const resolutions = fs.existsSync(RECONCILIATION_RESOLUTIONS_PATH)
    ? JSON.parse(fs.readFileSync(RECONCILIATION_RESOLUTIONS_PATH, 'utf8'))
    : [];
  const resolutionById = new Map(resolutions.map((r) => [r.play_cricket_match_id, r]));

  const openMismatches = [];
  const resolvedMismatches = [];
  for (const m of report.mismatches) {
    const resolution = resolutionById.get(m.play_cricket_match_id);
    if (resolution) {
      resolvedMismatches.push({ ...m, decision: resolution.decision, note: resolution.note });
    } else {
      openMismatches.push(m);
    }
  }

  // "Linked"/"Unlinked" queried straight from the DB rather than added up
  // from the report + resolutions bookkeeping above - some matches get
  // linked by a manual DB patch when resolving a mismatch (see
  // data/reconciliation-resolutions.json's "use_playcricket"/"link_anyway"
  // entries), not just by the reconcile script's own linked/imported
  // counters, so those two would drift out of sync with reality over time.
  const [firstSeason, lastSeason] = report.seasons;
  const totalGames = db
    .prepare('SELECT COUNT(*) c FROM matches WHERE season BETWEEN ? AND ?')
    .get(firstSeason, lastSeason).c;
  const linkedGames = db
    .prepare('SELECT COUNT(*) c FROM matches WHERE season BETWEEN ? AND ? AND play_cricket_match_id IS NOT NULL')
    .get(firstSeason, lastSeason).c;

  // report.no_pc_record is a snapshot from whenever scripts/reconcilePlayCricket.js
  // last actually ran against the live API - it goes stale the moment a
  // mismatch gets manually resolved (linked, or replaced by a fuller import),
  // same problem "Linked"/"Unlinked" above had. Recompute live: every
  // still-unlinked match in range, minus any (date, team) that's a known
  // mismatch (open or resolved) - those found a real Play-Cricket candidate,
  // they just don't have result_applied_to a match, so they don't belong in
  // "no record found at all".
  const mismatchKeys = new Set(
    [...openMismatches, ...resolvedMismatches].map((m) => m.date + '|' + m.team)
  );
  const unlinkedRows = db
    .prepare(
      `SELECT season, match_date AS date, team_name AS team, opposition_name AS opposition, result
       FROM matches WHERE season BETWEEN ? AND ? AND play_cricket_match_id IS NULL
       ORDER BY match_date`
    )
    .all(firstSeason, lastSeason);
  const noPcRecord = unlinkedRows.filter((r) => !mismatchKeys.has(r.date + '|' + r.team));

  const annotated = {
    ...report,
    mismatches: openMismatches,
    resolved: resolvedMismatches,
    no_pc_record: noPcRecord,
    summary: {
      ...report.summary,
      mismatches: openMismatches.length,
      resolved: resolvedMismatches.length,
      no_pc_record: noPcRecord.length,
      total_games: totalGames,
      linked_games: linkedGames,
      unlinked_games: totalGames - linkedGames,
    },
  };
  writeJson('reconciliation.json', annotated);
  return annotated.summary;
}

function buildStatic() {
  const db = openDb();

  // Wipe and rebuild from scratch each time, rather than leaving stale
  // scorecard files around for matches that no longer exist (e.g. a
  // Play-Cricket correction that moves a match to a different id).
  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  const matchCount = buildMatches(db);
  const scorecardCount = buildScorecards(db);
  const battingCount = buildBattingRows(db);
  const bowlingCount = buildBowlingRows(db);
  const fieldingCount = buildFieldingRows(db);
  const playerCount = buildPlayers(db);

  const { promoted, stillSuspicious } = promoteSuspiciousToPairs(
    findSuspiciousNames(getBarwellPlayers(db))
  );
  const duplicateCount = buildDuplicateCandidates(db, promoted);
  const suspiciousCount = buildSuspiciousNames(db, stillSuspicious);
  const mergeCount = buildPlayerMerges(db);
  const dismissedCount = buildDismissedDuplicates();
  const reconciliation = buildReconciliation(db);

  db.close();

  console.log(
    `Wrote ${OUT_DIR}: ${matchCount} matches, ${scorecardCount} scorecards, ` +
    `${battingCount} batting rows, ${bowlingCount} bowling rows, ${fieldingCount} fielding rows, ${playerCount} players, ` +
    `${duplicateCount} duplicate candidates, ${suspiciousCount} suspicious names, ${mergeCount} confirmed merges, ${dismissedCount} dismissed pairs, ` +
    (reconciliation
      ? `Play-Cricket reconciliation: ${reconciliation.total_games} historic-era games, ${reconciliation.linked_games} linked, ${reconciliation.unlinked_games} unlinked (${reconciliation.mismatches} open mismatches, ${reconciliation.import_errors} import errors).`
      : 'no Play-Cricket reconciliation report yet.')
  );
}

module.exports = { buildStatic };

if (require.main === module) {
  buildStatic();
}
