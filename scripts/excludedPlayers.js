// Names that should never appear as their own row anywhere on the site -
// two different sources, both handled the same way:
//   - Known-fake placeholder strings that aren't a real person at all.
//     Four are Play-Cricket's/the club's own sentinel values for an
//     unidentified player (see README.md's "Known behaviors" section);
//     "Test Test" turned out to be the same kind of problem despite
//     looking like ordinary test data - confirmed via a live count (91
//     "did not bat" rows across matches, one real dismissal - a squad-
//     filler role, not a genuine person, same as "A.N. Other").
//   - Individual names confirmed, by hand, via site/duplicates.html's
//     "Suspicious names" section, to have no real identity worth tracking
//     (an incomplete/malformed name - see
//     scripts/findDuplicatePlayers.js's findSuspiciousNames() - with no
//     plausible match to merge into instead). Recorded in
//     data/excluded-players.json rather than hardcoded here, so a review
//     decision doesn't require a code change.
const fs = require('fs');
const path = require('path');

const EXCLUDED_PATH = path.join(__dirname, '..', 'data', 'excluded-players.json');

const KNOWN_FAKE_NAMES = ['Unsure', 'Selected member not found', 'A.N. Other', 'A N Other', 'Test Test', 'T.B.C'];

// Cached per process, same reasoning as scripts/db.js's player-merges
// cache - data/excluded-players.json only changes when someone confirms a
// new exclusion, not per query.
let cache = null;
function loadExcludedPlayerNames() {
  if (!cache) {
    const confirmed = fs.existsSync(EXCLUDED_PATH)
      ? JSON.parse(fs.readFileSync(EXCLUDED_PATH, 'utf8'))
      : [];
    cache = [...KNOWN_FAKE_NAMES, ...confirmed];
  }
  return cache;
}

// Builds a `<column> NOT IN (?, ?, ...)` SQL fragment plus the matching
// bound params, since the excluded-name list is loaded at runtime (not a
// fixed count known when the query is written) - callers splice the clause
// into their own SQL and spread the params into their own .all()/.get()
// call, alongside any params of their own.
function excludedPlayersClause(column) {
  const names = loadExcludedPlayerNames();
  const placeholders = names.map(() => '?').join(', ');
  return { clause: `${column} NOT IN (${placeholders})`, params: names };
}

module.exports = { loadExcludedPlayerNames, excludedPlayersClause, KNOWN_FAKE_NAMES };
