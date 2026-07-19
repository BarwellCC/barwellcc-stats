require('dotenv').config();
const fetch = require('node-fetch');
const { openDb } = require('./db');
const { insertMatch } = require('./insertMatch');
const { parseMatchDetail } = require('./parseMatchDetail');
const { parseFixture } = require('./parseFixture');
const { deriveFielding } = require('./deriveFielding');

const API_TOKEN = process.env.PLAY_CRICKET_API_TOKEN;
const SITE_ID = process.env.PLAY_CRICKET_SITE_ID;
const CLUB_ID = process.env.PLAY_CRICKET_CLUB_ID; // used to work out home/away for us

if (!API_TOKEN || !SITE_ID) {
  console.error('Missing PLAY_CRICKET_API_TOKEN or PLAY_CRICKET_SITE_ID in .env');
  process.exit(1);
}

const BASE = 'https://www.play-cricket.com/api/v2';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Play-Cricket API request failed (${res.status}): ${url}`);
  }
  return res.json();
}

// Step 1: list of fixtures for the season (lightweight - no scorecards yet)
async function fetchSeasonMatches(season) {
  const url = `${BASE}/result_summary.json?site_id=${SITE_ID}&season=${season}&api_token=${API_TOKEN}`;
  const data = await getJson(url);
  return data.result_summary || [];
}

// Step 2: full scorecard for one match
async function fetchMatchDetail(matchId) {
  const url = `${BASE}/match_detail.json?match_id=${matchId}&api_token=${API_TOKEN}`;
  const data = await getJson(url);
  return (data.match_details || [])[0];
}

// Step 3: the full fixture list, including matches with no result yet.
// result_summary.json (used above) only ever lists matches that already have
// a result - it's silent on anything still to be played - so upcoming
// fixtures have to come from this separate, less detailed endpoint instead.
async function fetchAllFixtures(season) {
  const url = `${BASE}/matches.json?site_id=${SITE_ID}&season=${season}&api_token=${API_TOKEN}`;
  const data = await getJson(url);
  return data.matches || [];
}

async function syncSeason(season) {
  const db = openDb();
  console.log(`Fetching fixture list for ${season}...`);
  const fixtures = await fetchSeasonMatches(season);
  console.log(`${fixtures.length} fixtures found. Pulling scorecards for completed matches...`);

  const completedIds = new Set();
  let synced = 0;
  let skipped = 0;
  for (const fixture of fixtures) {
    completedIds.add(String(fixture.id));
    // Fixtures with no result yet (future games) don't have a scorecard worth pulling.
    if (!fixture.result || fixture.result === '') {
      skipped += 1;
      continue;
    }
    try {
      const detail = await fetchMatchDetail(fixture.id);
      if (!detail) {
        skipped += 1;
        continue;
      }
      const parsed = parseMatchDetail(detail, { ourClubId: CLUB_ID, season });
      insertMatch(db, parsed);
      synced += 1;
      // Play-Cricket asks integrators to keep traffic low - a short pause
      // between requests is good citizenship, not a technical requirement.
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`Failed on match ${fixture.id}:`, err.message);
    }
  }
  console.log(`Done. Synced ${synced} matches, skipped ${skipped} (no result yet, or no data).`);

  console.log('Fetching full fixture list to pick up upcoming (not yet played) matches...');
  const allFixtures = await fetchAllFixtures(season);
  let upcoming = 0;
  for (const raw of allFixtures) {
    if (completedIds.has(String(raw.id))) continue; // already synced above, with a real scorecard
    const parsed = parseFixture(raw, { ourClubId: CLUB_ID, season });
    if (!parsed) continue; // not a real "us vs opposition" fixture (e.g. an inter-squad friendly)
    insertMatch(db, parsed);
    upcoming += 1;
  }
  console.log(`Stored ${upcoming} upcoming fixtures.`);

  // Catches/stumpings aren't in the scorecard payload as their own field -
  // they're derived from dismissal text on the batting side, so this has to
  // re-run after every sync rather than being written once per match.
  const { rows, unmatched } = deriveFielding(db);
  console.log(`Derived ${rows} fielding_performances rows (${unmatched} dismissals had no matching player).`);

  db.close();
}

const season = Number(process.argv[2]) || new Date().getFullYear();
syncSeason(season).catch((err) => {
  console.error(err);
  process.exit(1);
});
