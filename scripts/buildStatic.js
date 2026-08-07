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
const { findDuplicatePlayers, BARWELL_PLAYERS_SQL } = require('./findDuplicatePlayers');

const MERGES_PATH = path.join(__dirname, '..', 'data', 'player-merges.json');
const DISMISSALS_PATH = path.join(__dirname, '..', 'data', 'duplicate-dismissals.json');
const RECONCILIATION_PATH = path.join(__dirname, '..', 'historic-data', 'reconciliation-report.json');
const RECONCILIATION_RESOLUTIONS_PATH = path.join(__dirname, '..', 'data', 'reconciliation-resolutions.json');

const OUT_DIR = process.env.STATIC_OUT_DIR || path.join(__dirname, '..', 'site', 'data');

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
       WHERE result IS NOT NULL OR id IN (SELECT match_id FROM innings)`
    )
    .all();

  let count = 0;
  for (const match of playedMatches) {
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

    const batting = db
      .prepare(
        `SELECT bp.batting_position AS pos, p.name, bp.runs, bp.balls_faced AS balls,
         bp.fours, bp.sixes, bp.how_out
         FROM batting_performances bp
         JOIN players p ON p.id = bp.player_id
         WHERE bp.innings_id = ? AND p.name != 'Selected member not found'
         ORDER BY bp.id`
      )
      .all(usInnings.id);

    // bowling_performances on an innings belong to the team that did NOT bat
    // that innings - our bowling figures live on the opposition's batting innings.
    const bowling = db
      .prepare(
        `SELECT p.name, bwp.overs, bwp.maidens, bwp.runs_conceded AS runs, bwp.wickets AS wkts
         FROM bowling_performances bwp
         JOIN players p ON p.id = bwp.player_id
         WHERE bwp.innings_id = ? AND p.name != 'Selected member not found'
         ORDER BY bwp.id`
      )
      .all(oppInnings.id);

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
       WHERE i.is_us = 1 AND p.name != 'Unsure' AND p.name != 'Selected member not found' AND p.name != 'A.N. Other'`
    )
    .all();
  // match_id (the autoincrement PK) stays internal, used only to count
  // distinct matches per player - match_public_id is the one exposed in
  // scorecard links, see publicMatchId() above for why they need to differ.
  for (const r of rows) {
    r.match_public_id = publicMatchId(r);
    delete r.play_cricket_match_id;
  }
  writeJson('batting.json', rows);
  return rows.length;
}

function buildBowlingRows(db) {
  // bowling_performances on an innings belongs to the team that did NOT bat
  // that innings - our figures live on the innings where the opposition
  // batted (is_us = 0).
  const rows = db
    .prepare(
      `SELECT bw.player_id, p.name, bw.overs, bw.maidens, bw.runs_conceded, bw.wickets,
       m.id AS match_id, m.play_cricket_match_id, m.match_date, m.team_name, m.season,
       m.competition_type, m.opposition_name, m.home_or_away
       FROM bowling_performances bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bw.player_id
       WHERE i.is_us = 0 AND p.name != 'Unsure' AND p.name != 'Selected member not found' AND p.name != 'A.N. Other'`
    )
    .all();
  for (const r of rows) {
    r.match_public_id = publicMatchId(r);
    delete r.play_cricket_match_id;
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
  const rows = db
    .prepare(
      `SELECT fp.player_id, fp.catches, fp.stumpings, m.id AS match_id, m.team_name, m.season, m.competition_type
       FROM fielding_performances fp
       JOIN matches m ON m.id = fp.match_id
       JOIN players p ON p.id = fp.player_id
       WHERE p.name != 'Unsure' AND p.name != 'Selected member not found' AND p.name != 'A.N. Other'`
    )
    .all();
  writeJson('fielding.json', rows);
  return rows.length;
}

function buildPlayers(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.name FROM players p
       WHERE p.name != 'Unsure' AND p.name != 'Selected member not found' AND p.name != 'A.N. Other' AND (EXISTS (
         SELECT 1 FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
         WHERE bp.player_id = p.id AND i.is_us = 1
           AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')
       ) OR EXISTS (
         SELECT 1 FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
         WHERE bw.player_id = p.id AND i.is_us = 0
       ))
       ORDER BY p.name`
    )
    .all();
  const names = rows.map((r) => r.name);
  writeJson('players.json', names);
  return names.length;
}

// Feeds site/duplicates.html (an unlinked, staff-only page - see README.md's
// "Duplicate player names" section): every remaining likely-duplicate pair
// among genuine Barwell `players` rows (BARWELL_PLAYERS_SQL excludes
// opposition players and no-shows - see its comment in
// scripts/findDuplicatePlayers.js for why the raw table isn't safe to scan
// directly), with appearance counts so a human can judge which side is the
// real record without needing direct DB access. Merges already confirmed in
// data/player-merges.json are folded into one row by scripts/db.js before
// this runs, so they don't show up here again.
function buildDuplicateCandidates(db) {
  const players = db.prepare(BARWELL_PLAYERS_SQL).all();
  // Counts only the appearances that actually count as "playing for
  // Barwell" (same is_us direction as BARWELL_PLAYERS_SQL) - a raw
  // COUNT(*) across both tables would silently include any opposition-side
  // rows still sitting on this player_id, overstating how real a low-count
  // candidate looks.
  const appearances = (id) => {
    const bat = db.prepare(
      `SELECT COUNT(*) c FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
       WHERE bp.player_id = ? AND i.is_us = 1 AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')`
    ).get(id).c;
    const bowl = db.prepare(
      `SELECT COUNT(*) c FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
       WHERE bw.player_id = ? AND i.is_us = 0`
    ).get(id).c;
    return bat + bowl;
  };
  const candidates = findDuplicatePlayers(players).map((c) => ({
    a: { ...c.a, appearances: appearances(c.a.id) },
    b: { ...c.b, appearances: appearances(c.b.id) },
    matchType: c.matchType,
    confidence: c.confidence,
    reason: c.reason,
  }));
  writeJson('duplicate-candidates.json', candidates);
  return candidates.length;
}

// Copies the confirmed-merges config into site/data/ purely so
// site/duplicates.html can show "already merged" for transparency - the file
// under data/ is what scripts/db.js actually reads to apply merges.
function buildPlayerMerges() {
  const merges = fs.existsSync(MERGES_PATH) ? JSON.parse(fs.readFileSync(MERGES_PATH, 'utf8')) : [];
  writeJson('player-merges.json', merges);
  return merges.length;
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
  const duplicateCount = buildDuplicateCandidates(db);
  const mergeCount = buildPlayerMerges();
  const dismissedCount = buildDismissedDuplicates();
  const reconciliation = buildReconciliation(db);

  db.close();

  console.log(
    `Wrote ${OUT_DIR}: ${matchCount} matches, ${scorecardCount} scorecards, ` +
    `${battingCount} batting rows, ${bowlingCount} bowling rows, ${fieldingCount} fielding rows, ${playerCount} players, ` +
    `${duplicateCount} duplicate candidates, ${mergeCount} confirmed merges, ${dismissedCount} dismissed pairs, ` +
    (reconciliation
      ? `Play-Cricket reconciliation: ${reconciliation.total_games} historic-era games, ${reconciliation.linked_games} linked, ${reconciliation.unlinked_games} unlinked (${reconciliation.mismatches} open mismatches, ${reconciliation.import_errors} import errors).`
      : 'no Play-Cricket reconciliation report yet.')
  );
}

module.exports = { buildStatic };

if (require.main === module) {
  buildStatic();
}
