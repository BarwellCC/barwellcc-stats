// Quick sanity test - no framework, just asserts and exits non-zero on failure.
// Run with: node test/reconcilePlayCricket.test.js
const assert = require('assert');
const { ourResultFromSummary } = require('../scripts/reconcilePlayCricket');

// 'C' (cancelled) is never a real played match - no result to compare.
assert.strictEqual(ourResultFromSummary({ result: 'C', result_applied_to: '' }, '968'), null);
console.log('cancelled -> null: PASS');

// A plain 'W' is only ever from result_applied_to's perspective - flip to
// 'L' for us when it names the other side. Real example: 16/05/2009 "2nd XI
// Kibworth CC vs 1st XI Barwell CC", PC says result:'W', result_applied_to
// is Kibworth's team_id (14951) - we (away, team_id 86868) actually lost.
assert.strictEqual(
  ourResultFromSummary({ result: 'W', result_applied_to: '14951' }, '86868'),
  'L',
  'W applied to the opponent means a loss for us'
);
assert.strictEqual(
  ourResultFromSummary({ result: 'W', result_applied_to: '86868' }, '86868'),
  'W',
  'W applied to us means a win for us'
);
console.log('W perspective flip: PASS');

// 'CON' (conceded) also names the *winning* team in result_applied_to, not
// the team that conceded - verified against a real fixture
// (21/04/2018, "Barwell CC - 2nd XI - Conceded", result_applied_to: '8144'
// = Quorn's home_team_id, the side that got the points, not Barwell's).
assert.strictEqual(
  ourResultFromSummary({ result: 'CON', result_applied_to: '8144' }, '145190'),
  'L',
  'we conceded (we are 145190), Quorn (8144) is credited with result_applied_to -> loss for us'
);
assert.strictEqual(
  ourResultFromSummary({ result: 'CON', result_applied_to: '145190' }, '145190'),
  'W',
  'the opposition conceded to us -> win for us'
);
console.log('CON perspective flip: PASS');

// Drawn/tied/abandoned apply symmetrically - no team_id to flip against.
assert.strictEqual(ourResultFromSummary({ result: 'D', result_applied_to: '' }, '968'), 'D');
assert.strictEqual(ourResultFromSummary({ result: 'T', result_applied_to: '' }, '968'), 'T');
assert.strictEqual(ourResultFromSummary({ result: 'A', result_applied_to: '' }, '968'), 'A');
console.log('symmetric results (D/T/A): PASS');

console.log('\nAll tests passed.');
