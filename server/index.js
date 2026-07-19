const path = require('path');
const express = require('express');
const fixturesRouter = require('./routes/fixtures');
const matchesRouter = require('./routes/matches');
const averagesRouter = require('./routes/averages');
const statsRouter = require('./routes/stats');

const app = express();
const PORT = process.env.PORT || 4000;

app.use('/api', fixturesRouter);
app.use('/api', matchesRouter);
app.use('/api', averagesRouter);
app.use('/api', statsRouter);
app.use(express.static(path.join(__dirname, '..', 'site')));

app.listen(PORT, () => {
  console.log(`Barwell CC site running at http://localhost:${PORT}/fixtures.html`);
});
