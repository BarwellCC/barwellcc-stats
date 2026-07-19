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

const OUT_DIR = process.env.STATIC_OUT_DIR || path.join(__dirname, '..', 'site', 'data');

function writeJson(relPath, data) {
  const fullPath = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data));
}

function buildMatches(db) {
  // LEFT JOIN innings (rather than a per-match lookup) so upcoming fixtures
  // with no scorecard yet still come back as one row with ui/oi null.
  const rows = db
    .prepare(
      `SELECT m.id, m.match_date, m.match_time, m.team_name, m.season, m.opposition_name,
       m.home_or_away, m.competition_type, m.result,
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
      id: r.id,
      date: r.match_date,
      time: r.match_time,
      team: r.team_name,
      season: r.season,
      opp: r.opposition_name,
      venue: r.home_or_away,
      comp: r.competition_type,
      result: r.result,
      resultSummary: describeResult(r.result, usInnings, oppInnings),
    };
  });
  writeJson('matches.json', matches);
  return matches.length;
}

function buildScorecards(db) {
  const playedMatches = db
    .prepare(
      `SELECT id, match_date, match_time, team_name, opposition_name, venue,
       home_or_away, competition_name, competition_type, result, our_total, opposition_total
       FROM matches WHERE result IS NOT NULL`
    )
    .all();

  let count = 0;
  for (const match of playedMatches) {
    const usInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 1').get(match.id);
    const oppInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 0').get(match.id);
    match.resultSummary = describeResult(match.result, usInnings, oppInnings);

    // Abandoned/conceded matches can carry a result code with no parsed
    // scorecard - write empty tables rather than skipping the file, so the
    // scorecard page still has something to show instead of a 404.
    if (!usInnings || !oppInnings) {
      writeJson(`scorecards/${match.id}.json`, {
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
         WHERE bp.innings_id = ?
         ORDER BY bp.batting_position`
      )
      .all(usInnings.id);

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
      .all(oppInnings.id);

    writeJson(`scorecards/${match.id}.json`, { match, usInnings, oppInnings, batting, bowling });
    count += 1;
  }
  return count;
}

// Every query below is scoped to a genuine Barwell appearance (the is_us
// join-direction gotcha, and the "Unsure" fake-player exclusion, are both
// applied here) but otherwise unfiltered by team/season/comp - that
// filtering, and all the aggregation, happens client-side in
// site/js/cricket-calc.js.
function buildBattingRows(db) {
  const rows = db
    .prepare(
      `SELECT bp.player_id, p.name, bp.runs, bp.how_out, bp.fours, bp.sixes,
       m.id AS match_id, m.match_date, m.team_name, m.season, m.competition_type,
       m.opposition_name, m.home_or_away
       FROM batting_performances bp
       JOIN innings i ON i.id = bp.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bp.player_id
       WHERE i.is_us = 1 AND p.name != 'Unsure'`
    )
    .all();
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
       m.id AS match_id, m.match_date, m.team_name, m.season, m.competition_type,
       m.opposition_name, m.home_or_away
       FROM bowling_performances bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bw.player_id
       WHERE i.is_us = 0 AND p.name != 'Unsure'`
    )
    .all();
  writeJson('bowling.json', rows);
  return rows.length;
}

function buildFieldingRows(db) {
  const rows = db
    .prepare(
      `SELECT fp.player_id, fp.catches, fp.stumpings, m.id AS match_id, m.team_name, m.season, m.competition_type
       FROM fielding_performances fp
       JOIN matches m ON m.id = fp.match_id`
    )
    .all();
  writeJson('fielding.json', rows);
  return rows.length;
}

function buildPlayers(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.name FROM players p
       WHERE p.name != 'Unsure' AND (EXISTS (
         SELECT 1 FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
         WHERE bp.player_id = p.id AND i.is_us = 1 AND bp.how_out != 'did not bat'
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

  db.close();

  console.log(
    `Wrote ${OUT_DIR}: ${matchCount} matches, ${scorecardCount} scorecards, ` +
    `${battingCount} batting rows, ${bowlingCount} bowling rows, ${fieldingCount} fielding rows, ${playerCount} players.`
  );
}

module.exports = { buildStatic };

if (require.main === module) {
  buildStatic();
}
