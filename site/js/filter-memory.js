// ---- Shared Team/Fixture Type/Season filter memory (localStorage) ----
// Fixtures, Averages and Stats each have their own Team/Fixture Type/Season
// dropdowns and already sync the current selection into the URL so a link
// can be bookmarked/shared - but the nav tabs between those pages are plain
// hrefs with no query string, so switching tabs used to silently reset back
// to each page's hard-coded default. This remembers the last selection made
// on any of the three pages so the other two pick it up too; an explicit URL
// param (a bookmarked/shared link) always wins over what's remembered here.
const FilterMemory = (function () {
  const KEY = "barwellcc-filters";

  function loadAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function save(name, values) {
    try {
      const current = loadAll();
      current[name] = values.join(",");
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch (e) {}
  }

  function parseListParam(params, name, allOptions) {
    const raw = params.get(name);
    if (!raw) return null;
    const valid = raw
      .split(",")
      .map((s) => s.trim())
      .filter((v) => allOptions.includes(v));
    return valid.length ? valid : null;
  }

  // URL param wins when present (bookmarked/shared link); otherwise fall
  // back to whatever was last remembered from any page, then the caller's
  // own default.
  function resolveList(urlParams, name, allOptions, fallback) {
    const fromUrl = parseListParam(urlParams, name, allOptions);
    if (fromUrl) return fromUrl;
    const stored = loadAll()[name];
    const fromStorage = stored
      ? parseListParam(new URLSearchParams({ [name]: stored }), name, allOptions)
      : null;
    return fromStorage || fallback;
  }

  return { save, resolveList, parseListParam };
})();
