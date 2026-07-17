// Converts one entry from Play-Cricket's match_detail API response
// (see match_detail_API.pdf) into the shape our schema.sql tables expect.
//
// Deliberately has zero DB/network dependencies so it can be unit tested
// against the sample payload from Play-Cricket's own documentation.

function toNum(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function ddmmyyyyToIso(dateStr) {
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split('/');
  if (!d || !m || !y) return dateStr; // already ISO or unrecognised, pass through
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ourClubId: Barwell CC's Play-Cricket club_id, used to work out which side is us
// and whether we batted in a given innings.
function parseMatchDetail(raw, { ourClubId, season }) {
  const matchId = toNum(raw.id ?? raw.match_id);
  const isHome = String(raw.home_club_id) === String(ourClubId);
  const isAway = String(raw.away_club_id) === String(ourClubId);

  const ourTeamName = isHome ? raw.home_team_name : isAway ? raw.away_team_name : null;
  const oppTeamName = isHome ? raw.away_team_name : isAway ? raw.home_team_name : null;
  const oppClubName = isHome ? raw.away_club_name : isAway ? raw.home_club_name : null;

  // Play-Cricket's `result` (W/L/D/T/A/C) is not always given from "our" side's
  // perspective - `result_applied_to` names the team_id it actually describes.
  // If that's the other team, a win/loss needs to be flipped to read correctly for us.
  const ourTeamId = isHome ? raw.home_team_id : isAway ? raw.away_team_id : null;
  let result = raw.result || null;
  if (result && ourTeamId != null && raw.result_applied_to != null
      && String(raw.result_applied_to) !== String(ourTeamId)) {
    if (result === 'W') result = 'L';
    else if (result === 'L') result = 'W';
  }

  const match = {
    source: 'playcricket',
    play_cricket_match_id: matchId,
    season: season ?? (raw.match_date ? Number(raw.match_date.split('/')[2]) : null),
    match_date: ddmmyyyyToIso(raw.match_date),
    match_time: raw.match_time || null,
    team_name: ourTeamName,
    opposition_name: oppClubName ? `${oppClubName} ${oppTeamName || ''}`.trim() : oppTeamName,
    venue: raw.ground_name || null,
    home_or_away: isHome ? 'H' : isAway ? 'A' : null,
    competition_name: raw.competition_name || raw.league_name || null,
    competition_type: raw.competition_type || null,
    result,
    result_description: raw.result_description || null,
    toss: raw.toss || null,
    last_updated: raw.last_updated || null,
  };

  const innings = (raw.innings || []).map((inn) => {
    const battingTeamId = inn.team_batting_id;
    const isUs = String(battingTeamId) === String(isHome ? raw.home_team_id : raw.away_team_id)
      || String(battingTeamId) === String(raw.home_team_id) && isHome
      || String(battingTeamId) === String(raw.away_team_id) && isAway;

    return {
      innings_number: toNum(inn.innings_number) || 1,
      batting_team_name: inn.team_batting_name,
      is_us: isUs ? 1 : 0,
      runs: toNum(inn.runs),
      wickets: toNum(inn.wickets),
      overs: toNum(inn.overs),
      declared: inn.declared ? 1 : 0,
      extra_byes: toNum(inn.extra_byes),
      extra_leg_byes: toNum(inn.extra_leg_byes),
      extra_wides: toNum(inn.extra_wides),
      extra_no_balls: toNum(inn.extra_no_balls),
      extra_penalty_runs: toNum(inn.extra_penalty_runs),
      total_extras: toNum(inn.total_extras),
      batting: (inn.bat || []).map((b) => ({
        player_name: b.batsman_name,
        player_id: toNum(b.batsman_id),
        batting_position: toNum(b.position),
        runs: toNum(b.runs) || 0,
        balls_faced: toNum(b.balls),
        fours: toNum(b.fours),
        sixes: toNum(b.sixes),
        how_out: b.how_out || null,
        not_out: b.how_out === 'no' ? 1 : 0,
        bowler_name: b.bowler_name || null,
        fielder_name: b.fielder_name || null,
      })),
      bowling: (inn.bowl || []).map((bw) => ({
        player_name: bw.bowler_name,
        player_id: toNum(bw.bowler_id),
        overs: toNum(bw.overs),
        maidens: toNum(bw.maidens),
        runs_conceded: toNum(bw.runs),
        wickets: toNum(bw.wickets),
        wides: toNum(bw.wides),
        no_balls: toNum(bw.no_balls),
      })),
    };
  });

  // our_total / opposition_total for the matches table, taken from whichever
  // innings belongs to us vs them (first innings each, good enough for
  // single-innings league cricket; multi-day/multi-innings matches will show
  // the first innings score only, which is a reasonable summary).
  const ourInnings = innings.find((i) => i.is_us);
  const oppInnings = innings.find((i) => !i.is_us);
  if (ourInnings) match.our_total = `${ourInnings.runs ?? '?'}/${ourInnings.wickets ?? '?'}`;
  if (oppInnings) match.opposition_total = `${oppInnings.runs ?? '?'}/${oppInnings.wickets ?? '?'}`;

  return { match, innings };
}

module.exports = { parseMatchDetail, ddmmyyyyToIso, toNum };
