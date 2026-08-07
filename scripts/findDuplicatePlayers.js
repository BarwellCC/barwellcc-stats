require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { matchPlayers, splitPlayCricketName } = require('./matchPlayersCore');
const { normalize } = require('./normalizeName');
const { excludedPlayersClause } = require('./excludedPlayers');

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
// A function rather than a plain query string, since the exclusion list
// (scripts/excludedPlayers.js) is loaded at runtime, not fixed at require
// time - see excludedPlayersClause()'s own comment.
function getBarwellPlayers(db) {
  const { clause, params } = excludedPlayersClause('p.name');
  return db.prepare(`
    SELECT DISTINCT p.id, p.name, p.play_cricket_id FROM players p
    WHERE ${clause} AND (EXISTS (
      SELECT 1 FROM batting_performances bp JOIN innings i ON i.id = bp.innings_id
      WHERE bp.player_id = p.id AND i.is_us = 1
        AND (bp.how_out IS NULL OR bp.how_out != 'did not bat')
    ) OR EXISTS (
      SELECT 1 FROM bowling_performances bw JOIN innings i ON i.id = bw.innings_id
      WHERE bw.player_id = p.id AND i.is_us = 0
    ))
  `).all(...params);
}

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

// Names that don't look like a real person at all - a different problem
// from findDuplicatePlayers() above (two rows for the same real person).
// Three known real-world causes so far, all worth flagging separately
// rather than silently living in the players list forever:
//   - Literal test/placeholder data (e.g. "Test Test") - not a real name,
//     just leftover from testing the sync/scraper against a live system.
//   - A bare "- Surname" - Play-Cricket's own convention when a scorer adds
//     a player to a scorecard without picking a name from the club's squad
//     dropdown, so no first name ever gets recorded. Confirmed against a
//     real example (2010-08-05 Hinckley Amateur match, batsman_id 2469849,
//     Play-Cricket's own API literally returns "batsman_name": "- Moran").
//   - An initial standing in for a first name (e.g. "A Jones") - common in
//     the historic scrape, where the club's own old site sometimes only
//     recorded an initial. 26 of these currently exist among genuine
//     Barwell appearances (confirmed via a live count), 16 with at least
//     one plausible fuller-name candidate already on file.
// All three are genuinely ambiguous without local knowledge (several
// different players can share a surname), so this only ever surfaces
// same-surname candidates as a hint - never auto-merges.
const TEST_NAME_RE = /\btest\b/i;
const MISSING_FIRST_NAME_RE = /^-\s+(\S.*)$/;
const INITIAL_ONLY_RE = /^[A-Za-z]\.?\s+(\S.+)$/;

function findSuspiciousNames(players) {
  // Same dismissal mechanism findDuplicatePlayers() uses (see
  // loadDismissedPairs()'s own comment) - a human confirming "P Allen" and
  // "Dec Allen" are two different people shouldn't mean it keeps coming
  // back as a same-surname candidate on every rebuild.
  const dismissed = loadDismissedPairs();
  const results = [];
  for (const p of players) {
    const name = p.name;
    let reason = null;
    const missingFirstName = name.match(MISSING_FIRST_NAME_RE);
    // Excludes "A N Other" - a spelling variant of the already-known-fake
    // "A.N. Other" placeholder (see scripts/excludedPlayers.js), not a
    // genuine initial-only name; it happens to match the same shape by
    // coincidence.
    const initialOnly = !missingFirstName && name.toLowerCase() !== 'a n other' && name.match(INITIAL_ONLY_RE);

    if (TEST_NAME_RE.test(name)) {
      reason = 'Looks like placeholder/test data, not a real name';
    } else if (missingFirstName) {
      reason = 'Missing first name - Play-Cricket records a bare surname like this when a scorer adds a player without picking one from the squad list';
    } else if (initialOnly) {
      reason = 'Only an initial for a first name - could be the same person as someone recorded elsewhere under their full first name';
    } else if (/^[^a-zA-Z]*$/.test(name)) {
      reason = 'Contains no letters at all';
    } else if (/\d/.test(name)) {
      reason = 'Contains a digit - unusual for a real name';
    } else if (name !== name.trim() || /\s{2,}/.test(name)) {
      reason = 'Irregular spacing (leading/trailing or doubled)';
    } else if (name.replace(/\s/g, '').length <= 2) {
      reason = 'Suspiciously short for a real name';
    }
    if (!reason) continue;

    // For the missing-first-name and initial-only cases, surface every
    // other player who shares the surname (and, for initial-only, isn't
    // itself just another initial-only name) - a human who knows the club
    // can tell which one (if any) this record actually is. Not attempted
    // for other reasons (e.g. "Test Test" has no real surname to match).
    let candidates = [];
    const surnameSource = missingFirstName || initialOnly;
    if (surnameSource) {
      const surname = surnameSource[1].trim().toLowerCase();
      candidates = players
        .filter((other) => other.id !== p.id
          && other.name.toLowerCase().endsWith(surname)
          && !INITIAL_ONLY_RE.test(other.name)
          && !dismissed.has([name, other.name].sort().join('|')))
        .map((other) => ({ id: other.id, name: other.name, play_cricket_id: other.play_cricket_id }));
    }

    results.push({ player: p, reason, candidates });
  }
  return results;
}

