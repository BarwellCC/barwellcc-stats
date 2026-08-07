// Exports the historic-era matches that scripts/reconcilePlayCricket.js
// imported (Play-Cricket had a fixture we didn't) into a portable JSON dump,
// the same {match, innings} shape scripts/insertMatch.js already knows how
// to load. Mirrors scripts/dumpHistoricScraped.js, but for source='playcricket'
// rows rather than 'historic' ones, and keyed off
// historic-data/playcricket-backfill-ids.json (written by the reconcile
// script) rather than a season range - these matches share `source` and a
// pre-2026 `season` with nothing else in the DB, but a plain season filter
// would also need updating every year, so tracking the actual ids is safer.
//
// Run after scripts/reconcilePlayCricket.js:
//   npm run dump-playcricket-backfill
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');

const IDS_PATH = path.join(__dirname, '..', 'historic-data', 'playcricket-backfill-ids.json');
const OUT_PATH = path.join(__dirname, '..', 'historic-data', 'playcricket-backfill.json');

function dumpMatch(db, m) {
  const inningsRows = db.prepare(`SELECT * FROM innings WHERE match_id = ? ORDER BY id`).all(m.id);

  const innings = inningsRows.map((inn) => {
    const batting = db
      .prepare(
        `SELECT p.name AS player_name, p.play_cricket_id AS player_id, bp.batting_position, bp.runs,
         bp.balls_faced, bp.fours, bp.sixes, bp.how_out, bp.not_out, bp.bowler_name, bp.fielder_name
         FROM batting_performances bp
         JOIN players p ON p.id = bp.player_id
         WHERE bp.innings_id = ?
         ORDER BY bp.id`
      )
      .all(inn.id);

    const bowling = db
      .prepare(
        `SELECT p.name AS player_name, p.play_cricket_id AS player_id, bw.overs, bw.maidens,
         bw.runs_conceded, bw.wickets, bw.wides, bw.no_balls
         FROM bowling_performances bw
         JOIN players p ON p.id = bw.player_id
         WHERE bw.innings_id = ?
         ORDER BY bw.id`
      )
      .all(inn.id);

    return {
      innings_number: inn.innings_number,
      batting_team_name: inn.batting_team_name,
      is_us: inn.is_us,
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
      source: 'playcricket',
      play_cricket_match_id: m.play_cricket_match_id,
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
}

function dumpBackfill(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const matches = db
    .prepare(`SELECT * FROM matches WHERE play_cricket_match_id IN (${placeholders}) ORDER BY match_date, team_name`)
    .all(...ids);
  return matches.map((m) => dumpMatch(db, m));
}

function main() {
  if (!fs.existsSync(IDS_PATH)) {
    console.log(`No ${IDS_PATH} found - run scripts/reconcilePlayCricket.js first. Nothing to dump.`);
    return;
  }
  const ids = JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'));

  const db = openDb();
  const records = dumpBackfill(db, ids);
  db.close();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(records));
  console.log(`Wrote ${records.length} Play-Cricket-backfilled historic matches to ${OUT_PATH}`);
}

module.exports = { dumpBackfill };

if (require.main === module) {
  main();
}
