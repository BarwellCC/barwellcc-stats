require('dotenv').config();
const path = require('path');
const { openDb } = require('./db');
const { readDistinctPlayerNamesFromFiles } = require('./readHitssportsNames');
const { matchPlayers } = require('./matchPlayersCore');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const xlsxPaths = args.filter((a) => !a.startsWith('--'));

if (xlsxPaths.length === 0) {
  console.error('Usage: node scripts/matchPlayers.js <batting.xlsx> [bowling.xlsx ...] [--apply]');
  console.error('  --apply   write exact matches (and record nickname/fuzzy suggestions) to the database.');
  console.error('            Without --apply, this only prints the report - nothing is written.');
  process.exit(1);
}

function main() {
  const db = openDb();
  const pcPlayers = db.prepare('SELECT id, name, play_cricket_id FROM players').all();

  if (pcPlayers.length === 0) {
    console.warn(
      'No players found in the database yet. Run `npm run sync` first so there is a real ' +
      'Play-Cricket player list to match against - otherwise everything below will show as ' +
      'unmatched, which is expected but not useful yet.\n'
    );
  }

  const hsNames = readDistinctPlayerNamesFromFiles(xlsxPaths.map((p) => path.resolve(p)));
  console.log(`Read ${hsNames.length} distinct Hitssports player names from ${xlsxPaths.length} file(s).`);
  console.log(`Comparing against ${pcPlayers.length} known Play-Cricket players.\n`);

  const results = matchPlayers(hsNames, pcPlayers);

  const exact = results.filter((r) => r.matchType === 'exact');
  const nickname = results.filter((r) => r.matchType === 'nickname');
  const fuzzy = results.filter((r) => r.matchType === 'fuzzy');
  const none = results.filter((r) => r.matchType === 'none');

  console.log(`Exact matches:    ${exact.length}`);
  console.log(`Nickname matches: ${nickname.length} (need a quick confirm)`);
  console.log(`Fuzzy candidates: ${fuzzy.length} (need a quick confirm)`);
  console.log(`No match found:  ${none.length} (likely no Play-Cricket record yet)\n`);

  if (nickname.length || fuzzy.length) {
    console.log('=== Needs your confirmation ===');
    for (const r of [...nickname, ...fuzzy]) {
      console.log(`\n"${r.hitssports.firstName} ${r.hitssports.surname}" (Hitssports) could be:`);
      r.candidates.forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.name}  (confidence ${c.confidence}) - ${c.reason}`);
      });
    }
    console.log('');
  }

  if (none.length) {
    console.log('=== No Play-Cricket record found (check spelling, or these may be genuinely historic-only players) ===');
    for (const r of none) {
      console.log(`  ${r.hitssports.firstName} ${r.hitssports.surname}`);
    }
    console.log('');
  }

  if (!apply) {
    console.log('(Dry run - nothing written. Re-run with --apply to save exact matches and record the above suggestions for review.)');
    db.close();
    return;
  }

  const insertAlias = db.prepare(
    `INSERT INTO player_aliases (player_id, alias_name, source, match_type, confidence, confirmed)
     VALUES (@player_id, @alias_name, 'hitssports', @match_type, @confidence, @confirmed)
     ON CONFLICT(alias_name, source) DO UPDATE SET
       player_id=excluded.player_id, match_type=excluded.match_type, confidence=excluded.confidence`
  );

  let written = 0;
  for (const r of exact) {
    insertAlias.run({
      player_id: r.candidates[0].id,
      alias_name: `${r.hitssports.firstName} ${r.hitssports.surname}`,
      match_type: 'exact',
      confidence: 1,
      confirmed: 1,
    });
    written += 1;
  }
  for (const r of [...nickname, ...fuzzy]) {
    // Only record the top candidate as a pending suggestion; still unconfirmed.
    insertAlias.run({
      player_id: r.candidates[0].id,
      alias_name: `${r.hitssports.firstName} ${r.hitssports.surname}`,
      match_type: r.matchType,
      confidence: r.candidates[0].confidence,
      confirmed: 0,
    });
    written += 1;
  }

  console.log(`Wrote ${written} rows to player_aliases (${exact.length} confirmed, ${written - exact.length} pending review).`);
  console.log('To confirm a pending one: UPDATE player_aliases SET confirmed = 1 WHERE alias_name = \'...\';');
  db.close();
}

main();
