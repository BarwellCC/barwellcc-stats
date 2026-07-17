const { getOrCreatePlayer } = require('./db');

function insertMatch(db, parsed) {
  const { match, innings } = parsed;

  const upsertMatch = db.transaction(() => {
    let matchRow;
    if (match.play_cricket_match_id) {
      matchRow = db
        .prepare('SELECT id FROM matches WHERE play_cricket_match_id = ?')
        .get(match.play_cricket_match_id);
    }

    let matchId;
    if (matchRow) {
      matchId = matchRow.id;
      db.prepare(
        `UPDATE matches SET season=@season, match_date=@match_date, match_time=@match_time,
         team_name=@team_name, opposition_name=@opposition_name, venue=@venue,
         home_or_away=@home_or_away, competition_name=@competition_name,
         competition_type=@competition_type, result=@result,
         result_description=@result_description, toss=@toss, our_total=@our_total,
         opposition_total=@opposition_total, last_updated=@last_updated
         WHERE id=@id`
      ).run({ ...match, id: matchId });
      // Wipe and re-insert innings/performances so an updated scorecard
      // (Play-Cricket corrections happen) doesn't leave stale rows behind.
      db.prepare('DELETE FROM innings WHERE match_id = ?').run(matchId);
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

    for (const inn of innings) {
      const inningsInfo = db
        .prepare(
          `INSERT INTO innings (match_id, innings_number, batting_team_name, is_us, runs, wickets,
           overs, declared, extra_byes, extra_leg_byes, extra_wides, extra_no_balls,
           extra_penalty_runs, total_extras)
           VALUES (@match_id, @innings_number, @batting_team_name, @is_us, @runs, @wickets,
           @overs, @declared, @extra_byes, @extra_leg_byes, @extra_wides, @extra_no_balls,
           @extra_penalty_runs, @total_extras)`
        )
        .run({ ...inn, match_id: matchId });
      const inningsId = inningsInfo.lastInsertRowid;

      const insertBat = db.prepare(
        `INSERT INTO batting_performances (innings_id, player_id, batting_position, runs,
         balls_faced, fours, sixes, how_out, not_out, bowler_name, fielder_name)
         VALUES (@innings_id, @player_id, @batting_position, @runs, @balls_faced, @fours,
         @sixes, @how_out, @not_out, @bowler_name, @fielder_name)`
      );
      for (const b of inn.batting) {
        const playerId = getOrCreatePlayer(db, b.player_name, b.player_id);
        if (!playerId) continue;
        insertBat.run({ ...b, innings_id: inningsId, player_id: playerId });
      }

      const insertBowl = db.prepare(
        `INSERT INTO bowling_performances (innings_id, player_id, overs, maidens, runs_conceded,
         wickets, wides, no_balls)
         VALUES (@innings_id, @player_id, @overs, @maidens, @runs_conceded, @wickets, @wides, @no_balls)`
      );
      for (const bw of inn.bowling) {
        const playerId = getOrCreatePlayer(db, bw.player_name, bw.player_id);
        if (!playerId) continue;
        insertBowl.run({ ...bw, innings_id: inningsId, player_id: playerId });
      }
    }

    return matchId;
  });

  return upsertMatch();
}

module.exports = { insertMatch };
