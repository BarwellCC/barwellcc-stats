const express = require('express');
const db = require('../db');
const { describeResult } = require('../resultMargin');

const router = express.Router();

router.get('/teams', (req, res) => {
  const rows = db
    .prepare('SELECT DISTINCT team_name FROM matches WHERE team_name IS NOT NULL ORDER BY team_name')
    .all();
  res.json(rows.map((r) => r.team_name));
});

router.get('/seasons', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT season FROM matches ORDER BY season DESC').all();
  res.json(rows.map((r) => r.season));
});

router.get('/fixtures', (req, res) => {
  const team = req.query.team || '1st XI';
  const season = req.query.season
    ? Number(req.query.season)
    : db.prepare('SELECT MAX(season) AS s FROM matches').get().s;

  // LEFT JOIN innings (rather than a per-row lookup) so upcoming fixtures
  // with no scorecard yet still come back as one row with ui/oi null.
  const rows = db
    .prepare(
      `SELECT m.id, m.match_date, m.match_time, m.opposition_name, m.home_or_away,
       m.competition_type, m.result,
       ui.id AS us_innings_id, ui.runs AS us_runs, ui.wickets AS us_wickets,
       oi.id AS opp_innings_id, oi.runs AS opp_runs, oi.wickets AS opp_wickets
       FROM matches m
       LEFT JOIN innings ui ON ui.match_id = m.id AND ui.is_us = 1
       LEFT JOIN innings oi ON oi.match_id = m.id AND oi.is_us = 0
       WHERE m.team_name = ? AND m.season = ?
       ORDER BY m.match_date ASC`
    )
    .all(team, season);

  res.json(
    rows.map((r) => {
      const usInnings = r.us_innings_id ? { id: r.us_innings_id, runs: r.us_runs, wickets: r.us_wickets } : null;
      const oppInnings = r.opp_innings_id ? { id: r.opp_innings_id, runs: r.opp_runs, wickets: r.opp_wickets } : null;
      return {
        date: r.match_date,
        time: r.match_time,
        opp: r.opposition_name,
        venue: r.home_or_away,
        comp: r.competition_type,
        result: r.result,
        resultSummary: describeResult(r.result, usInnings, oppInnings),
        sc: `scorecard.html?id=${r.id}`,
      };
    })
  );
});

module.exports = router;
