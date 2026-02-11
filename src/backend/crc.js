// CRC32 (BYNAV) + CRC-24Q (RTCM v3)

const CRC32_POLYNOMIAL = 0xEDB88320;

function calcCrc32Value(value) {
  let crc = value >>> 0;
  for (let i = 0; i < 8; i++) {
    if (crc & 1) {
      crc = ((crc >>> 1) ^ CRC32_POLYNOMIAL) >>> 0;
    } else {
      crc = crc >>> 1;
    }
  }
  return crc >>> 0;
}

function calcBlockCrc32(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    const tmp1 = ((crc >>> 8) & 0x00FFFFFF) >>> 0;
    const tmp2 = calcCrc32Value((crc ^ data[i]) & 0xFF);
    crc = (tmp1 ^ tmp2) >>> 0;
  }
  return crc >>> 0;
}

// RTCM v3 CRC-24Q
const CRC24Q_POLY = 0x1864CFB;

function crc24q(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] << 16);
    for (let j = 0; j < 8; j++) {
      crc <<= 1;
      if (crc & 0x1000000) {
        crc ^= CRC24Q_POLY;
      }
    }
    crc &= 0xFFFFFF;
  }
  return crc & 0xFFFFFF;
}

module.exports = { calcBlockCrc32, crc24q };
