const assert = require('assert');
const { matchPlayers } = require('../scripts/matchPlayersCore');

// Real first/surnames from Barwell's actual 2026 Hitssports export.
const hitssportsNames = [
  { firstName: 'Tommy', surname: 'Wright' },
  { firstName: 'Darren', surname: 'Roach' },
  { firstName: 'Danny', surname: 'Moran' },
  { firstName: 'Ady', surname: 'Baker' },
  { firstName: 'Joe', surname: 'Stack' },
  { firstName: 'Guy', surname: 'Norris' },
  { firstName: 'Alex', surname: 'Norris' },
  { firstName: 'Rowan', surname: 'Lewis' },
  { firstName: 'Toby', surname: 'Lewis' },
  { firstName: 'Rhys', surname: 'Lewis' },
  { firstName: 'Kyle', surname: 'Newall' },
  { firstName: 'Nick', surname: 'Hines' },
  { firstName: 'Craig', surname: 'Trapps' },
];

// A plausible Play-Cricket player list: some names match exactly, some are
// the "formal" version of a nickname, some have a one-letter surname typo,
// and "Hines" is deliberately absent (simulating a player with no
// Play-Cricket record yet).
const pcPlayers = [
  { id: 1, name: 'Thomas Wright', play_cricket_id: 101 },
  { id: 2, name: 'Darren Roach', play_cricket_id: 102 },
  { id: 3, name: 'Daniel Moran', play_cricket_id: 103 },
  { id: 4, name: 'Adrian Baker', play_cricket_id: 104 },
  { id: 5, name: 'Joe Stack', play_cricket_id: 105 },
  { id: 6, name: 'Guy Norris', play_cricket_id: 106 },
  { id: 7, name: 'Alex Norris', play_cricket_id: 107 },
  { id: 8, name: 'Rowan Lewis', play_cricket_id: 108 },
  { id: 9, name: 'Toby Lewis', play_cricket_id: 109 },
  { id: 10, name: 'Rhys Lewis', play_cricket_id: 110 },
  { id: 11, name: 'Kyle Newell', play_cricket_id: 111 }, // typo vs "Newall"
  { id: 12, name: 'Craig Trapp', play_cricket_id: 112 }, // typo vs "Trapps"
];

const results = matchPlayers(hitssportsNames, pcPlayers);
const byName = (first, sur) =>
  results.find((r) => r.hitssports.firstName === first && r.hitssports.surname === sur);

function expectTopMatch(first, sur, matchType, expectedName) {
  const r = byName(first, sur);
  assert.ok(r, `${first} ${sur} should be in results`);
  assert.strictEqual(r.matchType, matchType, `${first} ${sur}: expected ${matchType}, got ${r.matchType}`);
  assert.strictEqual(r.candidates[0].name, expectedName, `${first} ${sur}: expected top candidate ${expectedName}`);
}

expectTopMatch('Darren', 'Roach', 'exact', 'Darren Roach');
expectTopMatch('Joe', 'Stack', 'exact', 'Joe Stack');
expectTopMatch('Guy', 'Norris', 'exact', 'Guy Norris');
expectTopMatch('Alex', 'Norris', 'exact', 'Alex Norris');
expectTopMatch('Rowan', 'Lewis', 'exact', 'Rowan Lewis');
expectTopMatch('Toby', 'Lewis', 'exact', 'Toby Lewis');
expectTopMatch('Rhys', 'Lewis', 'exact', 'Rhys Lewis');
console.log('exact matches (incl. disambiguating same-surname players): PASS');

expectTopMatch('Tommy', 'Wright', 'nickname', 'Thomas Wright');
expectTopMatch('Danny', 'Moran', 'nickname', 'Daniel Moran');
expectTopMatch('Ady', 'Baker', 'nickname', 'Adrian Baker');
console.log('nickname matches: PASS');

expectTopMatch('Kyle', 'Newall', 'fuzzy', 'Kyle Newell');
expectTopMatch('Craig', 'Trapps', 'fuzzy', 'Craig Trapp');
console.log('fuzzy (typo) matches: PASS');

const hines = byName('Nick', 'Hines');
assert.strictEqual(hines.matchType, 'none');
assert.strictEqual(hines.candidates.length, 0);
console.log('correctly reports no match for a player absent from Play-Cricket data: PASS');

console.log('\nAll player-matching tests passed.');
