require('dotenv').config();
const { matchPlayers, splitPlayCricketName } = require('./matchPlayersCore');
const { normalize } = require('./normalizeName');

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
  return candidates.sort((x, y) => y.confidence - x.confidence);
}

function main() {
  const { openDb } = require('./db');
  const db = openDb();
  const players = db.prepare('SELECT id, name, play_cricket_id FROM players').all();
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

module.exports = { findDuplicatePlayers };
