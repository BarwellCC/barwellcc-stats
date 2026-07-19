const express = require('express');
const db = require('../db');
const { describeResult } = require('../resultMargin');

const router = express.Router();

router.get('/matches/:id', (req, res) => {
  const id = Number(req.params.id);

  const match = db
    .prepare(
      `SELECT id, match_date, match_time, team_name, opposition_name, venue,
       home_or_away, competition_name, competition_type, result, our_total, opposition_total
       FROM matches WHERE id = ?`
    )
    .get(id);

  if (!match) return res.status(404).json({ error: 'not found' });
  if (!match.result) return res.status(409).json({ error: 'match not yet played' });

  const usInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 1').get(id);
  const oppInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 0').get(id);
  match.resultSummary = describeResult(match.result, usInnings, oppInnings);

  // Abandoned/conceded matches can carry a result code with no parsed
  // scorecard - respond with empty tables rather than crashing on a
  // missing innings row.
  if (!usInnings || !oppInnings) {
    return res.json({ match, usInnings: usInnings || null, oppInnings: oppInnings || null, batting: [], bowling: [] });
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

  res.json({ match, usInnings, oppInnings, batting, bowling });
});

module.exports = router;
