// Scrapes every historic (pre-Play-Cricket) season directly from the club's
// own live site (barwellcc.co.uk) instead of relying on the Hitssports xlsx
// exports - the site's scorecard pages have real results, real team totals
// (with extras), and real dismissal types that the xlsx exports don't (see
// README.md's "Importing historic seasons via the live site" section for the
// full writeup and why this supersedes the xlsx-based pilot).
//
// Usage: node scripts/scrapeAllHistoric.js [--from=2009] [--to=2025] [--team="1st XI"]
// Defaults to every team in scripts/scrapeClub.js's TEAM_IDS, seasons 2009-2025
// (2026 onwards comes from Play-Cricket, not this scraper).
require('dotenv').config();
const { openDb } = require('./db');
const { TEAM_IDS, SEASON_IDS, fetchFixtureList, fetchScorecard } = require('./scrapeClub');
const { parseFixtureListPage } = require('./parseFixtureListPage');
const { parseScorecardPage } = require('./parseScorecardPage');
const { insertScrapedMatch } = require('./insertScrapedMatch');
const { ddMonYyyyToIso } = require('./dateUtils');
const { parseTimeText } = require('./parseScorecardPage');
const { clean } = require('./normalizeName');

function stripWeekday(dateStr) {
  return (dateStr || '').replace(/^[A-Za-z]+\s+/, '');
}

// Merges a fixture-list row (identity/metadata - team, opposition, venue,
// type, a reliable result code from its CSS class) with its scorecard page
// (the actual innings detail) into the {match, innings} shape
// scripts/insertScrapedMatch.js expects.
function buildMatchRecord({ teamName, season, fixtureRow, scorecard }) {
  const isoDate = ddMonYyyyToIso(stripWeekday(fixtureRow.dateStr));
  const matchTime = (scorecard && scorecard.timeStr) || parseTimeText(fixtureRow.startTimeText);
  const result = (scorecard && scorecard.resultCode) || fixtureRow.resultCode || null;

  const innings = scorecard ? scorecard.innings : [];
  const ourInnings = innings.find((i) => i.is_us);
  const oppInnings = innings.find((i) => !i.is_us);

  const match = {
    source: 'historic',
    play_cricket_match_id: null,
    season,
    match_date: isoDate,
    match_time: matchTime || null,
    team_name: teamName,
    opposition_name: fixtureRow.opposition,
    venue: null,
    home_or_away: fixtureRow.homeOrAway,
    competition_name: null,
    competition_type: fixtureRow.type,
    result,
    result_description: (scorecard && scorecard.resultText) || null,
    toss: null,
    our_total: ourInnings ? `${ourInnings.runs ?? '?'}/${ourInnings.wickets ?? '?'}` : null,
    opposition_total: oppInnings ? `${oppInnings.runs ?? '?'}/${oppInnings.wickets ?? '?'}` : null,
    last_updated: null,
  };

  return { match, innings };
}

async function scrapeTeamSeason(db, teamName, teamId, season, seasonId, stats) {
  const listHtml = await fetchFixtureList(teamId, seasonId);
  const fixtureRows = parseFixtureListPage(listHtml);

  for (const row of fixtureRows) {
    stats.fixturesSeen += 1;
    let scorecard = null;
    try {
      const scorecardHtml = await fetchScorecard(row.fixtureId);
      scorecard = parseScorecardPage(scorecardHtml);
    } catch (err) {
      stats.fetchErrors += 1;
      console.warn(`  ! failed to fetch/parse scorecard for fixture ${row.fixtureId}: ${err.message}`);
    }

    const record = buildMatchRecord({ teamName, season, fixtureRow: row, scorecard });
    if (!record.match.match_date) {
      stats.skippedBadDate += 1;
      console.warn(`  ! skipped fixture ${row.fixtureId} (unparseable date "${row.dateStr}")`);
      continue;
    }
    record.match.opposition_name = clean(record.match.opposition_name);

    insertScrapedMatch(db, record);
    stats.matchesImported += 1;
    if (record.innings.length) stats.matchesWithInnings += 1;
  }

  console.log(`  ${teamName} ${season}: ${fixtureRows.length} fixtures`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, def) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : def;
  };
  const from = Number(opt('from', 2009));
  const to = Number(opt('to', 2025));
  const onlyTeam = opt('team', null);

  const teams = onlyTeam ? { [onlyTeam]: TEAM_IDS[onlyTeam] } : TEAM_IDS;
  if (onlyTeam && !teams[onlyTeam]) {
    console.error(`Unknown team "${onlyTeam}". Known teams: ${Object.keys(TEAM_IDS).join(', ')}`);
    process.exit(1);
  }

  const stats = { fixturesSeen: 0, matchesImported: 0, matchesWithInnings: 0, fetchErrors: 0, skippedBadDate: 0 };
  const db = openDb();

  for (const [teamName, teamId] of Object.entries(teams)) {
    for (let season = from; season <= to; season++) {
      const seasonId = SEASON_IDS[season];
      if (!seasonId) {
        console.warn(`No known season id for ${season}, skipping.`);
        continue;
      }
      await scrapeTeamSeason(db, teamName, teamId, season, seasonId, stats);
    }
  }

  db.close();

  console.log(
    `\nDone. ${stats.fixturesSeen} fixtures seen, ${stats.matchesImported} matches imported ` +
    `(${stats.matchesWithInnings} with scorecard detail), ${stats.fetchErrors} fetch/parse errors, ` +
    `${stats.skippedBadDate} skipped for an unparseable date.`
  );
}

if (require.main === module) {
  main();
}

module.exports = { buildMatchRecord, scrapeTeamSeason };
