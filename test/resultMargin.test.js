// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/resultMargin.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { parseMatchDetail } = require('../scripts/parseMatchDetail');
const { insertMatch } = require('../scripts/insertMatch');
const { describeResult } = require('../server/resultMargin');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sample-match-detail.json'), 'utf8')
);
const raw = sample.match_details[0];

// Same fixture as run-test.js: "us" (Chingford CC) bat first and score
// 100/2, the opposition chase it down at 101/1 (9 wickets in hand) - a win
// for the opposition, which is why parseMatchDetail flips the raw 'W'
// (applied to the away team) into 'L' for us. Real cricket phrasing states
// the winning margin from the winner's side regardless of who "us" is, so
// this should read "Won by 9 wickets" even though the result is a loss for us.
const parsed = parseMatchDetail(raw, { ourClubId: '1835', season: 2017 });
assert.strictEqual(parsed.match.result, 'L');

const dbPath = path.join(__dirname, 'test-resultmargin.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
const { openDb } = require('../scripts/db');
const db = openDb();

const matchId = insertMatch(db, parsed);
const usInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 1').get(matchId);
const oppInnings = db.prepare('SELECT * FROM innings WHERE match_id = ? AND is_us = 0').get(matchId);

assert.ok(usInnings.id < oppInnings.id, 'us batted first in this fixture, so should have the lower innings id');
assert.strictEqual(
  describeResult('L', usInnings, oppInnings),
  'Won by 9 wickets',
  'margin is stated from the winning side, not "us" - a loss where the chasing team had 9 wickets in hand'
);
console.log('describeResult (chase win): PASS');

// Flip the roles: if "we" are the team that batted first and successfully
// defended (opposition all out short), the margin is runs, not wickets.
assert.strictEqual(
  describeResult('W', { id: 1, runs: 180, wickets: 6 }, { id: 2, runs: 150, wickets: 10 }),
  'Won by 30 runs'
);
console.log('describeResult (defended win): PASS');

// A single-wicket/run margin needs the singular, not "1 wickets"/"1 runs".
assert.strictEqual(
  describeResult('W', { id: 1, runs: 200, wickets: 5 }, { id: 2, runs: 201, wickets: 9 }),
  'Won by 1 wicket'
);
assert.strictEqual(
  describeResult('L', { id: 1, runs: 150, wickets: 4 }, { id: 2, runs: 149, wickets: 10 }),
  'Won by 1 run'
);
console.log('describeResult (singular units): PASS');

// Non-decisive or scoreless results fall back to the plain label, not a
// fabricated margin.
assert.strictEqual(describeResult('T', { id: 1, runs: 150, wickets: 8 }, { id: 2, runs: 150, wickets: 6 }), 'Tied');
assert.strictEqual(describeResult('A', null, null), 'Abandoned');
assert.strictEqual(describeResult('CON', null, null), 'Conceded');
assert.strictEqual(describeResult(null, null, null), null, 'no result yet (upcoming fixture) - nothing to describe');
console.log('describeResult (non-decisive fallbacks): PASS');

db.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

console.log('\nAll tests passed.');
