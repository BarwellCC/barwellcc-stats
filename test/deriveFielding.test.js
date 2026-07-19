// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/deriveFielding.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { parseMatchDetail } = require('../scripts/parseMatchDetail');
const { insertMatch } = require('../scripts/insertMatch');
const { deriveFielding } = require('../scripts/deriveFielding');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sample-match-detail.json'), 'utf8')
);
const raw = sample.match_details[0];

// Same fixture as run-test.js: "us" (Chingford CC) bat first (innings 0,
// is_us=1) then bowl (innings 1, is_us=0). Innings 1 has one dismissal -
// Smoke Duck ct Mars Leonard - and Mars Leonard is one of "our" (Chingford
// CC) players, confirming the catch belongs to us.
// Innings 0 also has a catch (Mars Leonard ct Smoke Duck), but that one was
// taken by the opposition off our batting, so it must NOT show up here.
const parsed = parseMatchDetail(raw, { ourClubId: '1835', season: 2017 });

const dbPath = path.join(__dirname, 'test-fielding.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
const { openDb } = require('../scripts/db');
const db = openDb();

insertMatch(db, parsed);
const { rows, unmatched } = deriveFielding(db);

assert.strictEqual(unmatched, 0, 'every fielder in this fixture is a known player');
assert.strictEqual(rows, 1, 'exactly one fielding row: our catch in the innings we bowled');

const marsLeonard = db.prepare('SELECT id FROM players WHERE name = ?').get('Mars Leonard');
const fielding = db.prepare('SELECT * FROM fielding_performances WHERE player_id = ?').get(marsLeonard.id);
assert.ok(fielding, 'Mars Leonard should have a fielding_performances row');
assert.strictEqual(fielding.catches, 1);
assert.strictEqual(fielding.stumpings, 0);
assert.strictEqual(fielding.run_outs, 0);

const smokeDuck = db.prepare('SELECT id FROM players WHERE name = ?').get('Smoke Duck');
const oppFielding = db.prepare('SELECT * FROM fielding_performances WHERE player_id = ?').get(smokeDuck.id);
assert.strictEqual(oppFielding, undefined, "the opposition's catch off our batting must not be attributed to us");

console.log('deriveFielding: PASS');

// Re-running (simulating a re-sync) should rebuild, not duplicate.
deriveFielding(db);
const count = db.prepare('SELECT COUNT(*) AS c FROM fielding_performances').get().c;
assert.strictEqual(count, 1, 'fielding_performances should not accumulate duplicates on re-run');
console.log('deriveFielding re-run idempotency: PASS');

db.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

console.log('\nAll tests passed.');
