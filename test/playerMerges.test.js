// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/playerMerges.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { findDuplicatePlayers, findSuspiciousNames, promoteSuspiciousToPairs } = require('../scripts/findDuplicatePlayers');

// --- findDuplicatePlayers: same list scanned against itself ---
const players = [
  { id: 1, name: 'Daniel King', play_cricket_id: 5271579 },
  { id: 2, name: 'Dan King', play_cricket_id: null },
  { id: 3, name: 'Tom Wright', play_cricket_id: 4328992 },
  { id: 4, name: 'Tommy Wright', play_cricket_id: null },
  { id: 5, name: 'Darren Roach', play_cricket_id: 102 }, // no duplicate - shouldn't appear at all
];

const candidates = findDuplicatePlayers(players);
const pairNames = candidates.map((c) => [c.a.name, c.b.name].sort().join(' / '));

assert.ok(pairNames.includes('Dan King / Daniel King'), 'should flag the King nickname pair');
assert.ok(pairNames.includes('Tom Wright / Tommy Wright'), 'should flag the Wright nickname pair');
assert.strictEqual(candidates.length, 2, 'should report each pair once, and not flag Darren Roach against anyone');
assert.ok(candidates.every((c) => c.matchType === 'nickname'), 'these are known nickname-group matches');
console.log('findDuplicatePlayers: PASS');

// --- findSuspiciousNames: individual malformed/incomplete records ---
const suspiciousPlayers = [
  { id: 10, name: 'Danny Moran', play_cricket_id: 271740 },
  { id: 11, name: '- Moran', play_cricket_id: 2469849 }, // real example: Play-Cricket's own bare-surname convention
  { id: 12, name: 'Test Test', play_cricket_id: null },
  { id: 13, name: 'Adam Stapleford-Jones', play_cricket_id: 5412560 },
  { id: 14, name: 'A Jones', play_cricket_id: 755827 }, // initial-only, real example
  { id: 15, name: 'A N Other', play_cricket_id: null }, // spelling variant of the known "A.N. Other" placeholder - should NOT be flagged
  { id: 16, name: 'Joe Smith', play_cricket_id: 123 }, // ordinary name - should NOT be flagged
  { id: 17, name: 'C Turner', play_cricket_id: null }, // initial-only with TWO same-surname candidates
  { id: 18, name: 'Chris Turner', play_cricket_id: 456 },
  { id: 19, name: 'Carl Turner', play_cricket_id: 789 },
];

const suspicious = findSuspiciousNames(suspiciousPlayers);
const suspiciousNames = suspicious.map((s) => s.player.name);

assert.ok(suspiciousNames.includes('- Moran'), 'should flag the bare-surname "- Moran"');
assert.ok(suspiciousNames.includes('Test Test'), 'should flag literal test data');
assert.ok(suspiciousNames.includes('A Jones'), 'should flag the initial-only "A Jones"');
assert.ok(!suspiciousNames.includes('A N Other'), 'should not flag "A N Other" - it\'s the known fake placeholder, not a real incomplete name');
assert.ok(!suspiciousNames.includes('Joe Smith'), 'should not flag an ordinary full name');
assert.ok(!suspiciousNames.includes('Danny Moran'), 'should not flag the real, complete name in a pair');

const moranEntry = suspicious.find((s) => s.player.name === '- Moran');
assert.ok(moranEntry.candidates.some((c) => c.name === 'Danny Moran'), '"- Moran" should surface "Danny Moran" as a same-surname candidate');

const jonesEntry = suspicious.find((s) => s.player.name === 'A Jones');
assert.ok(jonesEntry.candidates.some((c) => c.name === 'Adam Stapleford-Jones'), '"A Jones" should surface "Adam Stapleford-Jones" as a same-surname candidate');

const testEntry = suspicious.find((s) => s.player.name === 'Test Test');
assert.strictEqual(testEntry.candidates.length, 0, '"Test Test" has no real surname to match candidates against');
console.log('findSuspiciousNames: PASS');

// --- promoteSuspiciousToPairs: a suspicious name with a candidate becomes
// a "Needs review" entry (site/duplicates.html folds these into the same
// list as findDuplicatePlayers()'s pairs) - one entry per suspicious name,
// carrying *all* its candidates, not one entry per candidate (a common
// surname with several candidates should read as one card with several
// options, not several cards). One with nothing to compare against stays
// in "Suspicious names" ---
const { promoted, stillSuspicious } = promoteSuspiciousToPairs(suspicious);

const moranPromoted = promoted.find((p) => p.a.name === '- Moran');
assert.ok(moranPromoted, '"- Moran" should be promoted');
assert.ok(moranPromoted.candidates.some((c) => c.name === 'Danny Moran'), '"- Moran" should carry "Danny Moran" as a candidate');

const jonesPromoted = promoted.find((p) => p.a.name === 'A Jones');
assert.ok(jonesPromoted, '"A Jones" should be promoted');
assert.ok(jonesPromoted.candidates.some((c) => c.name === 'Adam Stapleford-Jones'), '"A Jones" should carry "Adam Stapleford-Jones" as a candidate');

const turnerPromoted = promoted.filter((p) => p.a.name === 'C Turner');
assert.strictEqual(turnerPromoted.length, 1, '"C Turner" with two candidates should still be exactly ONE promoted entry, not two');
assert.strictEqual(turnerPromoted[0].candidates.length, 2, 'that one entry should carry both "Chris Turner" and "Carl Turner" as candidates');

