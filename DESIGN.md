# Design reference — Barwell CC site

Approved starting point as of the Averages/Stats mockups in `mockups/`. Reuse
these decisions directly when building the real frontend rather than
re-deriving them.

## Concept

Village club, established 1807, with a literal "Honours Board" already on the
old site. Design leans into that: a scorebook/pavilion feel rather than a
generic sports-dashboard look. Signature element: a dark-green "plaque"
header band with brass/gold lettering, echoing an engraved honours board.

## Tokens

```css
--pitch-green:      #1E3A2B;   /* header band, primary accent — fixed, same in both themes */
--pitch-green-dark: #142A1E;   /* header band gradient end — fixed, same in both themes */
--cream:             #F6F1E4;   /* fixed light text-on-dark-surface colour (plaque/nav/buttons) — NOT the page bg, and does not change with theme */
--bg-page:           #F6F1E4;   /* page background — flips dark, see Dark mode below */
--card:              #FFFDF8;   /* card/table background, odd rows — flips dark */
--row-even:          #F5EFE1;   /* even row stripe (solid, not rgba — needed for sticky columns) — flips dark */
--head-bg:           #EDE7D6;   /* table header row background — flips dark */
--ink:               #201E18;   /* body text — flips dark */
--ink-soft:          #5B5548;   /* secondary text, labels — flips dark */
--maroon:            #7A2E2E;   /* solid-fill accent (button backgrounds only) — fixed, always paired with --cream text, same in both themes */
--accent:            #7A2E2E;   /* text/border accent (links, section labels, sorted-arrow, scores) — brightens in dark mode; same value as --maroon in light mode but a DIFFERENT variable, don't conflate them */
--brass:             #B8923A;   /* honours/highlight accent (top-row marker only; badges removed) — fixed, same in both themes */
--brass-bright:      #D4AF5A;   /* eyebrow text on dark plaque — fixed, same in both themes */
--line / --line-strong: #E1D8C0 / #CBBE9C;  /* hairlines, borders — flips dark */
```

Fonts: **Fraunces** (serif, display/headings — plaque titles, section labels)
+ **Inter** (everything else). Table numbers use `font-variant-numeric:
tabular-nums` so columns line up.

## Dark mode

Every mockup supports light/dark via a toggle button (sun/moon icon) at the
right end of `.site-nav`, plus auto-detection of the OS preference on first
visit. Implementation:

- `@media (prefers-color-scheme: dark)` sets the dark values as the default
  when no explicit choice has been made.
- `:root[data-theme="dark"]` / `:root[data-theme="light"]` override the OS
  preference once the user clicks the toggle; the choice is written to
  `localStorage['barwellcc-theme']` and read back by an inline `<script>` at
  the very top of `<head>` (before the stylesheet) so there's no flash of the
  wrong theme on load. Since the pages are plain static files with no shared
  layout/include, this snippet — and the toggle button markup/CSS/JS — is
  duplicated identically in all three; keep them in sync by hand until there's
  a real templating layer.
- **Why two accent variables (`--maroon` vs `--accent`)**: `--maroon` is only
  ever a *solid fill* (button backgrounds), always paired with the fixed
  `--cream` text, so it stays a deep red in both themes — lightening it would
  wreck button contrast. `--accent` is for *text/border* uses of the same hue
  (section labels, sorted-column arrow, `.not-out`, scorecard links, batting
  scores) sitting directly on `--card`/`--bg-page`,
  so it needs to brighten in dark mode or it goes nearly invisible on a dark
  card. Don't reuse `--maroon` for a new text-color use case — use `--accent`.
- `--pitch-green`, `--pitch-green-dark`, `--cream`, `--brass`, `--brass-bright`
  don't change between themes — they only ever appear on the plaque/nav, which
  stay dark green in both themes.
- Fixtures' W/L pills (`--win`/`--loss`) also brighten in dark mode so they
  stay visible against the darker card background, not just for their
  (always-white) internal text contrast.

## Component patterns (reusable — see `mockups/*.html` for full code)

- **Site nav** (`.site-nav`): slim dark-green bar above the plaque, full-bleed
  like the plaque itself. Three links — Fixtures, Stats, Averages — as
  separate pages sharing this nav, not tabs within one page. Active link gets
  brass text + brass underline. Present identically at the top of all three
  mockups now (`fixtures-refresh.html`, `stats-refresh.html`,
  `averages-refresh.html`).
- **Plaque header: retired.** All three pages originally had one (dark
  green→darker gradient, subtle repeating-line texture, brass eyebrow text,
  serif title, muted subtitle) but it's been removed from Fixtures, then
  Averages, then Stats, per feedback each time — the nav's active tab already
  identifies the page, so the extra headline was redundant. Don't
  reintroduce `.plaque`/`.plaque-eyebrow`/`.plaque-title`/`.plaque-sub`
  without a specific reason; the class names are gone from all three
  mockups now, not just unused. Since there's no plaque anywhere, `.site-nav`
  always carries its own bottom border-radius (`0 0 var(--radius)
  var(--radius)` + `overflow:hidden`) so it doesn't end in a hard square
  edge, and the element directly below it (`.filter-row` on Fixtures/
  Averages, `.tabs` on Stats) carries `margin-top:18px` to reproduce the
  spacing the plaque used to provide.
