const XLSX = require('xlsx');
const { clean } = require('./normalizeName');

// Works for both the batting and bowling exports - both have FirstName/Surname
// columns; everything else in the row is ignored here.
function readDistinctPlayerNames(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

  const seen = new Map(); // key -> {firstName, surname}
  for (const row of rows) {
    const firstName = clean(row.FirstName);
    const surname = clean(row.Surname);
    if (!firstName || !surname) continue;
    const key = `${firstName}|${surname}`;
    if (!seen.has(key)) seen.set(key, { firstName, surname });
  }
  return [...seen.values()];
}

// Merges name lists from multiple exports (e.g. batting + bowling) into one
// distinct set, since the same player appears in both.
function readDistinctPlayerNamesFromFiles(xlsxPaths) {
  const seen = new Map();
  for (const p of xlsxPaths) {
    for (const player of readDistinctPlayerNames(p)) {
      const key = `${player.firstName}|${player.surname}`;
      seen.set(key, player);
    }
  }
  return [...seen.values()];
}

module.exports = { readDistinctPlayerNames, readDistinctPlayerNamesFromFiles };
