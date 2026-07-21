const { getOrCreatePlayer } = require('./db');

// There's no play_cricket_match_id for a scraped historic match, so dedupe on
// (source, match_date, team_name, opposition_name) instead - a real fixture
// can't happen twice on the same day between the same two teams.
function findExistingMatchId(db, match) {
  const row = db
    .prepare(
      `SELECT id FROM matches WHERE source = 'historic' AND match_date = ? AND team_name = ? AND opposition_name = ?`
    )
    .get(match.match_date, match.team_name, match.opposition_name);
  return row ? row.id : null;
}

// A confirmed player_aliases row (source='hitssports', from
// npm run match-players) wins over a fresh exact-name lookup, so "Tommy
// Wright" (scraped) resolves to the same player as "Tom Wright"
// (Play-Cricket), not a duplicate.
function resolvePlayerId(db, playerName) {
  if (!playerName) return null;
  const alias = db
    .prepare(`SELECT player_id FROM player_aliases WHERE alias_name = ? AND source = 'hitssports' AND confirmed = 1`)
    .get(playerName);
  if (alias) return alias.player_id;
  return getOrCreatePlayer(db, playerName, null);
}

// parsed: { match, innings } - innings shaped like
// scripts/parseScorecardPage.js's output (real runs/wickets/overs/extras,
// real how_out, plus catches/stumpings/run_outs on each batting row for
// direct fielding_performances - unlike Play-Cricket data, which derives
// fielding separately via scripts/deriveFielding.js).
function insertScrapedMatch(db, parsed) {
  const { match, innings } = parsed;

  const upsert = db.transaction(() => {
    const existingId = findExistingMatchId(db, match);

    let matchId;
    if (existingId) {
      matchId = existingId;
      db.prepare(
        `UPDATE matches SET season=@season, match_time=@match_time, venue=@venue,
         home_or_away=@home_or_away, competition_name=@competition_name,
         competition_type=@competition_type, result=@result, result_description=@result_description,
         toss=@toss, our_total=@our_total, opposition_total=@opposition_total, last_updated=@last_updated
         WHERE id=@id`
      ).run({ ...match, id: matchId });
      db.prepare('DELETE FROM innings WHERE match_id = ?').run(matchId);
      db.prepare('DELETE FROM fielding_performances WHERE match_id = ?').run(matchId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO matches (source, play_cricket_match_id, season, match_date, match_time,
           team_name, opposition_name, venue, home_or_away, competition_name, competition_type,
           result, result_description, toss, our_total, opposition_total, last_updated)
           VALUES (@source, @play_cricket_match_id, @season, @match_date, @match_time,
           @team_name, @opposition_name, @venue, @home_or_away, @competition_name,
           @competition_type, @result, @result_description, @toss, @our_total,
           @opposition_total, @last_updated)`
        )
        .run(match);
      matchId = info.lastInsertRowid;
    }

    const insertInnings = db.prepare(
      `INSERT INTO innings (match_id, innings_number, batting_team_name, is_us, runs, wickets,
       overs, declared, extra_byes, extra_leg_byes, extra_wides, extra_no_balls,
       extra_penalty_runs, total_extras)
       VALUES (@match_id, 1, @batting_team_name, @is_us, @runs, @wickets,
       @overs, @declared, @extra_byes, @extra_leg_byes, @extra_wides, @extra_no_balls,
       @extra_penalty_runs, @total_extras)`
    );
    const insertBat = db.prepare(
      `INSERT INTO batting_performances (innings_id, player_id, batting_position, runs, balls_faced,
       fours, sixes, how_out, not_out, bowler_name, fielder_name)
       VALUES (@innings_id, @player_id, NULL, @runs, @balls_faced, @fours, @sixes,
       @how_out, @not_out, NULL, NULL)`
    );
    const insertBowl = db.prepare(
      `INSERT INTO bowling_performances (innings_id, player_id, overs, maidens, runs_conceded, wickets, wides, no_balls)
       VALUES (@innings_id, @player_id, @overs, @maidens, @runs_conceded, @wickets, NULL, NULL)`
    );
    const insertField = db.prepare(
      `INSERT INTO fielding_performances (match_id, player_id, catches, stumpings, run_outs)
       VALUES (?, ?, ?, ?, ?)`
    );

    // insertion order here fixes id order, which describeResult() in
    // site/js/cricket-calc.js relies on to tell which side batted first
    // (innings.id ascending) - the scraper feeds innings in true page order,
    // which is the site's own chronological innings order (see
    // scripts/parseScorecardPage.js's header comment).
    for (const inn of innings) {
      const inningsInfo = insertInnings.run({ ...inn, match_id: matchId });
      const inningsId = inningsInfo.lastInsertRowid;

      for (const b of inn.batting) {
        const playerId = resolvePlayerId(db, b.player_name);
        if (!playerId) continue;
        insertBat.run({ ...b, innings_id: inningsId, player_id: playerId });
        if (b.catches || b.stumpings || b.run_outs) {
          insertField.run(matchId, playerId, b.catches || 0, b.stumpings || 0, b.run_outs || 0);
        }
      }

      for (const bw of inn.bowling) {
        const playerId = resolvePlayerId(db, bw.player_name);
        if (!playerId) continue;
        insertBowl.run({ ...bw, innings_id: inningsId, player_id: playerId });
      }
    }

    return matchId;
  });

  return upsert();
}

module.exports = { insertScrapedMatch, resolvePlayerId };
