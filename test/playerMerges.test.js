// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/playerMerges.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { findDuplicatePlayers } = require('../scripts/findDuplicatePlayers');

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
const kingMerge = merges.find((m) => m.canonical === 'Daniel King');
assert.ok(kingMerge && kingMerge.aliases.includes('Dan King'), 'data/player-merges.json should still map Dan King -> Daniel King');

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
