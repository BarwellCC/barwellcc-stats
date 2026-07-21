// Low-level fetch layer for barwellcc.co.uk (the club's own live Hitssports
// site) - no parsing here, see scripts/parseFixtureListPage.js and
// scripts/parseScorecardPage.js for that. Kept separate so the parsers stay
// pure/unit-testable against saved HTML with no network involved.
//
// team/season ids and URL patterns confirmed by hand against the real site
// (see README.md's "Importing historic seasons via the live site" section).
// Season ids are shared across every team (confirmed: 1st XI and 2nd XI's
// fixture pages list the identical set of <option value> ids) - only the
// team id in the URL changes which team's fixtures come back.

const BASE_URL = 'https://barwellcc.co.uk';

// The six adult teams in scope for historic import - junior teams aren't
// covered here.
const TEAM_IDS = {
  '1st XI': 3912,
  '2nd XI': 3910,
  '3rd XI': 17904,
  'Midweek XI': 3914,
  'Midweek 2nd XI': 17626,
  'Sunday XI': 3913,
};

// The site lists "2025" twice in its season dropdown - id 19097 has real
// fixtures, id 19367 is an empty duplicate (0 fixture rows on every team
// checked) - only the real one is included here.
const SEASON_IDS = {
  2026: 19368,
  2025: 19097,
  2024: 18846,
  2023: 18484,
  2022: 18144,
  2021: 17668,
  2020: 16913,
  2019: 15464,
  2018: 14904,
  2017: 14077,
  2016: 13025,
  2015: 12083,
  2014: 10872,
  2013: 9544,
  2012: 7900,
  2011: 6916,
  2010: 4804,
  2009: 3827,
};

const DELAY_MS = 350; // politeness delay between requests - this is the club's own live site, not a bulk data dump

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeFetch(url, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(1000 * attempt);
    return politeFetch(url, attempt + 1);
  } finally {
    await sleep(DELAY_MS);
  }
}

function fixtureListUrl(teamId, seasonId) {
  return `${BASE_URL}/fixtures/teamid_${teamId}/seasonid_${seasonId}/default.aspx`;
}

function scorecardUrl(fixtureId) {
  return `${BASE_URL}/scorecard/fixtureID_${fixtureId}/default.aspx`;
}

function fetchFixtureList(teamId, seasonId) {
  return politeFetch(fixtureListUrl(teamId, seasonId));
}

function fetchScorecard(fixtureId) {
  return politeFetch(scorecardUrl(fixtureId));
}

module.exports = { TEAM_IDS, SEASON_IDS, fetchFixtureList, fetchScorecard, fixtureListUrl, scorecardUrl };
