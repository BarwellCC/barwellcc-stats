// Pure, dependency-free cricket stats logic - no DB, no Express, no browser
// globals beyond what's passed in. Shared between the Node server (local dev,
// scripts/buildStatic.js) and the static site (loaded as a plain <script>
// tag, computing everything client-side against the JSON files
// scripts/buildStatic.js produces). Keeping this in one place means the
// aggregation rules can't drift between "live" and "static" modes.
//
// All functions here take already-flattened row arrays (see
// scripts/buildStatic.js for the exact SQL that produces them) - is_us
// filtering, the "Unsure" placeholder-player exclusion, and the
// bowling/fielding join-direction gotchas are all applied once, at the
// point those rows are queried from SQLite, not in here.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CricketCalc = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

  // Cricket "overs" is n.b notation (n whole overs, b balls, 0-5), not a
  // real decimal - 4.3 means 4 overs and 3 balls, i.e. 27 balls, not 4.3 overs.
  function oversToBalls(overs) {
    if (overs === null || overs === undefined) return 0;
    const whole = Math.trunc(overs);
    const balls = Math.round((overs - whole) * 10);
    return whole * 6 + balls;
  }
  function ballsToOvers(balls) {
    return `${Math.trunc(balls / 6)}.${balls % 6}`;
  }

  // Turns a match result code + both innings into the human-readable summary
  // used on both the scorecard and fixtures pages ("Won by 4 wickets", "Lost
  // by 23 runs", "Tied", ...). States the margin from OUR perspective -
  // `result` ('W'/'L') already reflects whether Barwell won or lost (see
  // parseMatchDetail.js's result_applied_to flip), so the verb here just
  // follows it directly. Getting the margin number right (not the verb)
  // needs knowing which side batted first, which `innings.innings_number`
  // can't tell you - Play-Cricket sends `1` for every single-innings-per-side
  // match on both sides. The `innings` table's own autoincrementing `id` is
  // the reliable signal instead: scripts/insertMatch.js inserts both
  // innings, in the same order Play-Cricket lists them (chronological),
  // inside one transaction, every sync - so the lower id is always the
  // innings that happened first.
  const RESULT_LABELS = { W: 'Won', L: 'Lost', T: 'Tied', D: 'Drawn', A: 'Abandoned', C: 'Cancelled', CON: 'Conceded' };

  function describeResult(result, usInnings, oppInnings) {
    if (!result) return null; // upcoming fixture, nothing to describe yet

    if ((result === 'W' || result === 'L') && usInnings && oppInnings) {
      const usBattedFirst = usInnings.id < oppInnings.id;
      const first = usBattedFirst ? usInnings : oppInnings;
      const second = usBattedFirst ? oppInnings : usInnings;
      const verb = result === 'W' ? 'Won' : 'Lost';

      if (second.runs > first.runs) {
        const wkts = 10 - second.wickets;
        return `${verb} by ${wkts} ${wkts === 1 ? 'wicket' : 'wickets'}`;
      }
      if (second.runs < first.runs) {
        const runs = first.runs - second.runs;
        return `${verb} by ${runs} ${runs === 1 ? 'run' : 'runs'}`;
      }
      // second.runs === first.runs alongside a W/L result shouldn't happen
      // (that's what result 'T' is for) - fall through to the plain label
      // rather than claiming a margin that isn't there.
    }

    return RESULT_LABELS[result] || result;
  }

  // ---- Shared row filtering (teams/seasons/comps are arrays or null/undefined = no filter) ----
  function matchesFilter(row, { teams, seasons, comps, player, min, max, minKey, maxKey }) {
    if (teams && !teams.includes(row.team_name)) return false;
    if (seasons && !seasons.map(Number).includes(Number(row.season))) return false;
    if (comps && !comps.includes(row.competition_type)) return false;
    if (player && row.name !== player) return false;
    if (min != null && row[minKey] < min) return false;
    if (max != null && row[maxKey] > max) return false;
    return true;
  }

  // ---- Averages: season/team aggregated batting and bowling figures ----
  function buildBatting(battingRows, fieldingRows, { teams, seasons, comps } = {}) {
    const filtered = battingRows.filter((r) => matchesFilter(r, { teams, seasons, comps }));

    const byPlayer = new Map();
    for (const r of filtered) {
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

    const fieldingByPlayer = new Map();
    for (const r of fieldingRows.filter((r) => matchesFilter(r, { teams, seasons, comps }))) {
      let f = fieldingByPlayer.get(r.player_id);
      if (!f) { f = { ct: 0, st: 0 }; fieldingByPlayer.set(r.player_id, f); }
      f.ct += r.catches || 0;
      f.st += r.stumpings || 0;
    }

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

  function buildBowling(bowlingRows, { teams, seasons, comps } = {}) {
    const filtered = bowlingRows.filter((r) => matchesFilter(r, { teams, seasons, comps }));

    const byPlayer = new Map();
    for (const r of filtered) {
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

  // ---- Stats: per-innings search, sorted highest-first ----
  // matchId here is match_public_id (Play-Cricket's own permanent id, not
  // the internal autoincrement one) - see publicMatchId() in
  // scripts/buildStatic.js for why the difference matters for scorecard links.
  function statsBatting(battingRows, { teams, seasons, comps, player, min, max } = {}) {
    return battingRows
      .filter((r) => r.how_out !== 'did not bat')
      .filter((r) => matchesFilter(r, { teams, seasons, comps, player, min, max, minKey: 'runs', maxKey: 'runs' }))
      .map((r) => ({
        player: r.name,
        score: r.runs,
        notOut: r.how_out === 'not out' || r.how_out === 'retired not out',
        date: r.match_date,
        team: r.team_name,
        fixture: r.competition_type,
        opp: r.opposition_name,
        venue: r.home_or_away,
        matchId: r.match_public_id,
      }))
      .sort((a, b) => b.score - a.score);
  }

  function statsBowling(bowlingRows, { teams, seasons, comps, player, min, max } = {}) {
    return bowlingRows
      .filter((r) => matchesFilter(r, { teams, seasons, comps, player, min, max, minKey: 'wickets', maxKey: 'wickets' }))
      .map((r) => ({
        player: r.name,
        score: r.wickets,
        figures: `${r.wickets}-${r.runs_conceded}`,
        overs: r.overs,
        date: r.match_date,
        team: r.team_name,
        fixture: r.competition_type,
        opp: r.opposition_name,
        venue: r.home_or_away,
        matchId: r.match_public_id,
      }))
      .sort((a, b) => b.score - a.score);
  }

  return {
    oversToBalls, ballsToOvers,
    describeResult, RESULT_LABELS,
    buildBatting, buildBowling,
    statsBatting, statsBowling,
  };
});
