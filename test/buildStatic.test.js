// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/buildStatic.test.js
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
const parsed = parseMatchDetail(raw, { ourClubId: '1835', season: 2017 });

const dbPath = path.join(__dirname, 'test-buildstatic.db');
const outDir = path.join(__dirname, 'test-buildstatic-out');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
process.env.DB_PATH = dbPath;
process.env.STATIC_OUT_DIR = outDir;

const { openDb } = require('../scripts/db');
const db = openDb();
const matchId = insertMatch(db, parsed);
deriveFielding(db);
db.close();

// buildStatic.js requires ./db itself and opens its own connection using the
// same DB_PATH env var, so it picks up the same test database.
delete require.cache[require.resolve('../scripts/buildStatic')];
const { buildStatic } = require('../scripts/buildStatic');
buildStatic();

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(outDir, relPath), 'utf8'));
}

const matches = readJson('matches.json');
assert.strictEqual(matches.length, 1);
assert.strictEqual(matches[0].id, matchId);
assert.strictEqual(matches[0].result, 'L');
assert.strictEqual(matches[0].resultSummary, 'Lost by 9 wickets', 'verb follows the result (a loss for us)');
console.log('matches.json: PASS');

const scorecard = readJson(`scorecards/${matchId}.json`);
assert.strictEqual(scorecard.match.resultSummary, 'Lost by 9 wickets');
assert.strictEqual(scorecard.batting.length, 3, '3 batters in our (Chingford CC) innings');
assert.strictEqual(scorecard.bowling.length, 1, 'only 1 bowler recorded in our bowling figures (the innings we bowled)');
console.log('scorecards/{id}.json: PASS');

const battingRows = readJson('batting.json');
assert.strictEqual(battingRows.length, 3, 'only our batting rows (is_us=1), not the opposition\'s');
assert.ok(battingRows.every((r) => r.team_name === '3rd XI'));
console.log('batting.json: PASS');

const bowlingRows = readJson('bowling.json');
assert.strictEqual(bowlingRows.length, 1, 'only our bowling rows (is_us=0 innings - opposition batted, we bowled)');
console.log('bowling.json: PASS');

const fieldingRows = readJson('fielding.json');
assert.strictEqual(fieldingRows.length, 1, 'one catch, credited to Mars Leonard (our player) per test/deriveFielding.test.js');
console.log('fielding.json: PASS');

const players = readJson('players.json');
assert.ok(players.includes('Mars Leonard'), 'a real Barwell player made the list');
assert.ok(!players.includes('Smoke Duck'), 'an opposition-only player should not appear');
console.log('players.json: PASS');

fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
fs.rmSync(outDir, { recursive: true, force: true });

console.log('\nAll tests passed.');
