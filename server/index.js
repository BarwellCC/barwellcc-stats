const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 4000;

// The site is fully static now - every page fetches its data from
// site/data/*.json (produced by `npm run build-static`) and computes
// everything client-side via site/js/cricket-calc.js. This server's only
// job is serving those files locally exactly as GitHub Pages will in
// production, so there's no live/static behaviour to drift apart. Run
// `npm run build-static` after `npm run sync` any time the underlying data
// changes - this server doesn't regenerate it automatically.
app.use(express.static(path.join(__dirname, '..', 'site')));

app.listen(PORT, () => {
  console.log(`Barwell CC site running at http://localhost:${PORT}/fixtures.html`);
});
