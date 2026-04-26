// services/bandejaCache.service.js
const bandejaCache = new Map();

function cacheGet(key) {
  const hit = bandejaCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    bandejaCache.delete(key);
    return null;
  }
  return hit.val;
}

function cacheSet(key, val, ttlMs) {
  bandejaCache.set(key, { val, exp: Date.now() + ttlMs });
}

function cacheClearBandeja() {
  bandejaCache.clear();
}

module.exports = {
  cacheGet,
  cacheSet,
  cacheClearBandeja,
};