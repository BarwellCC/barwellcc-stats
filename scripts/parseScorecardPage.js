// Parses one match scorecard page from barwellcc.co.uk
// (https://barwellcc.co.uk/scorecard/fixtureID_<id>/default.aspx) into the
// same {match, innings} shape scripts/parseMatchDetail.js produces for
// Play-Cricket data - real result, real team totals (with extras), real
// dismissal types, not the reduced runs-only data the Hitssports xlsx export
// gives. Pure function, no network - see scripts/scrapeClub.js for the fetch
// layer and README.md's "Importing historic seasons via the live site"
// section for the full page-structure writeup.
//
// Page structure (an ASP.NET RadGrid control, consistent back to at least
// 2009): one <fieldset> per innings, containing a <legend> naming the team
// that batted (its own <table class="rgMasterTable"> is the batting table),
// followed by an <h3> naming the OTHER team's bowling for that innings (its
// own rgMasterTable is the bowling table) - already the exact
// "bowling_performances belongs to the innings, attributed to whoever did
// NOT bat" shape this project uses everywhere else, so no direction-flipping
// is needed here (unlike bowling_performances/fielder_name elsewhere).
// Individual opposition batting/bowling is essentially never recorded (the
// club only scores its own players in detail) - those tables just come back
// empty, which is fine, same as the Hitssports xlsx historic import.

const cheerio = require('cheerio');
const { clean } = require('./normalizeName');