- **Multi-select dropdown** (`initMultiSelect`): button shows "All" / one
  name / "N selected"; panel has checkboxes + Select all/Clear. Used for
  Team and Season on Stats/Averages, and for **Fixture Type on Fixtures and
  Averages** (League/Cup/Friendly, default all-selected = "All"). The label
  reads "Fixture Type" everywhere now (Fixtures, Averages, and Stats' own
  single-select field, which used to say "Fixture types") — internal
  identifiers still say `comp`/`compSelect`/`compOptions`/`applyCompFilter`,
  that's fine, only the user-facing label changed. This field used to be a
  single-select chip-group (`.chip`/`.chip-group` — now removed everywhere,
  don't resurrect it); it became a dropdown so users can combine types, e.g.
  League + Cup while excluding Friendly. On Fixtures, this dropdown is the
  one filter that's actually wired up: `applyCompFilter()` re-renders the
  fixtures table filtered by the selection. Team and Season on Fixtures
  don't filter anything yet, since only one team/season is synced so far —
  see the "Known gap" section in `README.md`.
- **Single-select pick list** (`.pick`, in `fixtures-refresh.html` only):
  plain native `<select>` styled to match, for Team and Season specifically
  (not Competition, which is the multi-select above). Fixtures is inherently
  one-team-at-a-time (mirrors the old Hitssports fixtures page, which is
  per-team by URL), so the multi-select's checkboxes/Select all/Clear chrome
  was unnecessary complexity for those two fields.
- **Filter row left/right split**: on desktop, the Team + Competition filters
  sit left-aligned and Season is pushed to the right edge via
  `.filter-group.season-group{ margin-left:auto }` on a `justify-content:
  space-between` row, rather than everything clustering left with dead space
  on the right. Applies to Fixtures and Averages (Stats uses a different,
  grid-based search-card layout, not this filter-row pattern). Team dropdown
  width is bumped past the shared default (`min-width:152px`) via an
  ID-scoped rule (`#teamSelect .msel-btn` / `#teamPick`, `min-width:200px`)
  so "Midweek 2nd XI" fits on one line — don't widen `.msel-btn`/`.pick`
  globally, since Season's labels are short and don't need it.
- **Sortable table headers**: click a `<th>` to sort by that column,
  ascending/descending toggle, arrow indicator. Applied to every data table.
- **Sticky first column + scroll-fade hint**: on tables wider than the
  viewport, the leftmost (name) column stays pinned while scrolling
  horizontally; a right-edge shadow appears only when there's more to scroll
  (`initScrollHint`). This is the mobile-first solution for wide stats tables
  rather than collapsing to per-player cards, since comparing players
  side-by-side is the point of an averages table.
- **No badges on milestones** (100s, 5-wicket hauls) — plain numbers only,
  per feedback. The only remaining highlight is the brass left-border marker
  on the table's top performer.
- **Batting/bowling Average and Economy: always 1 decimal place.** Rendered
  via `Number(val).toFixed(1)` in Averages' table-draw function, not left to
  however many decimals happen to be in the source data — the raw numbers
  were inconsistent (e.g. `61.00` / `27.43` rendering as `"61"` / `"27.43"`
  since JS drops trailing zeros by default), which read as arbitrary
  precision rather than a deliberate format. Apply the same `.toFixed(1)` to
  any other page that ever shows Avg/Econ (Stats' results table doesn't
  currently have either column).

## Mobile-first approach

Base (unprefixed) CSS rules are the phone layout: stacked filters, full-width
controls, 12px page padding, smaller type. A single `@media (min-width:
640px)` block adds the desktop treatment (inline filter row, wider padding,
larger type). Don't add more breakpoints without a reason — this has covered
phone through desktop cleanly so far.

## Not yet decided

- Visual treatment for other pages (News, Teams, Club Shop, Honours Board) —
  Averages, Stats and now Fixtures have been designed (see
  `mockups/fixtures-refresh.html`); those three are separate pages tied
  together by the new `.site-nav`, not tabs within one page.
- Whether the Team tabs→dropdown change on Averages should also change how
  team switching works elsewhere on the site (Fixtures already diverged —
  see single-select pick list above).
- Fixtures page result column shows a W/L/T pill + "our score v their score"
  rather than copying Hitssports' prose ("Won by 14 Runs") — the schema
  captures scores accurately (see result-flip fix) but not win margin, so this
  reads better than a description we can't fully back with real data yet.
- Kick-off time isn't in `schema.sql`/`matches` yet — Play-Cricket's fixture
  list has it, but the sync currently only stores completed matches at all
  (see below). Needed before the Fixtures page can go live.
