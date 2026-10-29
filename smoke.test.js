import test from 'node:test';
import assert from 'node:assert/strict';
import { packages } from '../server.js';

test('the configured packages match requested coin counts and prices', () => {
  assert.deepEqual(packages.map(p => [p.coins, p.amountCents]), [
    [700, 0], [350, 749], [820, 1550], [1359, 3201], [2707, 7500]
  ]);
});

test('paid products have Cakto checkout URLs and free package has none', () => {
  assert.equal(packages[0].checkoutUrl, null);
  for (const p of packages.slice(1)) {
    assert.match(p.checkoutUrl, /^https:\/\/pay\.cakto\.com\.br\//);
  }
});
