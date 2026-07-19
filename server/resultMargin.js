// Turns a match result code + both innings into the human-readable summary
// used on both the scorecard and fixtures pages ("Won by 4 wickets", "Won
// by 23 runs", "Tied", ...), so the wording only lives in one place.
//
// Cricket convention states the winning margin from the WINNING side's own
// perspective, not "our" perspective - "Won by 4 wickets" is said whether
// Barwell won or lost, with the W/L result pill elsewhere on the page
// carrying the us-relative meaning. Getting the margin right needs knowing
// which side batted first, which `innings.innings_number` can't tell you -
// Play-Cricket sends `1` for every single-innings-per-side match on both
// sides (confirmed against their own documented sample payload), it means
// "this team's Nth innings", not "Nth innings of the match". The `innings`
// table's own autoincrementing `id` is the reliable signal instead:
// scripts/insertMatch.js inserts both innings, in the same order Play-Cricket
// lists them (which is chronological), inside one transaction, every sync -
// so the lower id is always the innings that happened first.

const RESULT_LABELS = { W: 'Won', L: 'Lost', T: 'Tied', D: 'Drawn', A: 'Abandoned', C: 'Cancelled', CON: 'Conceded' };

function describeResult(result, usInnings, oppInnings) {
  if (!result) return null; // upcoming fixture, nothing to describe yet

  if ((result === 'W' || result === 'L') && usInnings && oppInnings) {
    const usBattedFirst = usInnings.id < oppInnings.id;
    const first = usBattedFirst ? usInnings : oppInnings;
    const second = usBattedFirst ? oppInnings : usInnings;

    if (second.runs > first.runs) {
      const wkts = 10 - second.wickets;
      return `Won by ${wkts} ${wkts === 1 ? 'wicket' : 'wickets'}`;
    }
    if (second.runs < first.runs) {
      const runs = first.runs - second.runs;
      return `Won by ${runs} ${runs === 1 ? 'run' : 'runs'}`;
    }
    // second.runs === first.runs alongside a W/L result shouldn't happen
    // (that's what result 'T' is for) - fall through to the plain label
    // rather than claiming a margin that isn't there.
  }

  return RESULT_LABELS[result] || result;
}

module.exports = { describeResult, RESULT_LABELS };
