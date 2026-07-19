const express = require('express');
const db = require('../db');

const router = express.Router();

// Cricket "overs" is n.b notation (n whole overs, b balls, 0-5), not a real
// decimal - 4.3 means 4 overs and 3 balls, i.e. 27 balls, not 4.3 overs.
function oversToBalls(overs) {
  if (overs === null || overs === undefined) return 0;
  const whole = Math.trunc(overs);
  const balls = Math.round((overs - whole) * 10);
  return whole * 6 + balls;
}
function ballsToOvers(balls) {
  return `${Math.trunc(balls / 6)}.${balls % 6}`;
}

function listParam(v) {
  if (!v) return null;
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}
function inClause(col, values, params) {
  params.push(...values);
  return `${col} IN (${values.map(() => '?').join(',')})`;
}

function buildBatting(teams, seasons, comps) {
  const clauses = ["i.is_us = 1", "p.name != 'Unsure'"];
  const params = [];
  if (teams) clauses.push(inClause('m.team_name', teams, params));
  if (seasons) clauses.push(inClause('m.season', seasons.map(Number), params));
  if (comps) clauses.push(inClause('m.competition_type', comps, params));

  const rows = db
    .prepare(
      `SELECT bp.player_id, p.name, bp.runs, bp.how_out, bp.fours, bp.sixes, i.match_id
       FROM batting_performances bp
       JOIN innings i ON i.id = bp.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bp.player_id
       WHERE ${clauses.join(' AND ')}`
    )
    .all(...params);

  const byPlayer = new Map();
  for (const r of rows) {
    let e = byPlayer.get(r.player_id);
    if (!e) {
      e = { name: r.name, matches: new Set(), i: 0, no: 0, runs: 0, high: 0, highNotOut: false,
        fours: 0, sixes: 0, hundreds: 0, fifties: 0 };
      byPlayer.set(r.player_id, e);
    }
    e.matches.add(r.match_id);
    if (r.how_out === 'did not bat') continue;

    e.i += 1;
    const notOut = r.how_out === 'not out' || r.how_out === 'retired not out';
    if (notOut) e.no += 1;
    e.runs += r.runs;
    e.fours += r.fours || 0;
    e.sixes += r.sixes || 0;
    if (r.runs >= 100) e.hundreds += 1;
    else if (r.runs >= 50) e.fifties += 1;

    if (r.runs > e.high || (r.runs === e.high && notOut && !e.highNotOut)) {
      e.high = r.runs;
      e.highNotOut = notOut;
    }
  }

  const fieldingClauses = [];
  const fieldingParams = [];
  if (teams) fieldingClauses.push(inClause('m.team_name', teams, fieldingParams));
  if (seasons) fieldingClauses.push(inClause('m.season', seasons.map(Number), fieldingParams));
  if (comps) fieldingClauses.push(inClause('m.competition_type', comps, fieldingParams));
  const fieldingWhere = fieldingClauses.length ? `WHERE ${fieldingClauses.join(' AND ')}` : '';

  const fieldingRows = db
    .prepare(
      `SELECT fp.player_id, SUM(fp.catches) ct, SUM(fp.stumpings) st
       FROM fielding_performances fp
       JOIN matches m ON m.id = fp.match_id
       ${fieldingWhere}
       GROUP BY fp.player_id`
    )
    .all(...fieldingParams);
  const fieldingByPlayer = new Map(fieldingRows.map((f) => [f.player_id, f]));

  return [...byPlayer.entries()].map(([playerId, e]) => {
    const dismissals = e.i - e.no;
    const fielding = fieldingByPlayer.get(playerId);
    return {
      name: e.name,
      m: e.matches.size,
      i: e.i,
      no: e.no,
      runs: e.runs,
      high: e.highNotOut ? `${e.high}*` : `${e.high}`,
      avg: dismissals > 0 ? Number((e.runs / dismissals).toFixed(2)) : null,
      fours: e.fours,
      sixes: e.sixes,
      hundreds: e.hundreds,
      fifties: e.fifties,
      ct: fielding ? fielding.ct : 0,
      st: fielding ? fielding.st : 0,
    };
  });
}

function buildBowling(teams, seasons, comps) {
  // bowling_performances on an innings belongs to the team that did NOT bat
  // that innings - our figures live on the innings where the opposition
  // batted (is_us = 0), same gotcha as server/routes/matches.js.
  const clauses = ["i.is_us = 0", "p.name != 'Unsure'"];
  const params = [];
  if (teams) clauses.push(inClause('m.team_name', teams, params));
  if (seasons) clauses.push(inClause('m.season', seasons.map(Number), params));
  if (comps) clauses.push(inClause('m.competition_type', comps, params));

  const rows = db
    .prepare(
      `SELECT bw.player_id, p.name, bw.overs, bw.maidens, bw.runs_conceded, bw.wickets, i.match_id
       FROM bowling_performances bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN matches m ON m.id = i.match_id
       JOIN players p ON p.id = bw.player_id
       WHERE ${clauses.join(' AND ')}`
    )
    .all(...params);

  const byPlayer = new Map();
  for (const r of rows) {
    let e = byPlayer.get(r.player_id);
    if (!e) {
      e = { name: r.name, matches: new Set(), balls: 0, mdns: 0, runs: 0, wkts: 0,
        bestWkts: 0, bestRuns: 0, fivew: 0 };
      byPlayer.set(r.player_id, e);
    }
    e.matches.add(r.match_id);
    e.balls += oversToBalls(r.overs);
    e.mdns += r.maidens || 0;
    e.runs += r.runs_conceded || 0;
    e.wkts += r.wickets || 0;
    if (r.wickets >= 5) e.fivew += 1;
    if (r.wickets > e.bestWkts || (r.wickets === e.bestWkts && r.runs_conceded < e.bestRuns)) {
      e.bestWkts = r.wickets;
      e.bestRuns = r.runs_conceded;
    }
  }

  return [...byPlayer.values()].map((e) => ({
    name: e.name,
    m: e.matches.size,
    overs: ballsToOvers(e.balls),
    mdns: e.mdns,
    runs: e.runs,
    wkts: e.wkts,
    best: `${e.bestWkts}-${e.bestRuns}`,
    fivew: e.fivew,
    avg: e.wkts > 0 ? Number((e.runs / e.wkts).toFixed(2)) : null,
    econ: e.balls > 0 ? Number((e.runs / (e.balls / 6)).toFixed(2)) : null,
  }));
}

router.get('/averages', (req, res) => {
  const teams = listParam(req.query.team);
  const seasons = listParam(req.query.season);
  const comps = listParam(req.query.comp);

  res.json({
    batting: buildBatting(teams, seasons, comps),
    bowling: buildBowling(teams, seasons, comps),
  });
});

module.exports = router;
