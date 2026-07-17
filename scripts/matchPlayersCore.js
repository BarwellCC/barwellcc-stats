const { normalize, canonicalFirstName, similarity } = require('./normalizeName');

// Play-Cricket gives us one "player_name" string (e.g. "Chew Leonard"). We
// split on the last space as a reasonable default - this will mis-split a
// handful of genuinely multi-word surnames (e.g. "Van Der Berg"), which is a
// known, acceptable limitation flagged here rather than silently wrong.
function splitPlayCricketName(fullName) {
  const parts = clean(fullName).split(' ');
  if (parts.length === 1) return { firstName: parts[0], surname: '' };
  const surname = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(' ');
  return { firstName, surname };
}

function clean(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

const FUZZY_SURNAME_THRESHOLD = 0.72; // same first name, similar-ish surname (typo)
const FUZZY_FIRSTNAME_THRESHOLD = 0.6; // same surname, similar-ish first name (not a known nickname)

function matchOnePlayer(hs, pcPlayersWithParts) {
  const hsFirst = normalize(hs.firstName);
  const hsSurname = normalize(hs.surname);
  const hsNickFirst = canonicalFirstName(hs.firstName);

  const exact = pcPlayersWithParts.filter(
    (pc) => normalize(pc.firstName) === hsFirst && normalize(pc.surname) === hsSurname
  );
  if (exact.length > 0) {
    return {
      matchType: 'exact',
      candidates: exact.map((pc) => ({ ...pc.player, confidence: 1, reason: 'exact name match' })),
    };
  }

  const nicknameMatches = pcPlayersWithParts.filter(
    (pc) => canonicalFirstName(pc.firstName) === hsNickFirst && normalize(pc.surname) === hsSurname
  );
  if (nicknameMatches.length > 0) {
    return {
      matchType: 'nickname',
      candidates: nicknameMatches.map((pc) => ({
        ...pc.player,
        confidence: 0.9,
        reason: `"${hs.firstName}" / "${pc.firstName}" are a known nickname pair, same surname`,
      })),
    };
  }

  // Same surname, first name similar-but-not-identical (covers unlisted nicknames,
  // minor misspellings like "Danial" vs "Daniel").
  const sameSurname = pcPlayersWithParts.filter((pc) => normalize(pc.surname) === hsSurname);
  const firstNameFuzzy = sameSurname
    .map((pc) => ({ pc, score: similarity(normalize(pc.firstName), hsFirst) }))
    .filter((x) => x.score >= FUZZY_FIRSTNAME_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  // Same first name, surname similar-but-not-identical (covers surname typos).
  const sameFirst = pcPlayersWithParts.filter((pc) => normalize(pc.firstName) === hsFirst);
  const surnameFuzzy = sameFirst
    .map((pc) => ({ pc, score: similarity(normalize(pc.surname), hsSurname) }))
    .filter((x) => x.score >= FUZZY_SURNAME_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const fuzzy = [...firstNameFuzzy, ...surnameFuzzy];
  if (fuzzy.length > 0) {
    // De-dupe by player id, keep the best score seen for each.
    const byId = new Map();
    for (const { pc, score } of fuzzy) {
      const existing = byId.get(pc.player.id);
      if (!existing || score > existing.score) byId.set(pc.player.id, { pc, score });
    }
    return {
      matchType: 'fuzzy',
      candidates: [...byId.values()]
        .sort((a, b) => b.score - a.score)
        .map(({ pc, score }) => ({
          ...pc.player,
          confidence: Math.round(score * 100) / 100,
          reason: `similar name: "${hs.firstName} ${hs.surname}" vs "${pc.firstName} ${pc.surname}"`,
        })),
    };
  }

  return { matchType: 'none', candidates: [] };
}

// hitssportsNames: [{firstName, surname}]
// pcPlayers: [{id, name, play_cricket_id}] - as stored in the players table
function matchPlayers(hitssportsNames, pcPlayers) {
  const pcPlayersWithParts = pcPlayers.map((player) => ({
    player,
    ...splitPlayCricketName(player.name),
  }));

  return hitssportsNames.map((hs) => ({
    hitssports: hs,
    ...matchOnePlayer(hs, pcPlayersWithParts),
  }));
}

module.exports = { matchPlayers, splitPlayCricketName };
