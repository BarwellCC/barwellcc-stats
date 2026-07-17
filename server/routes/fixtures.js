const express = require('express');
const db = require('../db');

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

  const rows = db
    .prepare(
      `SELECT id, match_date, match_time, opposition_name, home_or_away,
       competition_type, result, our_total, opposition_total
       FROM matches
       WHERE team_name = ? AND season = ?
       ORDER BY match_date ASC`
    )
    .all(team, season);

  res.json(
    rows.map((r) => ({
      date: r.match_date,
      time: r.match_time,
      opp: r.opposition_name,
      venue: r.home_or_away,
      comp: r.competition_type,
      result: r.result,
      us: r.our_total,
      opp_score: r.opposition_total,
      sc: `scorecard.html?id=${r.id}`,
    }))
  );
});

module.exports = router;
