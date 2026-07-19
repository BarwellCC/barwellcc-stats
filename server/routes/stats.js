const express = require('express');
const db = require('../db');

const router = express.Router();

function listParam(v) {
  if (!v) return null;
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}
function numParam(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function inClause(col, values, params) {
  params.push(...values);
  return `${col} IN (${values.map(() => '?').join(',')})`;
}

// players is populated from every scorecard we've ever synced, including
// opposition players (parseMatchDetail has no reason to distinguish sides
// when recording who batted/bowled) - so "everyone who's ever batted or
// bowled" is the wrong list here. Only players with a genuine Barwell
// appearance count: an is_us=1 batting innings, or an is_us=0 bowling
// innings (our bowling figures live on the innings the opposition batted -
// same join-direction gotcha as everywhere else in this API).
//
// "Unsure" is excluded outright - on junior scorecards Play-Cricket
// sometimes records an unidentified batter/bowler literally under that
// name, so it's not one real person but several different unnamed kids
// merged into a single fake "player" (same root cause as the fielder_name
// "Unsure" case in scripts/deriveFielding.js, different field).
router.get('/players', (req, res) => {
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
  res.json(rows.map((r) => r.name));
});

router.get('/stats/batting', (req, res) => {
  const teams = listParam(req.query.team);
  const seasons = listParam(req.query.season);
  const comps = listParam(req.query.comp);
  const player = req.query.player || null;
  const min = numParam(req.query.min);
  const max = numParam(req.query.max);

  const clauses = ["i.is_us = 1", "bp.how_out != 'did not bat'", "p.name != 'Unsure'"];
  const params = [];
  if (teams) clauses.push(inClause('m.team_name', teams, params));
  if (seasons) clauses.push(inClause('m.season', seasons.map(Number), params));
  if (comps) clauses.push(inClause('m.competition_type', comps, params));
  if (player) { clauses.push('p.name = ?'); params.push(player); }
  if (min !== null) { clauses.push('bp.runs >= ?'); params.push(min); }
  if (max !== null) { clauses.push('bp.runs <= ?'); params.push(max); }

  const rows = db
    .prepare(
      `SELECT p.name, bp.runs, bp.how_out, m.id AS match_id, m.match_date, m.team_name,
       m.competition_type, m.opposition_name, m.home_or_away
       FROM batting_performances bp
       JOIN innings i ON i.id = bp.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bp.player_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY bp.runs DESC`
    )
    .all(...params);

  res.json(
    rows.map((r) => ({
      player: r.name,
      score: r.runs,
      notOut: r.how_out === 'not out' || r.how_out === 'retired not out',
      date: r.match_date,
      team: r.team_name,
      fixture: r.competition_type,
      opp: r.opposition_name,
      venue: r.home_or_away,
      matchId: r.match_id,
    }))
  );
});

router.get('/stats/bowling', (req, res) => {
  const teams = listParam(req.query.team);
  const seasons = listParam(req.query.season);
  const comps = listParam(req.query.comp);
  const player = req.query.player || null;
  const min = numParam(req.query.min);
  const max = numParam(req.query.max);

  // bowling_performances on an innings belongs to the team that did NOT bat
  // that innings - our figures live on the innings the opposition batted.
  const clauses = ["i.is_us = 0", "p.name != 'Unsure'"];
  const params = [];
  if (teams) clauses.push(inClause('m.team_name', teams, params));
  if (seasons) clauses.push(inClause('m.season', seasons.map(Number), params));
  if (comps) clauses.push(inClause('m.competition_type', comps, params));
  if (player) { clauses.push('p.name = ?'); params.push(player); }
  if (min !== null) { clauses.push('bw.wickets >= ?'); params.push(min); }
  if (max !== null) { clauses.push('bw.wickets <= ?'); params.push(max); }

  const rows = db
    .prepare(
      `SELECT p.name, bw.wickets, bw.runs_conceded, bw.overs, m.id AS match_id, m.match_date,
       m.team_name, m.competition_type, m.opposition_name, m.home_or_away
       FROM bowling_performances bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bw.player_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY bw.wickets DESC`
    )
    .all(...params);

  res.json(
    rows.map((r) => ({
      player: r.name,
      score: r.wickets,
      figures: `${r.wickets}-${r.runs_conceded}`,
      overs: r.overs,
      date: r.match_date,
      team: r.team_name,
      fixture: r.competition_type,
      opp: r.opposition_name,
      venue: r.home_or_away,
      matchId: r.match_id,
    }))
  );
});

module.exports = router;
