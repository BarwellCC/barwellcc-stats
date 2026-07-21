// Loads the checked-in historic-data/scraped-matches.json dump (produced by
// scripts/dumpHistoricScraped.js) into the local DB - fast, no network. This
// is what every build (including the nightly GitHub Action) runs, right
// after npm run sync, so historic matches survive the DB being rebuilt from
// scratch every run without re-scraping the club's own live site every
// night - see README.md's "Importing historic seasons via the live site"
// section for the full reasoning.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { insertScrapedMatch } = require('./insertScrapedMatch');

const DUMP_PATH = process.env.HISTORIC_DUMP_PATH
  || path.join(__dirname, '..', 'historic-data', 'scraped-matches.json');

function main() {
  if (!fs.existsSync(DUMP_PATH)) {
    console.log(`No historic dump found at ${DUMP_PATH} - nothing to load.`);
    return;
  }

  const records = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const db = openDb();
  for (const record of records) {
    insertScrapedMatch(db, record);
  }
  db.close();

  console.log(`Loaded ${records.length} historic matches from ${DUMP_PATH}.`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
