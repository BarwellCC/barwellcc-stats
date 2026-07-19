// Derives fielding_performances (catches/stumpings/run-outs) from
// batting_performances.fielder_name, which is free text captured on the
// dismissal itself - nothing populates fielding_performances directly.
//
// Same join-direction gotcha as bowling_performances: a batting_performances
// row belongs to the team that batted that innings, so its fielder_name
// names someone on the OTHER side. Only innings.is_us = 0 (opposition
// batting) yields fielder_name values that are actually us - deriving from
// is_us = 1 innings would attribute the opposition's fielding to our players.
//
// fielder_name is matched to players.name exactly; Play-Cricket occasionally
// records it as "Unsure" when the scorer didn't know who took the catch -
// that string is skipped explicitly, since it otherwise exact-matches a real
// (bogus) "Unsure" row that exists in players because someone was once
// recorded as a batsman/bowler by that same placeholder name. Any other
// fielder_name with no matching player (e.g. a substitute we've never seen
// bat/bowl) is skipped too, rather than creating a new player row for it.

function deriveFielding(db) {
  const dismissals = db
    .prepare(
      `SELECT bp.how_out, bp.fielder_name, i.match_id
       FROM batting_performances bp
       JOIN innings i ON i.id = bp.innings_id
       WHERE i.is_us = 0
         AND bp.fielder_name IS NOT NULL
         AND bp.how_out IN ('ct', 'st', 'run out')`
    )
    .all();

  const playerIdByName = new Map(
    db.prepare('SELECT id, name FROM players').all().map((p) => [p.name, p.id])
  );

  // Key: `${matchId}:${playerId}` -> counts, so multiple dismissals by the
  // same fielder in the same match collapse into one summed row.
  const totals = new Map();
  let unmatched = 0;
  for (const d of dismissals) {
    const playerId = d.fielder_name === 'Unsure' ? null : playerIdByName.get(d.fielder_name);
    if (!playerId) {
      unmatched += 1;
      continue;
    }
    const key = `${d.match_id}:${playerId}`;
    const entry = totals.get(key) || { match_id: d.match_id, player_id: playerId, catches: 0, stumpings: 0, run_outs: 0 };
    if (d.how_out === 'ct') entry.catches += 1;
    else if (d.how_out === 'st') entry.stumpings += 1;
    else if (d.how_out === 'run out') entry.run_outs += 1;
    totals.set(key, entry);
  }

  const rebuild = db.transaction(() => {
    db.exec('DELETE FROM fielding_performances');
    const insert = db.prepare(
      `INSERT INTO fielding_performances (match_id, player_id, catches, stumpings, run_outs)
       VALUES (@match_id, @player_id, @catches, @stumpings, @run_outs)`
    );
    for (const entry of totals.values()) insert.run(entry);
  });
  rebuild();

  return { rows: totals.size, unmatched };
}

module.exports = { deriveFielding };

if (require.main === module) {
  const { openDb } = require('./db');
  const db = openDb();
  const { rows, unmatched } = deriveFielding(db);
  console.log(`Derived ${rows} fielding_performances rows (${unmatched} dismissals had no matching player, e.g. "Unsure").`);
  db.close();
}
