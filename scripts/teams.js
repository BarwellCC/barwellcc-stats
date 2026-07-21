// This site is scoped to Barwell CC's senior (adult) teams only - explicit
// user decision, applying to both the historic scrape (scripts/scrapeClub.js
// already only ever knew about these six) and the ongoing Play-Cricket sync
// (scripts/sync-playcricket.js), which previously synced every team
// registered to the club, juniors included.
const SENIOR_TEAMS = ['1st XI', '2nd XI', '3rd XI', 'Midweek XI', 'Midweek 2nd XI', 'Sunday XI'];

module.exports = { SENIOR_TEAMS };
