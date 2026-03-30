const assert = require('assert');
const path = require('path');

const schemaLoader = require(path.join('..', 'src', 'backend', 'schema-loader'));

function findMessage(defs, name) {
  return defs.find((m) => String(m.name).toUpperCase() === String(name).toUpperCase());
}

function run() {
  const defs = schemaLoader.getAllMessageDefinitions();

  const ubxPvt = findMessage(defs, 'UBX-NAV-PVT');
  assert.ok(ubxPvt, 'UBX-NAV-PVT must exist in message definitions');
  assert.ok(ubxPvt.cfgKeys, 'UBX-NAV-PVT must expose cfgKeys');
  assert.strictEqual(ubxPvt.cfgKeys.uart1, 0x20910007, 'UBX-NAV-PVT UART1 key mismatch');
  assert.strictEqual(ubxPvt.cfgKeys.uart2, 0x20910008, 'UBX-NAV-PVT UART2 key mismatch');
  assert.strictEqual(ubxPvt.cfgKeys.usb, 0x20910009, 'UBX-NAV-PVT USB key mismatch');

  const ubxMonRf = findMessage(defs, 'UBX-MON-RF');
  assert.ok(ubxMonRf, 'UBX-MON-RF must exist in message definitions');
  assert.ok(ubxMonRf.cfgKeys, 'UBX-MON-RF must expose cfgKeys');
  assert.strictEqual(ubxMonRf.cfgKeys.uart1, 0x2091035a, 'UBX-MON-RF UART1 key mismatch');
  assert.strictEqual(ubxMonRf.cfgKeys.uart2, 0x2091035b, 'UBX-MON-RF UART2 key mismatch');
  assert.strictEqual(ubxMonRf.cfgKeys.usb, 0x2091035c, 'UBX-MON-RF USB key mismatch');

  const nmeaGga = findMessage(defs, 'GGA');
  assert.ok(nmeaGga, 'NMEA GGA must exist in message definitions');
  assert.ok(nmeaGga.cfgKeys, 'NMEA GGA must expose cfgKeys');
  assert.strictEqual(nmeaGga.cfgKeys.uart1, 0x209100bb, 'GGA UART1 key mismatch');
  assert.strictEqual(nmeaGga.cfgKeys.uart2, 0x209100bc, 'GGA UART2 key mismatch');
  assert.strictEqual(nmeaGga.cfgKeys.usb, 0x209100bd, 'GGA USB key mismatch');

  const expectedNmeaCfg = {
    DTM: { uart1: 0x209100a7, uart2: 0x209100a8, usb: 0x209100a9 },
    GBS: { uart1: 0x209100de, uart2: 0x209100df, usb: 0x209100e0 },
    GGA: { uart1: 0x209100bb, uart2: 0x209100bc, usb: 0x209100bd },
    GLL: { uart1: 0x209100ca, uart2: 0x209100cb, usb: 0x209100cc },
    GNS: { uart1: 0x209100b6, uart2: 0x209100b7, usb: 0x209100b8 },
    GRS: { uart1: 0x209100cf, uart2: 0x209100d0, usb: 0x209100d1 },
    GSA: { uart1: 0x209100c0, uart2: 0x209100c1, usb: 0x209100c2 },
    GST: { uart1: 0x209100d4, uart2: 0x209100d5, usb: 0x209100d6 },
    GSV: { uart1: 0x209100c5, uart2: 0x209100c6, usb: 0x209100c7 },
    RLM: { uart1: 0x20910401, uart2: 0x20910402, usb: 0x20910403 },
    RMC: { uart1: 0x209100ac, uart2: 0x209100ad, usb: 0x209100ae },
    THS: { uart1: 0x209100e3, uart2: 0x209100e4, usb: 0x209100e5 },
    VTG: { uart1: 0x209100b1, uart2: 0x209100b2, usb: 0x209100b3 },
    ZDA: { uart1: 0x209100d9, uart2: 0x209100da, usb: 0x209100db }
  };

  for (const [name, expected] of Object.entries(expectedNmeaCfg)) {
    const msg = findMessage(defs, name);
    assert.ok(msg, `NMEA ${name} must exist in message definitions`);
    assert.ok(msg.cfgKeys, `NMEA ${name} must expose cfgKeys`);
    assert.strictEqual(msg.cfgKeys.uart1, expected.uart1, `${name} UART1 key mismatch`);
    assert.strictEqual(msg.cfgKeys.uart2, expected.uart2, `${name} UART2 key mismatch`);
    assert.strictEqual(msg.cfgKeys.usb, expected.usb, `${name} USB key mismatch`);
    assert.strictEqual(msg.supportedOnUblox, true, `${name} must be supportedOnUblox=true`);
  }

  const supportedNmeaNames = defs
    .filter((m) => m.category === 'nmea' && m.supportedOnUblox === true)
    .map((m) => String(m.name).toUpperCase())
    .sort();
  const expectedSupported = Object.keys(expectedNmeaCfg).sort();
  assert.deepStrictEqual(supportedNmeaNames, expectedSupported, 'u-blox supported NMEA set mismatch');

  const schema = schemaLoader.getMessageSchema('UBX_NAV_PVT', 'binary');
  assert.ok(schema, 'UBX message schema should be returned for UBX_NAV_PVT');
  assert.ok(Array.isArray(schema.fields) && schema.fields.length > 0, 'UBX_NAV_PVT schema should include fields');

  const ubxKeys = schemaLoader.getAllUbxCfgKeys();
  const keyEntry = ubxKeys.find((e) =>
    String(e.familyKey || '').toUpperCase() === 'UBX_NAV_PVT' ||
    String(e.name || '').toUpperCase() === 'UBX-NAV-PVT'
  );
  assert.ok(keyEntry, 'getAllUbxCfgKeys must include UBX_NAV_PVT');
  assert.ok(keyEntry.cfg_keys, 'UBX key entry must include cfg_keys');
  assert.strictEqual(keyEntry.cfg_keys.uart1, 0x20910007, 'getAllUbxCfgKeys UART1 mismatch');
  assert.strictEqual(keyEntry.cfg_keys.uart2, 0x20910008, 'getAllUbxCfgKeys UART2 mismatch');
  assert.strictEqual(keyEntry.cfg_keys.usb, 0x20910009, 'getAllUbxCfgKeys USB mismatch');

  const monRfKeyEntry = ubxKeys.find((e) =>
    String(e.familyKey || '').toUpperCase() === 'UBX_MON_RF' ||
    String(e.name || '').toUpperCase() === 'UBX-MON-RF'
  );
  assert.ok(monRfKeyEntry, 'getAllUbxCfgKeys must include UBX_MON_RF');
  assert.ok(monRfKeyEntry.cfg_keys, 'UBX_MON_RF entry must include cfg_keys');
  assert.strictEqual(monRfKeyEntry.cfg_keys.uart1, 0x2091035a, 'UBX_MON_RF UART1 mismatch');
  assert.strictEqual(monRfKeyEntry.cfg_keys.uart2, 0x2091035b, 'UBX_MON_RF UART2 mismatch');
  assert.strictEqual(monRfKeyEntry.cfg_keys.usb, 0x2091035c, 'UBX_MON_RF USB mismatch');
}

try {
  run();
  console.log('f9p-schema.test.js: PASS');
} catch (err) {
  console.error('f9p-schema.test.js: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