// A suspicious name with at least one same-surname candidate is really a
// possible-duplicate lead, same as findDuplicatePlayers()'s pairs - just
// found by a different heuristic (an incomplete name matching a fuller one,
// rather than a nickname/spelling variant of an otherwise-normal name). Fold
// those into the same "Needs review" list rather than a separate,
// lower-visibility one, so they get looked at the same way. Only a name
// with genuinely nothing to compare against (no candidate at all, e.g.
// "Test Test" or a one-off surname with no other player on file) has
// nowhere else useful to go and stays in "Suspicious names".
//
// One promoted entry per suspicious name, carrying *all* its candidates
// together (not one entry per candidate) - a common surname with several
// same-surname players (e.g. "C Baker" against five different Bakers)
// should read as one card with several options, not several near-identical
// cards each claiming the same incomplete name against a different person.
function promoteSuspiciousToPairs(suspicious) {
  const promoted = [];
  const stillSuspicious = [];
  for (const s of suspicious) {
    if (s.candidates.length === 0) {
      stillSuspicious.push(s);
      continue;
    }
    promoted.push({
      a: s.player,
      candidates: s.candidates,
      matchType: 'incomplete',
      // Deliberately lower than a nickname/fuzzy match (0.8-0.9) - an
      // incomplete name matching a same-surname candidate is a much
      // weaker signal, especially a common surname with several
      // candidates, where at most one (if any) can be right.
      confidence: 0.4,
      reason: s.reason,
    });
  }
  return { promoted, stillSuspicious };
}

function main() {
  const { openDb } = require('./db');
  const db = openDb();
  const players = getBarwellPlayers(db);
  const { promoted, stillSuspicious } = promoteSuspiciousToPairs(findSuspiciousNames(players));
  const candidates = [...findDuplicatePlayers(players), ...promoted];
  db.close();

  if (candidates.length === 0) {
    console.log('No likely duplicate player names found.');
  } else {
    console.log(`${candidates.length} likely duplicate pair(s):\n`);
    for (const c of candidates) {
      console.log(`"${c.a.name}" (id ${c.a.id}) <-> "${c.b.name}" (id ${c.b.id})`);
      console.log(`  ${c.matchType}, confidence ${c.confidence} - ${c.reason}`);
    }
  }

  if (stillSuspicious.length > 0) {
    console.log(`\n${stillSuspicious.length} suspicious name(s) with nothing to compare against:\n`);
    for (const s of stillSuspicious) {
      console.log(`"${s.player.name}" (id ${s.player.id}) - ${s.reason}`);
    }
  }

  console.log('\nReview these at site/duplicates.html, then confirm in data/player-merges.json.');
}

if (require.main === module) {
  main();
}

module.exports = { findDuplicatePlayers, findSuspiciousNames, promoteSuspiciousToPairs, getBarwellPlayers };
