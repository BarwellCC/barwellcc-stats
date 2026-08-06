require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { matchPlayers, splitPlayCricketName } = require('./matchPlayersCore');
const { normalize } = require('./normalizeName');

const DISMISSALS_PATH = path.join(__dirname, '..', 'data', 'duplicate-dismissals.json');

// The `players` table isn't only Barwell people: Play-Cricket's per-innings
// batting/bowling cards get inserted unfiltered by scripts/insertMatch.js
// (unlike the historic scraper, which deliberately only ever captures our
// own side - see scripts/parseScorecardPage.js), so an opposition batter or
// bowler from any given match ends up with their own real `players` row and
// real figures too - just never displayed, since every query that builds
// the public site filters by is_us. A squad member who was selected but
// never actually got a real knock/spell (only a "did not bat" row, or a
// player row orphaned by a Play-Cricket scorecard correction wiping their
// only innings) is the same problem from a different angle. Duplicate
// detection has to apply the identical "genuine Barwell involvement" test
// buildPlayers() in scripts/buildStatic.js uses for the public player list
// - otherwise it flags (and appearance-counts) opposition players and
// no-shows as if they were real candidates for a Barwell merge decision.
const BARWELL_PLAYERS_SQL = `
  SELECT DISTINCT p.id, p.name, p.play_cricket_id FROM players p
  WHERE p.name NOT IN ('Unsure', 'Selected member not found', 'A.N. Other') AND (EXISTS (
    SELECT 1 FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
    WHERE bp.player_id = p.id AND i.is_us = 1
      AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')
  ) OR EXISTS (
    SELECT 1 FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
    WHERE bw.player_id = p.id AND i.is_us = 0
  ))
`;

// A pair a human has already looked at and confirmed are two different real
// people (see data/duplicate-dismissals.json) shouldn't keep coming back on
// every rebuild just because their names still look similar - name-based,
// not id-based, since the whole point is "these two people," which outlives
// any particular players.id.
function loadDismissedPairs() {
  if (!fs.existsSync(DISMISSALS_PATH)) return new Set();
  const dismissals = JSON.parse(fs.readFileSync(DISMISSALS_PATH, 'utf8'));
  return new Set(dismissals.map((d) => [d.a, d.b].sort().join('|')));
}

// "Geoff Hines Jnr" vs "Geoff Hines Snr" (etc.) never reaches the
// nickname/fuzzy checks below - splitPlayCricketName treats "Jnr"/"Snr" as
// the surname, and "jnr" vs "snr" isn't a close enough spelling match to
// clear FUZZY_SURNAME_THRESHOLD. Deliberately caught separately, and kept
// as its own low-confidence matchType rather than folded into "fuzzy":
// a Jnr/Snr pair is at least as likely to be two real, different people
// (father and son both playing for the club) as it is a labelling
// inconsistency for one person - this needs a human who knows the club,
// not an auto-merge rule.
const GENERATION_SUFFIX = /\s+(jnr|jr|snr|sr)\.?$/;

function stripGenerationSuffix(name) {
  return normalize(name).replace(GENERATION_SUFFIX, '').trim();
}

function findGenerationalSuffixCandidates(players, seen) {
  const groups = new Map();
  for (const player of players) {
    const base = stripGenerationSuffix(player.name);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(player);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((p) => GENERATION_SUFFIX.test(normalize(p.name)))) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const pairKey = [group[i].id, group[j].id].sort((a, b) => a - b).join('-');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        out.push({
          a: group[i],
          b: { id: group[j].id, name: group[j].name, play_cricket_id: group[j].play_cricket_id },
          matchType: 'suffix',
          confidence: 0.5,
          reason: `"${group[i].name}" and "${group[j].name}" share a base name but differ by a Jnr/Snr-style suffix - could be the same person labelled inconsistently, or two different relatives (e.g. father & son)`,
        });
      }
    }
  }
  return out;
}

// Compares every `players` row's name against every other one (unlike
// matchPlayersCore's usual xlsx-vs-Play-Cricket use, this runs the same
// list against itself) to flag likely duplicate rows - most often a
// nickname or spelling variant that ended up as two separate players
// because the historic scraper and the Play-Cricket sync captured the same
// real person under two different spellings. Never auto-merges: confirmed
// pairs live in data/player-merges.json, applied in scripts/db.js.
function findDuplicatePlayers(players) {
  // matchOnePlayer (inside matchPlayers) returns early on an exact match, so
  // comparing the full list against itself would always short-circuit on
  // each player's exact match to itself and never reach the nickname/fuzzy
  // checks that actually matter here - matching one player at a time
  // against everyone *else* avoids that.
  const seen = new Set();
  const candidates = [];
  for (const player of players) {
    const others = players.filter((p) => p.id !== player.id);
    const { firstName, surname } = splitPlayCricketName(player.name);
    const [result] = matchPlayers([{ firstName, surname }], others);
    if (!result || result.matchType === 'none') continue;
    for (const c of result.candidates) {
      const pairKey = [player.id, c.id].sort((a, b) => a - b).join('-');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      candidates.push({
        a: player,
        b: { id: c.id, name: c.name, play_cricket_id: c.play_cricket_id },
        matchType: result.matchType,
        confidence: c.confidence,
        reason: c.reason,
      });
    }
  }
  candidates.push(...findGenerationalSuffixCandidates(players, seen));

  const dismissed = loadDismissedPairs();
  const notDismissed = candidates.filter((c) => !dismissed.has([c.a.name, c.b.name].sort().join('|')));

  return notDismissed.sort((x, y) => y.confidence - x.confidence);
}

function main() {
  const { openDb } = require('./db');
  const db = openDb();
  const players = db.prepare(BARWELL_PLAYERS_SQL).all();
  const candidates = findDuplicatePlayers(players);
  db.close();

  if (candidates.length === 0) {
    console.log('No likely duplicate player names found.');
    return;
  }
  console.log(`${candidates.length} likely duplicate pair(s):\n`);
  for (const c of candidates) {
    console.log(`"${c.a.name}" (id ${c.a.id}) <-> "${c.b.name}" (id ${c.b.id})`);
    console.log(`  ${c.matchType}, confidence ${c.confidence} - ${c.reason}`);
  }
  console.log('\nReview these at site/duplicates.html, then confirm in data/player-merges.json.');
}

if (require.main === module) {
  main();
}

module.exports = { findDuplicatePlayers, BARWELL_PLAYERS_SQL };
