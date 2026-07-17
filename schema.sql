-- Barwell CC unified stats database
-- Holds both Play-Cricket-sourced matches (2026 onwards) and imported historic
-- matches (2009-2026, from the Hitssports export), in one shared shape so stats
-- queries don't need to care which system a match originally came from.

PRAGMA foreign_keys = ON;

-- One row per person who has ever batted/bowled/fielded for the club.
-- play_cricket_id is filled in when we know it (from API data); historic rows
-- will initially only have a name match. See scripts/merge-players.js for
-- reconciling "J Smith" (historic) with "James Smith" (Play-Cricket) etc.
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  play_cricket_id INTEGER UNIQUE
);

-- result/result_description/toss/our_total/opposition_total are all nullable:
-- an upcoming (not yet played) fixture is a real row here with those left
-- null, not something we wait to insert until full time. See
-- scripts/parseFixture.js for how those rows get built, vs
-- scripts/parseMatchDetail.js for completed ones.
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('playcricket', 'historic')),
  play_cricket_match_id INTEGER UNIQUE, -- null for historic matches
  season INTEGER NOT NULL,
  match_date TEXT NOT NULL,             -- ISO yyyy-mm-dd
  match_time TEXT,                      -- e.g. "13:00", from Play-Cricket's fixture data
  team_name TEXT,                       -- our team, e.g. "1st XI"
  opposition_name TEXT,
  venue TEXT,
  home_or_away TEXT CHECK (home_or_away IN ('H', 'A', NULL)),
  competition_name TEXT,
  competition_type TEXT,                -- League / Cup / Friendly
  result TEXT,                          -- W / L / D / T / A / C
  result_description TEXT,
  toss TEXT,
  our_total TEXT,                       -- e.g. "212/6"
  opposition_total TEXT,
  last_updated TEXT
);

CREATE TABLE IF NOT EXISTS innings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_number INTEGER NOT NULL,
  batting_team_name TEXT NOT NULL,
  is_us INTEGER NOT NULL DEFAULT 0,      -- 1 if this innings is Barwell batting
  runs INTEGER,
  wickets INTEGER,
  overs REAL,
  declared INTEGER DEFAULT 0,
  extra_byes INTEGER,
  extra_leg_byes INTEGER,
  extra_wides INTEGER,
  extra_no_balls INTEGER,
  extra_penalty_runs INTEGER,
  total_extras INTEGER
);

CREATE TABLE IF NOT EXISTS batting_performances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id INTEGER NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  batting_position INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  balls_faced INTEGER,
  fours INTEGER,
  sixes INTEGER,
  how_out TEXT,          -- b / ct / lbw / no (not out) / ro / st etc
  not_out INTEGER NOT NULL DEFAULT 0,
  bowler_name TEXT,      -- dismissal detail, free text (name reconciliation not required here)
  fielder_name TEXT
);

CREATE TABLE IF NOT EXISTS bowling_performances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id INTEGER NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  overs REAL,
  maidens INTEGER,
  runs_conceded INTEGER,
  wickets INTEGER,
  wides INTEGER,
  no_balls INTEGER
);

-- Catches/stumpings/run-outs, derived from batting_performances.fielder_name
-- where possible (Play-Cricket data), or loaded directly from the historic
-- fielding export if Hitssports provides one.
CREATE TABLE IF NOT EXISTS fielding_performances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id),
  catches INTEGER DEFAULT 0,
  stumpings INTEGER DEFAULT 0,
  run_outs INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_matches_season ON matches(season);
CREATE INDEX IF NOT EXISTS idx_batting_player ON batting_performances(player_id);
CREATE INDEX IF NOT EXISTS idx_bowling_player ON bowling_performances(player_id);
CREATE INDEX IF NOT EXISTS idx_innings_match ON innings(match_id);

-- Maps a name as it appears in an external source (currently just Hitssports)
-- onto the canonical player row it refers to. Built by scripts/matchPlayers.js:
-- exact name matches are recorded automatically; anything less certain (a
-- nickname, a likely typo, two similarly-spelled surnames) is written here
-- with confirmed=0 until a person confirms it, and the historic importer
-- refuses to use an alias until confirmed=1.
CREATE TABLE IF NOT EXISTS player_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id),
  alias_name TEXT NOT NULL,       -- the raw "FirstName Surname" as it appears in the source
  source TEXT NOT NULL,           -- 'hitssports'
  match_type TEXT NOT NULL,       -- 'exact' | 'nickname' | 'fuzzy'
  confidence REAL,                -- 0-1, for fuzzy matches
  confirmed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(alias_name, source)
);
