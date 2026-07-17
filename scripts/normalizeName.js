const nicknameData = require('./nicknames.json');

// Build first-name -> canonical-group-key lookup once.
const nicknameCanonical = new Map();
for (const group of nicknameData.groups) {
  const canonical = group[group.length - 1]; // last entry is the "formal" name by convention above
  for (const alt of group) nicknameCanonical.set(alt, canonical);
}

function clean(str) {
  return (str || '')
    .replace(/\s+/g, ' ') // collapse repeated/odd whitespace (tabs, double spaces, etc.)
    .trim();
}

function normalize(str) {
  return clean(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // strip accents so e.g. "José" ~ "Jose"
}

function canonicalFirstName(firstName) {
  const n = normalize(firstName);
  return nicknameCanonical.get(n) || n;
}

function fullNameKey(firstName, surname) {
  return `${normalize(firstName)} ${normalize(surname)}`;
}

function nicknameKey(firstName, surname) {
  return `${canonicalFirstName(firstName)} ${normalize(surname)}`;
}

// Levenshtein distance, used only to rank/flag close-but-not-exact surname
// spellings (e.g. a typo) for human review - not to auto-decide anything.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function similarity(a, b) {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - dist / maxLen;
}

module.exports = {
  clean,
  normalize,
  canonicalFirstName,
  fullNameKey,
  nicknameKey,
  similarity,
};
