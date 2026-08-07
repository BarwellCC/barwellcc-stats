// One-off/occasional audit: checks every historic (scraped) match
// (2009-2025) against Play-Cricket's own record of that fixture.
//
// Three outcomes per Play-Cricket fixture (senior teams only, same scope as
// scripts/sync-playcricket.js):
//   - We have a matching historic row and the result agrees -> "linked":
//     set matches.play_cricket_match_id so the site can show a real
//     Play-Cricket scorecard link (site/scorecard.html already renders
//     match.playCricketUrl whenever that column is set - see
//     scripts/buildStatic.js's buildScorecards()).
//   - We have a matching historic row but the result disagrees -> "mismatch":
//     left unlinked, written to the report for a human to look at on
//     site/reconcile.html.
//   - We have no historic row for that fixture at all -> "imported": pulled
//     in full via the same match_detail/parseMatchDetail/insertMatch
//     pipeline scripts/sync-playcricket.js uses for the current season.
//
// Matching key is (season, match_date, team_name) rather than also requiring
// the opposition name to match - the two sources spell club names
// differently (our scraped opposition_name is often just "Broomleys", while
// Play-Cricket's is "Broomleys CC") and a team can only play one match on a
// given day, so date+team alone is enough to identify "the same fixture".
//
// Matching is fixture-level only (date/team/result) - not a full scorecard
// diff - both because result_summary.json (one call per season) already
// carries this without the cost of a per-match fetch, and because that's
// the granularity actually asked for.
//
// Run with: npm run reconcile-playcricket
// Afterwards: npm run dump-historic (refreshes scraped-matches.json with any
// new play_cricket_match_id links) and npm run dump-playcricket-backfill
// (writes historic-data/playcricket-backfill.json for anything imported).
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { insertMatch } = require('./insertMatch');
const { parseMatchDetail, ddmmyyyyToIso } = require('./parseMatchDetail');
const { SENIOR_TEAMS } = require('./teams');

const API_TOKEN = process.env.PLAY_CRICKET_API_TOKEN;
const SITE_ID = process.env.PLAY_CRICKET_SITE_ID;
const CLUB_ID = process.env.PLAY_CRICKET_CLUB_ID;

const BASE = 'https://www.play-cricket.com/api/v2';

// The historic scrape covers 2009-2025 (see README.md) - current/future
// seasons are already handled by the normal nightly npm run sync.
const FIRST_SEASON = 2009;
const LAST_SEASON = 2025;

const REPORT_PATH = path.join(__dirname, '..', 'historic-data', 'reconciliation-report.json');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Play-Cricket API request failed (${res.status}): ${url}`);
  }
  return res.json();
}

async function fetchSeasonResults(season) {
  const url = `${BASE}/result_summary.json?site_id=${SITE_ID}&season=${season}&api_token=${API_TOKEN}`;
  const data = await getJson(url);
  return data.result_summary || [];
}

async function fetchMatchDetail(matchId) {
  const url = `${BASE}/match_detail.json?match_id=${matchId}&api_token=${API_TOKEN}`;
  const data = await getJson(url);
  return (data.match_details || [])[0];
}

function scorecardUrl(pcMatchId) {
  return `https://barwell.play-cricket.com/website/results/${pcMatchId}`;
}

// Play-Cricket's `result` on a result_summary row isn't always given from
// "our" side's perspective - `result_applied_to` names the team_id it
// actually applies to (verified against real API responses: for a plain
// 'W' that's the winning team; for 'CON' (conceded), it's *also* the team
// credited with the win, not the team that conceded - confirmed against a
// real conceded fixture where result_applied_to pointed at the winner's
// team_id, matching the points awarded). 'C' (cancelled) has no winner and
// isn't a real played match, so it's excluded before this is ever called.
// D/T/A (drawn/tied/abandoned) apply symmetrically to both sides.
function ourResultFromSummary(row, ourTeamId) {
  if (row.result === 'C') return null;
  if ((row.result === 'W' || row.result === 'CON') && row.result_applied_to) {
    return String(row.result_applied_to) === String(ourTeamId) ? 'W' : 'L';
  }
  return row.result || null;
}

function loadExistingBackfill() {
  const backfillPath = path.join(__dirname, '..', 'historic-data', 'playcricket-backfill-ids.json');
  if (!fs.existsSync(backfillPath)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(backfillPath, 'utf8')));
}