function parseTimeText(str) {
  if (!str) return null;
  const cleaned = str.replace(/\s+/g, '').toLowerCase();
  let m = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = cleaned.match(/^(\d{1,2})[.:]?(\d{2})?(am|pm)$/);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] || '00';
    if (m[3] === 'pm' && hour !== 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${minute}`;
  }
  return null;
}

// Fallback only - scripts/parseFixtureListPage.js's result <span class="...">
// is the more reliable source (see README.md); this is used when a match was
// found by date/team/opposition alone with no matching fixture-list row.
const RESULT_KEYWORDS = [
  ['conceded', 'CON'],
  ['tied', 'T'],
  ['abandoned', 'A'],
  ['cancelled', 'C'],
  ['canceled', 'C'],
  ['drawn', 'D'],
  ['won', 'W'],
  ['lost', 'L'],
];
function parseResultCode(text) {
  const lower = (text || '').toLowerCase();
  for (const [kw, code] of RESULT_KEYWORDS) {
    if (lower.includes(kw)) return code;
  }
  return null;
}

// Matches the real how_out values already used by the Play-Cricket-sourced
// data (confirmed against the live database) so the two sources render
// identically - anything not in this list is passed through lowercased
// rather than dropped, since new/rare dismissal wording is better kept than lost.
const HOW_OUT_MAP = {
  bowled: 'b',
  caught: 'ct',
  stumped: 'st',
  lbw: 'lbw',
  'run out': 'run out',
  'not out': 'not out',
  'retired not out': 'retired not out',
  'retired hurt': 'retired not out',
  'retired out': 'retired out',
  'hit wicket': 'hit wicket',
};
function normalizeHowOut(text) {
  const key = clean(text).toLowerCase();
  if (!key) return null;
  return HOW_OUT_MAP[key] || key;
}

function toNum(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseExtras(text) {
  const result = { byes: null, legByes: null, wides: null, noBalls: null };
  if (!text) return result;
  for (const m of text.matchAll(/(\d+)\s*(nb|lb|b|w)/gi)) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'nb') result.noBalls = n;
    else if (unit === 'lb') result.legByes = n;
    else if (unit === 'b') result.byes = n;
    else if (unit === 'w') result.wides = n;
  }
  return result;
}

// The tfoot row packs an extras breakdown string and an extras total number
// inside nested <div>s alongside other visible text in the same <td> - these
// two helpers split "own" text (the td's text minus its child divs) from the
// nested div's own text.
function ownText($, td) {
  const clone = $(td).clone();
  clone.children('div').remove();
  return clean(clone.text());
}
function nestedDivText($, td) {
  return clean($(td).find('div').first().text());
}

function parseInningsTotal($, tfoot) {
  const tds = $(tfoot).find('> tr > td');
  if (tds.length < 3) {
    return { wickets: null, runs: null, overs: null, extras: parseExtras(null), extrasTotal: null };
  }
  const wicketsText = ownText($, tds.get(1));
  const extrasBreakdownText = nestedDivText($, tds.get(1));
  const totalsText = ownText($, tds.get(2));
  const extrasTotalText = nestedDivText($, tds.get(2));

  const wicketsMatch = wicketsText.match(/(\d+)/);
  const totalsMatch = totalsText.match(/^(\d+)(?:\s*\(([\d.]+)\s*overs?\))?/i);

  return {
    wickets: wicketsMatch ? Number(wicketsMatch[1]) : null,
    runs: totalsMatch ? Number(totalsMatch[1]) : null,
    overs: totalsMatch && totalsMatch[2] ? Number(totalsMatch[2]) : null,
    extras: parseExtras(extrasBreakdownText),
    extrasTotal: toNum(extrasTotalText),
  };
}

// A blank runs cell (rather than "0") is how this site marks a squad member
// who didn't get to bat - same "did not bat" convention used for
// Play-Cricket data (see README.md), just detected differently since there's
// no explicit DNB marker here.
function parseBattingRows($, table) {
  const rows = [];
  $(table).find('> tbody > tr').each((_, tr) => {
    if ($(tr).hasClass('rgNoRecords')) return; // RadGrid's own "no data" placeholder row
    const tds = $(tr).find('> td');
    const name = clean($(tds.get(0)).text());
    if (!name) return;
    const dismissalRaw = clean($(tds.get(1)).text());
    const runsText = clean($(tds.get(2)).text());
    const didNotBat = runsText === '';
    const lowerDismissal = dismissalRaw.toLowerCase();
    rows.push({
      player_name: name,
      how_out: didNotBat ? 'did not bat' : normalizeHowOut(dismissalRaw),
      runs: didNotBat ? 0 : (toNum(runsText) || 0),
      balls_faced: toNum(clean($(tds.get(4)).text())),
      fours: toNum(clean($(tds.get(5)).text())),
      sixes: toNum(clean($(tds.get(6)).text())),
      not_out: !didNotBat && /not out/.test(lowerDismissal) ? 1 : 0,
      catches: toNum(clean($(tds.get(8)).text())) || 0,
      stumpings: toNum(clean($(tds.get(9)).text())) || 0,
      run_outs: toNum(clean($(tds.get(10)).text())) || 0,
    });
  });
  return rows;
}

function parseBowlingRows($, table) {
  const rows = [];
  $(table).find('> tbody > tr').each((_, tr) => {
    if ($(tr).hasClass('rgNoRecords')) return; // RadGrid's own "no data" placeholder row
    const tds = $(tr).find('> td');
    const name = clean($(tds.get(0)).text());
    if (!name) return;
    rows.push({
      player_name: name,
      overs: toNum(clean($(tds.get(1)).text())),
      maidens: toNum(clean($(tds.get(2)).text())),
      runs_conceded: toNum(clean($(tds.get(3)).text())),
      wickets: toNum(clean($(tds.get(4)).text())),
    });
  });
  return rows;
}

function parseScorecardPage(html) {
  const $ = cheerio.load(html);
  const resultH2 = $('h2.result');
  if (resultH2.length === 0) return null; // abandoned before play, or no page at this id

  const rawHtml = resultH2.html() || '';
  const segments = rawHtml.split(/<br\s*\/?>/i).map((s) => clean(cheerio.load(`<div>${s}</div>`)('div').text()));
  const [matchLine, resultLine] = segments;

  const matchLineMatch = matchLine ? matchLine.match(/^(.*?)\s+v\s+(.*?)\s+on\s+(.*?)\s+at\s+(.*)$/i) : null;
  const dateStr = matchLineMatch ? matchLineMatch[3].trim() : null;
  const timeStr = matchLineMatch ? parseTimeText(matchLineMatch[4]) : null;

  const innings = [];
  $('fieldset').each((_, fieldset) => {
    const legend = clean($(fieldset).find('> legend').first().text());
    if (!legend || /match report/i.test(legend)) return;
    const battingTeamName = legend.replace(/\s*Batting\s*$/i, '').trim();
    const isUs = /barwell cricket club/i.test(battingTeamName);

    const tables = $(fieldset).find('table.rgMasterTable');
    const battingTable = tables.get(0);
    const bowlingTable = tables.get(1);

    const total = battingTable ? parseInningsTotal($, $(battingTable).find('> tfoot')) : null;
    const battingRows = battingTable ? parseBattingRows($, battingTable) : [];
    const bowlingRows = bowlingTable ? parseBowlingRows($, bowlingTable) : [];

    innings.push({
      is_us: isUs ? 1 : 0,
      batting_team_name: battingTeamName,
      runs: total ? total.runs : null,
      wickets: total ? total.wickets : null,
      overs: total ? total.overs : null,
      declared: 0,
      extra_byes: total ? total.extras.byes : null,
      extra_leg_byes: total ? total.extras.legByes : null,
      extra_wides: total ? total.extras.wides : null,
      extra_no_balls: total ? total.extras.noBalls : null,
      extra_penalty_runs: null,
      total_extras: total ? total.extrasTotal : null,
      batting: battingRows,
      bowling: bowlingRows,
    });
  });

  return {
    dateStr,
    timeStr,
    resultText: resultLine || null,
    resultCode: parseResultCode(resultLine),
    innings,
  };
}

module.exports = { parseScorecardPage, parseResultCode, normalizeHowOut, parseTimeText, parseExtras };
