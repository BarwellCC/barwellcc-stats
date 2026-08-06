// Shared by every page that renders a player name (Averages/Stats/
// Scorecard/Player) - a small, non-interactive warning icon next to any
// name still sitting in site/data/duplicate-candidates.json (built by
// scripts/findDuplicatePlayers.js via npm run build-static), so a
// not-yet-resolved duplicate is visible wherever it shows up, not just on
// the unlinked site/duplicates.html review page. A name drops off this list on
// its own the next time the site rebuilds after someone confirms the merge
// in data/player-merges.json - nothing here needs updating by hand.
(function (root) {
  // Below this, the front-end flag stays quiet - low-confidence fuzzy
  // matches (two different real people who just happen to share initials,
  // e.g. "Kaiden Roach" / "Kayden Roach") are still worth a human's
  // attention, but not worth flagging on every page they appear on. The
  // unlinked site/duplicates.html review page has no such cutoff - it always
  // lists every candidate, confidence included, since that's the one place
  // meant for full review rather than a quick visual cue.
  const MIN_CONFIDENCE = 0.7;

  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Every caller fetches independently (each page is its own load, no
  // shared state across page navigations) - a missing or empty file just
  // means nothing gets flagged, not an error. Maps a flagged name to the
  // other name(s) it was matched against, e.g. "Jack Smith" -> ["Jacob
  // Smith"], so the tooltip can say who it might actually be rather than
  // just "this name looks suspicious" - a player can appear in more than
  // one candidate pair (see "Geoff Hines" / "Geoff Hines Jnr" / "Geoff
  // Hines Snr"), hence a Set of names per entry, not a single string.
  function fetchFlaggedNames() {
    return fetch('data/duplicate-candidates.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((candidates) => {
        const others = new Map();
        const add = (name, otherName) => {
          if (!others.has(name)) others.set(name, new Set());
          others.get(name).add(otherName);
        };
        for (const c of candidates) {
          if (c.confidence < MIN_CONFIDENCE) continue;
          add(c.a.name, c.b.name);
          add(c.b.name, c.a.name);
        }
        return others;
      })
      .catch(() => new Map());
  }

  // flaggedNames is passed in explicitly (rather than read off a module-level
  // variable) so a page can't accidentally render a name cell before its own
  // fetchFlaggedNames() promise has resolved.
  function badge(name, flaggedNames) {
    if (!flaggedNames || !flaggedNames.has(name)) return '';
    const others = [...flaggedNames.get(name)].join(', ');
    const title = escapeAttr(`Potential duplicate - possible match: ${others}`);
    return `<span class="dup-flag" title="${title}" aria-label="${title}">`
      + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>'
      + '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
      + '</svg></span>';
  }

  root.DuplicateFlags = { fetchFlaggedNames, badge };
})(window);