async function reconcile() {
  // Checked here, not at module load - test/reconcilePlayCricket.test.js
  // requires this module just for the pure ourResultFromSummary() function,
  // with no network/API credentials involved. A module-load-time check
  // would fail that require() (and so the whole test file) in CI, where
  // PLAY_CRICKET_API_TOKEN is only injected as a step-scoped env var for the
  // "Sync from Play-Cricket" step, not for the later "Run tests" step.
  if (!API_TOKEN || !SITE_ID) {
    console.error('Missing PLAY_CRICKET_API_TOKEN or PLAY_CRICKET_SITE_ID in .env');
    process.exit(1);
  }

  const db = openDb();

  const linked = [];
  const mismatches = [];
  const imported = [];
  const importErrors = [];
  const importedIds = [];

  for (let season = FIRST_SEASON; season <= LAST_SEASON; season++) {
    console.log(`Season ${season}...`);
    let rows;
    try {
      rows = await fetchSeasonResults(season);
    } catch (err) {
      console.error(`  Failed to fetch season ${season}:`, err.message);
      continue;
    }

    for (const row of rows) {
      const isHome = String(row.home_club_id) === String(CLUB_ID);
      const isAway = String(row.away_club_id) === String(CLUB_ID);
      if (!isHome && !isAway) continue; // shouldn't happen given site_id scoping, but be safe
      if (row.result === 'C') continue; // cancelled - never played, nothing to reconcile

      const ourTeamName = isHome ? row.home_team_name : row.away_team_name;
      if (!SENIOR_TEAMS.includes(ourTeamName)) continue; // senior teams only - see scripts/teams.js

      const ourTeamId = isHome ? row.home_team_id : row.away_team_id;
      const oppClubName = isHome ? row.away_club_name : row.home_club_name;
      const oppTeamName = isHome ? row.away_team_name : row.home_team_name;
      const isoDate = ddmmyyyyToIso(row.match_date);
      const ourResult = ourResultFromSummary(row, ourTeamId);

      const existing = db
        .prepare(
          `SELECT * FROM matches WHERE source = 'historic' AND season = ? AND match_date = ? AND team_name = ?`
        )
        .get(season, isoDate, ourTeamName);

      if (existing) {
        if (existing.play_cricket_match_id) continue; // already linked in a previous run

        if (ourResult && existing.result === ourResult) {
          db.prepare(`UPDATE matches SET play_cricket_match_id = ? WHERE id = ?`).run(row.id, existing.id);
          linked.push({
            season, date: isoDate, team: ourTeamName,
            opposition: existing.opposition_name, result: existing.result,
            play_cricket_match_id: row.id, url: scorecardUrl(row.id),
          });
        } else {
          mismatches.push({
            season, date: isoDate, team: ourTeamName,
            our_site_opposition: existing.opposition_name,
            our_site_result: existing.result,
            our_site_result_description: existing.result_description,
            play_cricket_opposition: `${oppClubName} ${oppTeamName || ''}`.trim(),
            play_cricket_result: ourResult,
            play_cricket_result_description: row.result_description,
            play_cricket_match_id: row.id,
            url: scorecardUrl(row.id),
          });
        }
      } else {
        try {
          const detail = await fetchMatchDetail(row.id);
          if (!detail) throw new Error('no match_detail returned');
          const parsed = parseMatchDetail(detail, { ourClubId: CLUB_ID, season });
          insertMatch(db, parsed);
          imported.push({
            season, date: isoDate, team: ourTeamName,
            opposition: parsed.match.opposition_name, result: parsed.match.result,
            play_cricket_match_id: row.id, url: scorecardUrl(row.id),
          });
          importedIds.push(row.id);
        } catch (err) {
          importErrors.push({
            season, date: isoDate, team: ourTeamName,
            opposition: `${oppClubName} ${oppTeamName || ''}`.trim(),
            play_cricket_match_id: row.id, error: err.message,
          });
        }
      }

      // Play-Cricket asks integrators to keep traffic low - same politeness
      // pause as scripts/sync-playcricket.js.
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Anything scraped that never matched a Play-Cricket fixture in the loop
  // above - informational, not necessarily wrong: Play-Cricket's own
  // coverage is much thinner in early seasons (2009-2012 result_summary.json
  // only lists a handful of 1st XI fixtures a year) and only broadens to
  // near-full senior-team coverage from around 2021 onwards, confirmed by
  // spot-checking several seasons' result_summary.json directly.
  const noRecord = db
    .prepare(
      `SELECT season, match_date AS date, team_name AS team, opposition_name AS opposition, result
       FROM matches WHERE source = 'historic' AND play_cricket_match_id IS NULL
       ORDER BY match_date`
    )
    .all();

  db.close();

  const report = {
    generated_at: new Date().toISOString(),
    seasons: [FIRST_SEASON, LAST_SEASON],
    summary: {
      linked: linked.length,
      mismatches: mismatches.length,
      imported: imported.length,
      import_errors: importErrors.length,
      no_pc_record: noRecord.length,
    },
    linked, mismatches, imported, import_errors: importErrors, no_pc_record: noRecord,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Track which Play-Cricket match ids this and any prior run have imported,
  // so scripts/dumpPlayCricketBackfill.js knows to include them (it can't
  // tell "backfilled historic match" apart from a normal current-season sync
  // by season number alone once a future season also falls in this range).
  const idsPath = path.join(__dirname, '..', 'historic-data', 'playcricket-backfill-ids.json');
  const priorIds = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, 'utf8')) : [];
  const allIds = [...new Set([...priorIds, ...importedIds])];
  fs.writeFileSync(idsPath, JSON.stringify(allIds));

  console.log(
    `Reconciliation done: ${linked.length} linked, ${mismatches.length} mismatches, ` +
    `${imported.length} imported, ${importErrors.length} import errors, ${noRecord.length} with no Play-Cricket record.`
  );
  console.log(`Report written to ${REPORT_PATH}`);
  console.log('Next: npm run dump-historic && npm run dump-playcricket-backfill');
}

module.exports = { ourResultFromSummary, reconcile };

if (require.main === module) {
  reconcile().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
