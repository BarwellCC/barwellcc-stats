const { openDb } = require('../scripts/db');

// One shared connection for the life of the server - openDb() applies
// schema.sql + migrations, cheap to call once, no reason to reopen per-request.
module.exports = openDb();
