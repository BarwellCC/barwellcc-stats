// Converts one entry from Play-Cricket's matches.json fixture list (not the
// fuller match_detail/result_summary payload) into a matches row with no
// result yet - for fixtures still to be played. See parseMatchDetail.js for
// the completed-match equivalent; this deliberately mirrors its home/away
// and date-conversion logic rather than sharing more code, since the two
// input shapes only overlap partially.

const { ddmmyyyyToIso, toNum } = require('./parseMatchDetail');

// ourClubId: Barwell CC's Play-Cricket club_id, used to work out which side is us.
// Returns null if the fixture isn't a real "us vs opposition" match - e.g.
// Play-Cricket lists inter-squad friendlies (Barwell 2nd XI v Barwell 3rd XI)
// as fixtures too, and those have no meaningful "opposition".
function parseFixture(raw, { ourClubId, season }) {
  if (String(raw.home_club_id) === String(raw.away_club_id)) return null;

  const isHome = String(raw.home_club_id) === String(ourClubId);
  const isAway = String(raw.away_club_id) === String(ourClubId);
  if (!isHome && !isAway) return null;

  const ourTeamName = isHome ? raw.home_team_name : raw.away_team_name;
  const oppTeamName = isHome ? raw.away_team_name : raw.home_team_name;
  const oppClubName = isHome ? raw.away_club_name : raw.home_club_name;

  const match = {
    source: 'playcricket',
    play_cricket_match_id: toNum(raw.id ?? raw.match_id),
    season: season ?? (raw.match_date ? Number(raw.match_date.split('/')[2]) : null),
    match_date: ddmmyyyyToIso(raw.match_date),
    match_time: raw.match_time || null,
    team_name: ourTeamName,
    opposition_name: oppClubName ? `${oppClubName} ${oppTeamName || ''}`.trim() : oppTeamName,
    venue: raw.ground_name || null,
    home_or_away: isHome ? 'H' : 'A',
    competition_name: raw.competition_name || raw.league_name || null,
    competition_type: raw.competition_type || null,
    result: null,
    result_description: null,
    toss: null,
    our_total: null,
    opposition_total: null,
    last_updated: raw.last_updated || null,
  };

  return { match, innings: [] };
}

module.exports = { parseFixture };
