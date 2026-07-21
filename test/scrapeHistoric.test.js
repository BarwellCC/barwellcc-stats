// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/scrapeHistoric.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { parseFixtureListPage } = require('../scripts/parseFixtureListPage');
const { parseScorecardPage, parseTimeText, normalizeHowOut } = require('../scripts/parseScorecardPage');

assert.strictEqual(parseTimeText('13:00'), '13:00');
assert.strictEqual(parseTimeText('1pm'), '13:00');
assert.strictEqual(parseTimeText('1. 30 PM'), '13:30');
assert.strictEqual(normalizeHowOut('Bowled'), 'b');
assert.strictEqual(normalizeHowOut('Caught'), 'ct');
assert.strictEqual(normalizeHowOut('Not Out'), 'not out');
console.log('parseTimeText/normalizeHowOut: PASS');

// --- Fixture list page (2025, 1st XI) ---
const fixtureListHtml = fs.readFileSync(path.join(__dirname, 'sample-fixturelist-2025.html'), 'utf8');
const fixtureRows = parseFixtureListPage(fixtureListHtml);
assert.strictEqual(fixtureRows.length, 24, '1st XI played 24 fixtures in the 2025 season');
const farnsfield = fixtureRows.find((r) => r.opposition === 'Farnsfield CC');
assert.ok(farnsfield, 'should find the Farnsfield CC fixture');
assert.strictEqual(farnsfield.fixtureId, '905560');
assert.strictEqual(farnsfield.dateStr, 'Sun 13 Apr 2025');
assert.strictEqual(farnsfield.homeOrAway, 'A');
assert.strictEqual(farnsfield.type, 'Cup');
assert.strictEqual(farnsfield.resultCode, 'L', 'result <span class="lost"> should map to L');
console.log('parseFixtureListPage: PASS');

// --- Scorecard page (2026, a win-by-chase example with a full extras breakdown) ---
const scorecard2026 = parseScorecardPage(
  fs.readFileSync(path.join(__dirname, 'sample-scorecard-2026.html'), 'utf8')
);
assert.strictEqual(scorecard2026.resultCode, 'L');
assert.strictEqual(scorecard2026.timeStr, '13:00');
assert.strictEqual(scorecard2026.innings.length, 2);

const usInnings2026 = scorecard2026.innings.find((i) => i.is_us);
const oppInnings2026 = scorecard2026.innings.find((i) => !i.is_us);
assert.strictEqual(usInnings2026.runs, 220);
assert.strictEqual(usInnings2026.wickets, 7);
assert.strictEqual(usInnings2026.extra_wides, 16);
assert.strictEqual(usInnings2026.extra_byes, 4);
assert.strictEqual(usInnings2026.extra_leg_byes, 4);
assert.strictEqual(usInnings2026.total_extras, 24);
assert.strictEqual(usInnings2026.batting.length, 11);
assert.strictEqual(usInnings2026.bowling.length, 0, '"No records to display" placeholder row must be filtered out');

assert.strictEqual(oppInnings2026.runs, 221);
assert.strictEqual(oppInnings2026.overs, 43.4);
assert.strictEqual(oppInnings2026.batting.length, 0, 'opposition individual batting is never recorded');
assert.strictEqual(oppInnings2026.bowling.length, 6, 'our bowling figures, attached to the innings the opposition batted');

const kyle = usInnings2026.batting.find((b) => b.player_name === 'Kyle Chamberlain');
assert.strictEqual(kyle.runs, 85);
assert.strictEqual(kyle.how_out, 'b');
assert.strictEqual(kyle.catches, 1, 'fielding contributions are carried on the same batting row, like the xlsx source');

const adyBaker = usInnings2026.batting.find((b) => b.player_name === 'Ady Baker');
assert.strictEqual(adyBaker.how_out, 'did not bat', 'a blank runs cell means the squad member never batted');
console.log('parseScorecardPage (2026 sample): PASS');

