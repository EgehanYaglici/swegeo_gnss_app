const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const DeviceQuery = require(path.join('..', 'src', 'backend', 'device-query'));

class MockSerial extends EventEmitter {
  sendCommand() { return { ok: true }; }
  sendUbx() { return { ok: true }; }
}

async function testCfgGetNakResolvesWithoutTimeout() {
  const serial = new MockSerial();
  const dq = new DeviceQuery(serial);

  const start = Date.now();
  const pending = dq.requestUbxCfgGet([0x209100BB], { timeoutMs: 1000 });

  setTimeout(() => {
    const payload = Buffer.from([0x06, 0x8B]); // ACK-NAK for CFG-VALGET
    serial.emit('binary', { ok: true, id: (0x05 << 8) | 0x00, payload });
  }, 10);

  const result = await pending;
  const elapsed = Date.now() - start;

  assert.deepStrictEqual(result, {}, 'NAK should resolve CFG-VALGET with empty result');
  assert.ok(elapsed < 300, `NAK path should resolve quickly, got ${elapsed}ms`);

  dq.destroy();
}

async function testCfgGetHonorsCustomTimeout() {
  const serial = new MockSerial();
  const dq = new DeviceQuery(serial);

  const start = Date.now();
  const result = await dq.requestUbxCfgGet([0x209100BB], { timeoutMs: 50 });
  const elapsed = Date.now() - start;

  assert.deepStrictEqual(result, {}, 'Timeout should resolve with empty result');
  assert.ok(elapsed < 300, `Custom timeout should be short, got ${elapsed}ms`);

  dq.destroy();
}

(async () => {
  try {
    await testCfgGetNakResolvesWithoutTimeout();
    await testCfgGetHonorsCustomTimeout();
    console.log('device-query-cfgget.test.js: PASS');
  } catch (err) {
    console.error('device-query-cfgget.test.js: FAIL');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
