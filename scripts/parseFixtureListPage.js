// Parses one team/season fixture-list page from barwellcc.co.uk
// (https://barwellcc.co.uk/fixtures/teamid_<id>/seasonid_<id>/default.aspx)
// into fixture rows - just enough to know which scorecard pages to fetch and
// how to label them (scripts/parseScorecardPage.js handles the actual
// scorecard content). Pure function, no network - see scripts/scrapeClub.js
// for the fetch layer.
//
// Each fixture row (<tr data-fixid="...">) carries the fixture id directly as
// a data attribute, and the result cell's <span class="won|lost|...."> gives
// a reliable result code without needing to parse free text - see
// README.md's "Importing historic seasons via the live site" section.

const cheerio = require('cheerio');
const { clean } = require('./normalizeName');

const RESULT_CLASS_TO_CODE = {
  won: 'W',
  lost: 'L',
  tied: 'T',
  drawn: 'D',
  abandoned: 'A',
  cancelled: 'C',
  canceled: 'C',
  conceded: 'CON',
};

function parseFixtureListPage(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table.rgMasterTable > tbody > tr').each((_, el) => {
    const $tr = $(el);
    const fixtureId = $tr.attr('data-fixid');
    if (!fixtureId) return; // not a fixture row (e.g. a "no records" row)

    const tds = $tr.find('> td');
    const dateStr = clean($(tds.get(0)).text());
    const oppositionCell = $(tds.get(1)).clone();
    oppositionCell.find('span').remove(); // strip the "(H)"/"(A)" marker span
    const opposition = clean(oppositionCell.text());
    const venueText = clean($(tds.get(2)).text()); // "Home" / "Away"
    const startTimeText = clean($(tds.get(3)).text());
    const type = clean($(tds.get(4)).text());

    const resultSpan = $(tds.get(5)).find('span[class]').first();
    const resultClass = (resultSpan.attr('class') || '').toLowerCase();
    const resultCode = RESULT_CLASS_TO_CODE[resultClass] || null;

    rows.push({
      fixtureId,
      dateStr,
      opposition,
      homeOrAway: venueText.toLowerCase() === 'home' ? 'H' : venueText.toLowerCase() === 'away' ? 'A' : null,
      startTimeText,
      type: type || null,
      resultCode,
    });
  });

  return rows;
}

module.exports = { parseFixtureListPage, RESULT_CLASS_TO_CODE };