// --- Scorecard page (2009, an old-format match with a plain result string
// like "Lost By 10 Wickets - 4 Points" instead of "Lost by 1 Wicket (14 pts)") ---
const scorecard2009 = parseScorecardPage(
  fs.readFileSync(path.join(__dirname, 'sample-scorecard-2009.html'), 'utf8')
);
assert.strictEqual(scorecard2009.resultCode, 'L');
assert.strictEqual(scorecard2009.dateStr, 'Sat 25 Apr 2009');
assert.strictEqual(scorecard2009.timeStr, '13:30');
const usInnings2009 = scorecard2009.innings.find((i) => i.is_us);
assert.strictEqual(usInnings2009.runs, 159);
assert.strictEqual(usInnings2009.wickets, 8);
const paulMarvin = usInnings2009.batting.find((b) => b.player_name === 'Paul  Marvin'.replace(/\s+/g, ' '));
assert.ok(paulMarvin, 'should find Paul Marvin (double-spaced name in the source, like the xlsx export had)');
assert.strictEqual(paulMarvin.runs, 65);
console.log('parseScorecardPage (2009 sample): PASS');

// --- insertScrapedMatch, end to end against a real SQLite DB ---
const { insertScrapedMatch, resolvePlayerId } = require('../scripts/insertScrapedMatch');

const dbPath = path.join(__dirname, 'test-scraped.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;
const { openDb } = require('../scripts/db');
const db = openDb();

const tomWrightId = db.prepare('INSERT INTO players (name) VALUES (?)').run('Tom Wright').lastInsertRowid;
db.prepare(
  `INSERT INTO player_aliases (player_id, alias_name, source, match_type, confidence, confirmed)
   VALUES (?, 'Kyle Chamberlain', 'hitssports', 'exact', 1, 1)`
).run(tomWrightId); // reusing this row just to prove alias resolution wins over a fresh player

const record = {
  match: {
    source: 'historic', play_cricket_match_id: null, season: 2026, match_date: '2026-04-18',
    match_time: '13:00', team_name: '1st XI', opposition_name: 'Kegworth Town CC 1st XI',
    venue: null, home_or_away: 'H', competition_name: null, competition_type: 'League',
    result: 'L', result_description: 'Lost by 1 Wicket', toss: null,
    our_total: '220/7', opposition_total: '221/9', last_updated: null,
  },
  innings: scorecard2026.innings,
};

insertScrapedMatch(db, record);

const matchRow = db.prepare(`SELECT * FROM matches WHERE opposition_name = 'Kegworth Town CC 1st XI'`).get();
assert.ok(matchRow);
assert.strictEqual(matchRow.result, 'L');
assert.strictEqual(matchRow.our_total, '220/7');

assert.strictEqual(resolvePlayerId(db, 'Kyle Chamberlain'), tomWrightId, 'confirmed alias should win over creating a new player');

const kyleRow = db.prepare(
  `SELECT bp.runs FROM batting_performances bp WHERE bp.player_id = ?`
).get(tomWrightId);
assert.strictEqual(kyleRow.runs, 85, 'Kyle Chamberlain\'s innings should be attributed to the aliased player id');

const fieldingRow = db.prepare(`SELECT * FROM fielding_performances WHERE player_id = ?`).get(tomWrightId);
assert.ok(fieldingRow, 'Kyle Chamberlain\'s catch should be recorded directly, no derivation needed');
assert.strictEqual(fieldingRow.catches, 1);

console.log('insertScrapedMatch: PASS');

// Re-insert (simulating a re-scrape) - no duplicates.
insertScrapedMatch(db, record);
const matchCount = db.prepare(`SELECT COUNT(*) c FROM matches WHERE opposition_name = 'Kegworth Town CC 1st XI'`).get().c;
assert.strictEqual(matchCount, 1, 'match should not be duplicated on re-scrape');
console.log('re-scrape idempotency: PASS');

db.close();
fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

console.log('\nAll tests passed.');
