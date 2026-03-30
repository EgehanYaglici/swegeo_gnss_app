const assert = require('assert');
const path = require('path');
const { requestCfgValuesResilient } = require(path.join('..', 'src', 'backend', 'ubx-cfg-query'));

async function testFallsBackPerKeyWhenBatchFails() {
  const calls = [];
  const requestFn = async (keys) => {
    calls.push(keys.slice());
    if (keys.length > 1) {
      return { 1: 10 }; // batch returns partial only
    }
    if (keys[0] === 2) return {}; // unsupported key
    if (keys[0] === 3) return { 3: 30 };
    return {};
  };

  const result = await requestCfgValuesResilient(requestFn, [1, 2, 3], {
    batchSize: 3,
    timeoutMs: 100,
    fallbackToSingle: true,
    interRequestDelayMs: 0
  });

  assert.deepStrictEqual(result, { 1: 10, 3: 30 }, 'Resilient query should merge batch+single successes');
  assert.strictEqual(calls.length, 3, 'Expected one batch call + two single-key fallbacks');
}

(async () => {
  try {
    await testFallsBackPerKeyWhenBatchFails();
    console.log('ubx-cfg-query.test.js: PASS');
  } catch (err) {
    console.error('ubx-cfg-query.test.js: FAIL');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
