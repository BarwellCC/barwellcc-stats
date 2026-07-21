// Exports every historic (source='historic') match currently in the local
// DB into a portable JSON dump - the {match, innings} shape
// scripts/insertScrapedMatch.js already knows how to load, with no
// database-internal ids (autoincrement PKs aren't stable across a rebuild -
// see README.md). Run this once after scraping/re-scraping
// (scripts/scrapeAllHistoric.js) to refresh the checked-in dump; the nightly
// build then loads the dump (scripts/loadHistoricScraped.js), not the live
// site - see README.md's "Importing historic seasons via the live site"
// section for why re-scraping on every deploy would be excessive.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');

const OUT_PATH = process.env.HISTORIC_DUMP_PATH
  || path.join(__dirname, '..', 'historic-data', 'scraped-matches.json');

function dumpHistoric(db) {
  const matches = db.prepare(`SELECT * FROM matches WHERE source = 'historic' ORDER BY match_date, team_name`).all();

  return matches.map((m) => {
    const inningsRows = db.prepare(`SELECT * FROM innings WHERE match_id = ? ORDER BY id`).all(m.id);

    const innings = inningsRows.map((inn) => {
      const batting = db
        .prepare(
          `SELECT p.name AS player_name, bp.runs, bp.balls_faced, bp.fours, bp.sixes, bp.how_out, bp.not_out,
           COALESCE(fp.catches, 0) AS catches, COALESCE(fp.stumpings, 0) AS stumpings, COALESCE(fp.run_outs, 0) AS run_outs
           FROM batting_performances bp
           JOIN players p ON p.id = bp.player_id
           LEFT JOIN fielding_performances fp ON fp.match_id = ? AND fp.player_id = bp.player_id
           WHERE bp.innings_id = ?
           ORDER BY bp.id`
        )
        .all(m.id, inn.id);

      const bowling = db
        .prepare(
          `SELECT p.name AS player_name, bw.overs, bw.maidens, bw.runs_conceded, bw.wickets
           FROM bowling_performances bw
           JOIN players p ON p.id = bw.player_id
           WHERE bw.innings_id = ?
           ORDER BY bw.id`
        )
        .all(inn.id);

      return {
        is_us: inn.is_us,
        batting_team_name: inn.batting_team_name,
        runs: inn.runs,
        wickets: inn.wickets,
        overs: inn.overs,
        declared: inn.declared,
        extra_byes: inn.extra_byes,
        extra_leg_byes: inn.extra_leg_byes,
        extra_wides: inn.extra_wides,
        extra_no_balls: inn.extra_no_balls,
        extra_penalty_runs: inn.extra_penalty_runs,
        total_extras: inn.total_extras,
        batting,
        bowling,
      };
    });

    return {
      match: {
        source: 'historic',
        play_cricket_match_id: null,
        season: m.season,
        match_date: m.match_date,
        match_time: m.match_time,
        team_name: m.team_name,
        opposition_name: m.opposition_name,
        venue: m.venue,
        home_or_away: m.home_or_away,
        competition_name: m.competition_name,
        competition_type: m.competition_type,
        result: m.result,
        result_description: m.result_description,
        toss: m.toss,
        our_total: m.our_total,
        opposition_total: m.opposition_total,
        last_updated: m.last_updated,
      },
      innings,
    };
  });
}

function main() {
  const db = openDb();
  const records = dumpHistoric(db);
  db.close();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(records));
  console.log(`Wrote ${records.length} historic matches to ${OUT_PATH}`);
}

module.exports = { dumpHistoric };

if (require.main === module) {
  main();
}
