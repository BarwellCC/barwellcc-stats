require('dotenv').config();
const fetch = require('node-fetch');

const API_TOKEN = process.env.PLAY_CRICKET_API_TOKEN;
const SITE_ID = process.env.PLAY_CRICKET_SITE_ID;
const season = Number(process.argv[2]) || new Date().getFullYear();

if (!API_TOKEN || !SITE_ID) {
  console.error('Missing PLAY_CRICKET_API_TOKEN or PLAY_CRICKET_SITE_ID in .env');
  process.exit(1);
}

const BASE = 'https://www.play-cricket.com/api/v2';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Play-Cricket API request failed (${res.status}): ${url}`);
  return res.json();
}

async function main() {
  console.log(`Looking up fixtures for site ${SITE_ID}, season ${season}...`);
  const matchesUrl = `${BASE}/matches.json?site_id=${SITE_ID}&season=${season}&api_token=${API_TOKEN}`;
  const matchesData = await getJson(matchesUrl);
  const fixtures = matchesData.matches || [];

  if (fixtures.length === 0) {
    console.log(`No fixtures found for ${season}. Try a different year, e.g.: node scripts/find-club-id.js 2025`);
    return;
  }

  const first = fixtures[0];
  console.log(`Found ${fixtures.length} fixtures. Checking the first one (match id ${first.id})...\n`);

  const detailUrl = `${BASE}/match_detail.json?match_id=${first.id}&api_token=${API_TOKEN}`;
  const detailData = await getJson(detailUrl);
  const detail = (detailData.match_details || [])[0];

  if (!detail) {
    console.log('Could not read match detail for that fixture - try running this again, or a different season.');
    return;
  }

  console.log('Home club:', detail.home_club_name, '  club_id =', detail.home_club_id);
  console.log('Away club:', detail.away_club_name, '  club_id =', detail.away_club_id);
  console.log('\nWhichever one is Barwell Cricket Club - that number is your PLAY_CRICKET_CLUB_ID.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});