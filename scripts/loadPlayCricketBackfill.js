// Loads the checked-in historic-data/playcricket-backfill.json dump
// (produced by scripts/dumpPlayCricketBackfill.js) into the local DB - fast,
// no network. Mirrors scripts/loadHistoricScraped.js, but uses
// scripts/insertMatch.js (keyed on play_cricket_match_id, same as the
// current-season sync) rather than insertScrapedMatch.js, since these rows
// are genuinely Play-Cricket-sourced, just for a season the nightly sync
// doesn't touch (npm run sync only ever syncs the *current* season).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { insertMatch } = require('./insertMatch');

const DUMP_PATH = process.env.PLAYCRICKET_BACKFILL_DUMP_PATH
  || path.join(__dirname, '..', 'historic-data', 'playcricket-backfill.json');

function main() {
  if (!fs.existsSync(DUMP_PATH)) {
    console.log(`No Play-Cricket backfill dump found at ${DUMP_PATH} - nothing to load.`);
    return;
  }

  const records = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const db = openDb();
  for (const record of records) {
    insertMatch(db, record);
  }
  db.close();

  console.log(`Loaded ${records.length} Play-Cricket-backfilled historic matches from ${DUMP_PATH}.`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
