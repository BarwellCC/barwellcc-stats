const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
const MERGES_PATH = path.join(__dirname, '..', 'data', 'player-merges.json');

function getDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'barwellcc.db');
}

// schema.sql uses CREATE TABLE IF NOT EXISTS, so it never alters a table that
// already exists on disk. New columns need an explicit, idempotent migration
// here as well.
function migrate(db) {
  const matchesCols = db.prepare("PRAGMA table_info(matches)").all().map((c) => c.name);
  if (!matchesCols.includes('match_time')) {
    db.exec('ALTER TABLE matches ADD COLUMN match_time TEXT');
  }
}

function openDb() {
  const dbPath = getDbPath();
  // data/ is gitignored (only the .db file inside it shouldn't be tracked,
  // not the directory) - a fresh checkout (e.g. the GitHub Actions runner)
  // has no data/ directory at all, and better-sqlite3 doesn't create
  // missing parent directories itself.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  migrate(db);
  applyPlayerMerges(db);
  return db;
}

// data/player-merges.json holds confirmed duplicate-player decisions (see
// site/duplicates.html and scripts/findDuplicatePlayers.js) - e.g. "Dan King"
// and "Daniel King" are the same person, and the Play-Cricket-sourced
// spelling wins. Cached per process since the file only changes when
// someone confirms a new merge, not per build.
let playerMergesCache = null;
function loadPlayerMerges() {
  if (!playerMergesCache) {
    playerMergesCache = fs.existsSync(MERGES_PATH)
      ? JSON.parse(fs.readFileSync(MERGES_PATH, 'utf8'))
      : [];
  }
  return playerMergesCache;
}

// Each alias is either a plain string (the original shape) or
// `{ name, play_cricket_id }` (richer shape, added so site/duplicates.html
// can show a real Play-Cricket-id/"Historic" badge per alias in the
// "Already merged" list, same as everywhere else on that page) - normalise
// once so every reader below doesn't need to know both shapes exist.
function aliasName(alias) {
  return typeof alias === 'string' ? alias : alias.name;
}

// The canonical side of a merge entry is normally just a name string, but
// can also be `{ name, play_cricket_id }` when a specific id needs to be
// forced onto it (see applyPlayerMerges() below) - same two-shape pattern
// as an alias, for the same reason.
function canonicalName(canonical) {
  return typeof canonical === 'string' ? canonical : canonical.name;
}

// Redirects a known alias straight to its canonical name before any lookup
// or insert happens, so a confirmed duplicate never gets its own `players`
// row again - important because data/barwellcc.db is gitignored and
// rebuilt from scratch on every deploy (see README.md), so this has to be
// re-derived from data/player-merges.json every time, not fixed once in the
// database.
function canonicalPlayerName(name) {
  for (const { canonical, aliases } of loadPlayerMerges()) {
    if (aliases.some((alias) => aliasName(alias) === name)) return canonicalName(canonical);
  }
  return name;
}

// Folds a pre-existing alias player row (and its performances) into its
// canonical row. Only has anything to do when a merge is added to
// data/player-merges.json after the alias row already exists in a
// long-lived local data/barwellcc.db - a fresh rebuild never creates the
// alias row in the first place, since getOrCreatePlayer() below resolves
// the canonical name up front. Safe to run on every openDb(): a no-op once
// the alias row has already been folded in.
function applyPlayerMerges(db) {
  for (const { canonical, aliases } of loadPlayerMerges()) {
    const cName = canonicalName(canonical);
    for (const alias of aliases) {
      const name = aliasName(alias);
      const aliasRow = db.prepare('SELECT id FROM players WHERE name = ?').get(name);
      if (!aliasRow) continue;
      // Pass the alias's own known Play-Cricket id (if any) through, so a
      // canonical row that doesn't have one yet gets backfilled from a
      // real registration, rather than always passing null.
      const playCricketId = typeof alias === 'object' ? alias.play_cricket_id : null;
      const canonicalId = getOrCreatePlayer(db, cName, playCricketId || null);
      db.prepare('UPDATE batting_performances SET player_id = ? WHERE player_id = ?').run(canonicalId, aliasRow.id);
      db.prepare('UPDATE bowling_performances SET player_id = ? WHERE player_id = ?').run(canonicalId, aliasRow.id);
      db.prepare('UPDATE fielding_performances SET player_id = ? WHERE player_id = ?').run(canonicalId, aliasRow.id);
      db.prepare('DELETE FROM players WHERE id = ?').run(aliasRow.id);
    }

    // A canonical with an explicit `play_cricket_id` (object shape) forces
    // that id onto the merged row, overriding whatever id it happened to
    // pick up along the way. Needed because getOrCreatePlayer() only ever
    // backfills an id onto a row that doesn't have one yet (first past the
    // post wins) - loading order across matches, not which id is actually
    // correct, otherwise decides which of several real Play-Cricket records
    // survives (see data/player-merges.json's Peter Tillin entry: the 2013
    // "P Tillan" shorthand entry loads before the 2016 match that properly
    // records the full "Peter Tillin" name, so its id would silently win by
    // default without this override).
    if (typeof canonical === 'object' && canonical.play_cricket_id) {
      const row = db.prepare('SELECT id, play_cricket_id FROM players WHERE name = ?').get(cName);
      if (row && row.play_cricket_id !== canonical.play_cricket_id) {
        const clash = db.prepare('SELECT id FROM players WHERE play_cricket_id = ?').get(canonical.play_cricket_id);
        if (!clash) {
          db.prepare('UPDATE players SET play_cricket_id = ? WHERE id = ?').run(canonical.play_cricket_id, row.id);
        }
      }
    }
  }
}

// Finds or creates a player row by name, optionally attaching a Play-Cricket
// player id when we have one (and backfilling it onto an existing name-only
// row from historic data if it's missing).
function getOrCreatePlayer(db, name, playCricketId) {
  if (!name) return null;
  const cleanName = canonicalPlayerName(name.trim());

  if (playCricketId) {
    const byPcId = db.prepare('SELECT id FROM players WHERE play_cricket_id = ?').get(playCricketId);
    if (byPcId) return byPcId.id;
  }

  const byName = db.prepare('SELECT id, play_cricket_id FROM players WHERE name = ?').get(cleanName);
  if (byName) {
    if (playCricketId && !byName.play_cricket_id) {
      db.prepare('UPDATE players SET play_cricket_id = ? WHERE id = ?').run(playCricketId, byName.id);
    }
    return byName.id;
  }

  const info = db
    .prepare('INSERT INTO players (name, play_cricket_id) VALUES (?, ?)')
    .run(cleanName, playCricketId || null);
  return info.lastInsertRowid;
}

module.exports = { openDb, getOrCreatePlayer, getDbPath, canonicalPlayerName };
