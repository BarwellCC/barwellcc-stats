// Small date/time parsing helpers shared by the historic-data scraper
// (scripts/scrapeAllHistoric.js, scripts/parseScorecardPage.js) - both the
// club's live site and its old Hitssports xlsx exports used this same
// "13 Apr 2025" / "1pm" style formatting.

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// "13 Apr 2025" -> "2025-04-13". Returns null for anything else, rather than
// guessing, since a silently-wrong date would mis-key a match.
function ddMonYyyyToIso(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (!m) return null;
  const [, d, mon, y] = m;
  const key = mon.charAt(0).toUpperCase() + mon.slice(1).toLowerCase();
  const mm = MONTHS[key];
  if (!mm) return null;
  return `${y}-${mm}-${d.padStart(2, '0')}`;
}

// "1pm" -> "13:00", "12.30pm" -> "12:30", "6am" -> "06:00".
function parseStartTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] || '00';
  const meridiem = m[3].toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

module.exports = { ddMonYyyyToIso, parseStartTime };
