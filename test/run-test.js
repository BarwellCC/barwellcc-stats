// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/run-test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const { parseMatchDetail } = require('../scripts/parseMatchDetail');
const { insertMatch } = require('../scripts/insertMatch');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sample-match-detail.json'), 'utf8')
);
const raw = sample.match_details[0];

// Treat "Chingford CC" as if it were "us" for this test.
const parsed = parseMatchDetail(raw, { ourClubId: '1835', season: 2017 });

assert.strictEqual(parsed.match.season, 2017);
assert.strictEqual(parsed.match.home_or_away, 'H');
assert.strictEqual(parsed.match.team_name, '3rd XI');
assert.strictEqual(parsed.match.opposition_name, 'Chingford Quackers CC 2nd XI');
// result_applied_to (208057) is the away team's id, and result_description
// confirms Chingford Quackers CC (away) won - so from "our" (home) side this is a loss.
assert.strictEqual(parsed.match.result, 'L');
assert.strictEqual(parsed.innings.length, 2);
assert.strictEqual(parsed.innings[0].is_us, 1, 'first innings should be flagged as us batting');
assert.strictEqual(parsed.innings[1].is_us, 0, 'second innings should be flagged as opposition batting');
console.log('parseMatchDetail: PASS');

// Now push it through a real (in-memory) SQLite DB end to end.
const dbPath = path.join(__dirname, 'test.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
const { openDb } = require('../scripts/db');
const db = openDb();

insertMatch(db, parsed);

const matchRow = db.prepare('SELECT * FROM matches WHERE play_cricket_match_id = ?').get(123456);
assert.ok(matchRow, 'match should have been inserted');
assert.strictEqual(matchRow.result, 'L');

const chewLeonard = db.prepare('SELECT * FROM players WHERE name = ?').get('Chew Leonard');
assert.ok(chewLeonard, 'batter should exist as a player');

const battingRow = db
  .prepare(
    `SELECT bp.* FROM batting_performances bp
     JOIN players p ON p.id = bp.player_id
     WHERE p.name = ? `
  )
  .get('Mars Leonard');
assert.strictEqual(battingRow.runs, 50);
assert.strictEqual(battingRow.how_out, 'ct');
console.log('insertMatch + queries: PASS');

// Re-run the same insert (simulating a nightly re-sync) and confirm no duplicates.
insertMatch(db, parsed);
const matchCount = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
const battingCount = db.prepare('SELECT COUNT(*) AS c FROM batting_performances').get().c;
assert.strictEqual(matchCount, 1, 'match should not be duplicated on re-sync');
assert.strictEqual(battingCount, 6, 'batting rows should not be duplicated on re-sync (3 per innings x 2)');
console.log('re-sync idempotency: PASS');

db.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

console.log('\nAll tests passed.');
