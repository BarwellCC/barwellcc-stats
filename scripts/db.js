const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

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
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

// Finds or creates a player row by name, optionally attaching a Play-Cricket
// player id when we have one (and backfilling it onto an existing name-only
// row from historic data if it's missing).
function getOrCreatePlayer(db, name, playCricketId) {
  if (!name) return null;
  const cleanName = name.trim();

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

module.exports = { openDb, getOrCreatePlayer, getDbPath };