assert.ok(promoted.every((p) => p.matchType === 'incomplete'), 'promoted entries use their own matchType, not nickname/fuzzy');

const stillSuspiciousNames = stillSuspicious.map((s) => s.player.name);
assert.ok(stillSuspiciousNames.includes('Test Test'), '"Test Test" has no candidate, so it stays in Suspicious names');
assert.ok(!stillSuspiciousNames.includes('- Moran'), '"- Moran" was promoted, so it should no longer be in Suspicious names');
assert.ok(!stillSuspiciousNames.includes('A Jones'), '"A Jones" was promoted, so it should no longer be in Suspicious names');

// --- findSuspiciousNames respects data/duplicate-dismissals.json too, not
// just findDuplicatePlayers()'s pairs - a same-surname candidate a human
// has already ruled out shouldn't keep coming back as a "Needs review"
// entry on every rebuild. Uses the real "P Allen"/"Dec Allen" dismissal
// rather than a fake one, so this breaks loudly if that entry is ever
// removed from data/duplicate-dismissals.json. ---
const dismissals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'duplicate-dismissals.json'), 'utf8'));
const allenDismissal = dismissals.find((d) => [d.a, d.b].sort().join('|') === ['P Allen', 'Dec Allen'].sort().join('|'));
assert.ok(allenDismissal, 'data/duplicate-dismissals.json should still have the P Allen / Dec Allen dismissal');

const allenPlayers = [
  { id: 20, name: 'P Allen', play_cricket_id: null },
  { id: 21, name: 'Dec Allen', play_cricket_id: 111 },
];
const allenSuspicious = findSuspiciousNames(allenPlayers);
const pAllenEntry = allenSuspicious.find((s) => s.player.name === 'P Allen');
assert.ok(pAllenEntry, '"P Allen" should still be flagged as suspicious (initial-only)');
assert.strictEqual(pAllenEntry.candidates.length, 0, 'the dismissed "Dec Allen" candidate should be filtered out, leaving none');
console.log('findSuspiciousNames respects duplicate-dismissals.json: PASS');
console.log('promoteSuspiciousToPairs: PASS');

// --- scripts/db.js: a confirmed merge redirects the alias name to the
// canonical player id, and folds in any performances already recorded
// against a pre-existing alias row - both matter because data/barwellcc.db
// is rebuilt from scratch on every deploy, so this has to be re-derived
// from data/player-merges.json every run, not fixed once in the database ---
const dbPath = path.join(__dirname, 'test-playermerges.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
const { openDb, getOrCreatePlayer } = require('../scripts/db');

// Uses a real pair from data/player-merges.json rather than a fake one, so
// this test breaks (loudly) if that file's confirmed merges ever change
// shape - a cheap guard against silently losing a confirmed decision.
const merges = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'player-merges.json'), 'utf8'));
const kingMerge = merges.find((m) => (typeof m.canonical === 'string' ? m.canonical : m.canonical.name) === 'Daniel King');
assert.ok(kingMerge && kingMerge.aliases.some((a) => a.name === 'Dan King'), 'data/player-merges.json should still map Dan King -> Daniel King');

const db = openDb();

// Simulates the alias row already existing (e.g. a long-lived local db from
// before this merge was confirmed) with a performance recorded against it.
const aliasId = db.prepare('INSERT INTO players (name) VALUES (?)').run('Dan King').lastInsertRowid;
const matchId = db.prepare(
  `INSERT INTO matches (source, season, match_date) VALUES ('historic', 2015, '2015-05-01')`
).run().lastInsertRowid;
const inningsId = db.prepare(
  `INSERT INTO innings (match_id, innings_number, batting_team_name, is_us, runs, wickets) VALUES (?, 1, 'Barwell CC', 1, 200, 5)`
).run(matchId).lastInsertRowid;
db.prepare(
  `INSERT INTO batting_performances (innings_id, player_id, runs) VALUES (?, ?, 42)`
).run(inningsId, aliasId);

// Re-opening the db re-runs applyPlayerMerges() - the alias row should be
// folded into the canonical row, not left standing.
db.close();
delete require.cache[require.resolve('../scripts/db')];
const { openDb: reopenDb } = require('../scripts/db');
const db2 = reopenDb();

const aliasRow = db2.prepare('SELECT id FROM players WHERE name = ?').get('Dan King');
assert.strictEqual(aliasRow, undefined, 'the alias player row should no longer exist after the merge is applied');

const canonicalRow = db2.prepare('SELECT id FROM players WHERE name = ?').get('Daniel King');
assert.ok(canonicalRow, 'the canonical player row should exist');

const perf = db2.prepare('SELECT runs FROM batting_performances WHERE player_id = ?').get(canonicalRow.id);
assert.ok(perf, 'the alias row\'s performance should have been reassigned to the canonical player id');
assert.strictEqual(perf.runs, 42);
console.log('applyPlayerMerges folds an existing alias row into the canonical row: PASS');

// A brand-new insert under the alias name should resolve straight to the
// canonical player id, never creating a second "Dan King" row.
const resolvedId = getOrCreatePlayer(db2, 'Dan King', null);
assert.strictEqual(resolvedId, canonicalRow.id, 'a fresh insert under the alias name should resolve to the canonical id');
const playerCount = db2.prepare("SELECT COUNT(*) c FROM players WHERE name IN ('Dan King', 'Daniel King')").get().c;
assert.strictEqual(playerCount, 1, 'still exactly one row between the two names');
console.log('getOrCreatePlayer redirects a known alias to its canonical id: PASS');

db2.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

console.log('\nAll tests passed.');
