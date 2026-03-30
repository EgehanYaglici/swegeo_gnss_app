function normalizeKeys(keys) {
  const unique = new Set();
  const normalized = [];
  for (const raw of Array.isArray(keys) ? keys : []) {
    const key = Number(raw);
    if (!Number.isFinite(key) || key <= 0) continue;
    const u32 = key >>> 0;
    if (unique.has(u32)) continue;
    unique.add(u32);
    normalized.push(u32);
  }
  return normalized;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function hasKey(result, key) {
  return !!result && Object.prototype.hasOwnProperty.call(result, String(key >>> 0));
}

function mergeKnown(target, result, expectedKeys) {
  let mergedCount = 0;
  for (const key of expectedKeys) {
    if (!hasKey(result, key)) continue;
    target[key] = result[key];
    mergedCount++;
  }
  return mergedCount;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Query UBX CFG keys resiliently:
// 1) batch query for speed
// 2) if some keys are missing (NAK/timeout/partial), retry missing keys one-by-one
async function requestCfgValuesResilient(requestFn, keys, options = {}) {
  if (typeof requestFn !== 'function') return {};
  const normalized = normalizeKeys(keys);
  if (normalized.length === 0) return {};

  const batchSize = Math.max(1, Number(options.batchSize) || 24);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 500);
  const fallbackToSingle = options.fallbackToSingle !== false;
  const interRequestDelayMs = Math.max(0, Number(options.interRequestDelayMs) || 0);

  const merged = {};
  const chunks = chunkArray(normalized, batchSize);

  for (const chunk of chunks) {
    const batchResult = await requestFn(chunk, { timeoutMs });
    mergeKnown(merged, batchResult, chunk);

    if (!fallbackToSingle) {
      if (interRequestDelayMs > 0) await sleep(interRequestDelayMs);
      continue;
    }

    for (const key of chunk) {
      if (hasKey(merged, key)) continue;
      const single = await requestFn([key], { timeoutMs });
      mergeKnown(merged, single, [key]);
      if (interRequestDelayMs > 0) await sleep(interRequestDelayMs);
    }
  }

  return merged;
}

module.exports = {
  requestCfgValuesResilient
};
