// services/cmdb-assessment/minhash.js
//
// MinHash + LSH + Jaccard for fuzzy name matching. Ported from the pattern
// in getzep/graphiti (graphiti_core/utils/maintenance/dedup_helpers.py).
// Keeps the graphiti-tuned constants: 32 permutations, band size 4,
// Jaccard ≥ 0.9, entropy gate ≥ 1.5. These are tuned against real-world
// entity names and are a reasonable starting point for CMDB CIs.
//
// Pure deterministic JS: no crypto, no LLM. Hash is FNV-1a seeded with
// permutation index so signatures are reproducible across runs.

const MINHASH_PERMUTATIONS   = 32
const MINHASH_BAND_SIZE      = 4
const NAME_ENTROPY_THRESHOLD = 1.5
const JACCARD_THRESHOLD      = 0.9

// ── Tokenisation ────────────────────────────────────────────────────────────
// Character 3-grams on a normalised name. Normalisation lower-cases, strips
// punctuation, and collapses whitespace — matches graphiti's approach and
// makes "Prod Web 01" / "prod-web-01" / "prod_web_01" compare the same.
export function normalizeName(raw) {
  if (!raw) return ''
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function shingles(name, k = 3) {
  const s = normalizeName(name)
  if (s.length < k) return s.length ? new Set([s]) : new Set()
  const out = new Set()
  for (let i = 0; i <= s.length - k; i++) out.add(s.slice(i, i + k))
  return out
}

// ── Shannon entropy gate ────────────────────────────────────────────────────
// Low-entropy names ("db01", "web02") are fuzzy-match death traps — shingle
// overlap is dominated by the common substrate, not the distinguishing bits.
// Gate the fuzzy path on entropy so those names must go through an exact key.
export function shannonEntropy(raw) {
  const s = normalizeName(raw)
  if (!s) return 0
  const counts = new Map()
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1)
  const n = s.length
  let h = 0
  for (const count of counts.values()) {
    const p = count / n
    h -= p * Math.log2(p)
  }
  return h
}

export function hasHighEntropy(raw, threshold = NAME_ENTROPY_THRESHOLD) {
  return shannonEntropy(raw) >= threshold
}

// ── 32-bit FNV-1a ───────────────────────────────────────────────────────────
// Used to derive stable per-permutation hashes. Not cryptographic; we just
// need a well-distributed cheap non-adversarial hash.
function fnv1a(str, seed) {
  let h = (2166136261 ^ seed) >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export function minhashSignature(shingleSet, perms = MINHASH_PERMUTATIONS) {
  // One slot per permutation; init to max uint32.
  const sig = new Uint32Array(perms)
  sig.fill(0xFFFFFFFF)
  if (!shingleSet.size) return sig
  for (const token of shingleSet) {
    for (let p = 0; p < perms; p++) {
      const h = fnv1a(token, p)
      if (h < sig[p]) sig[p] = h
    }
  }
  return sig
}

// ── LSH bucketing ───────────────────────────────────────────────────────────
// Band the signature into fixed-size chunks; two items end up in the same
// bucket iff every hash in at least one band matches. The graphiti-tuned
// band size (4) with 32 permutations gives 8 bands — a good balance
// between recall (enough bands) and precision (bands long enough).
export function bandKeys(sig, bandSize = MINHASH_BAND_SIZE) {
  const keys = []
  for (let start = 0; start < sig.length; start += bandSize) {
    const band = sig.slice(start, start + bandSize)
    // Serialise band hashes into a string key. Hex keeps it compact and
    // avoids JSON overhead in per-CI lookups.
    let key = `b${start / bandSize}:`
    for (const v of band) key += v.toString(16) + ','
    keys.push(key)
  }
  return keys
}

// ── Candidate index ─────────────────────────────────────────────────────────
// Build once per assessment pass (not per CI). Mirrors graphiti's
// DedupCandidateIndexes pattern and AppCloud's rgMappedIndex /
// planMappedIndex convention.
//
// candidates: Array<{ id: string, name: string, ...extras }>
export function buildLshIndex(candidates) {
  const shinglesByCandidate = new Map()
  const sigByCandidate      = new Map()
  const normalizedByCandidate = new Map()
  // Map<bandKey, Set<candidateId>>
  const buckets = new Map()

  for (const c of candidates) {
    if (!c?.id) continue
    const sh  = shingles(c.name)
    const sig = minhashSignature(sh)
    const keys = bandKeys(sig)
    shinglesByCandidate.set(c.id, sh)
    sigByCandidate.set(c.id, sig)
    normalizedByCandidate.set(c.id, normalizeName(c.name))
    for (const k of keys) {
      let set = buckets.get(k)
      if (!set) { set = new Set(); buckets.set(k, set) }
      set.add(c.id)
    }
  }

  return {
    shinglesByCandidate,
    sigByCandidate,
    normalizedByCandidate,
    buckets,
    size: candidates.length,
  }
}

// ── Jaccard on shingle sets ─────────────────────────────────────────────────
export function jaccard(a, b) {
  if (!a.size && !b.size) return 1
  if (!a.size || !b.size) return 0
  let intersection = 0
  // Iterate the smaller set for a tight loop.
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const v of small) if (large.has(v)) intersection++
  const union = a.size + b.size - intersection
  return intersection / union
}

// ── The main resolver ──────────────────────────────────────────────────────
// Stage 1: exact normalized-name match (index scan — O(N) on first call,
//          but we keep a reverse map so subsequent lookups are O(1)).
// Stage 2: entropy gate — refuse fuzzy match on short/low-entropy names.
// Stage 3: LSH bucket lookup → Jaccard on candidates in the same band.
//
// Returns { candidateId, jaccard, matchType } or null.
export function resolveByName(name, index, {
  jaccardThreshold = JACCARD_THRESHOLD,
  entropyThreshold = NAME_ENTROPY_THRESHOLD,
} = {}) {
  const normalized = normalizeName(name)
  if (!normalized) return null

  // Stage 1 — exact normalized match.
  for (const [id, candName] of index.normalizedByCandidate) {
    if (candName === normalized) {
      return { candidateId: id, jaccard: 1, matchType: 'exact_normalized_name' }
    }
  }

  // Stage 2 — entropy gate.
  if (!hasHighEntropy(name, entropyThreshold)) return null

  // Stage 3 — LSH candidates + Jaccard.
  const sh  = shingles(name)
  const sig = minhashSignature(sh)
  const candidateIds = new Set()
  for (const key of bandKeys(sig)) {
    const set = index.buckets.get(key)
    if (set) for (const id of set) candidateIds.add(id)
  }
  if (!candidateIds.size) return null

  let best = null
  for (const id of candidateIds) {
    const candShingles = index.shinglesByCandidate.get(id)
    if (!candShingles) continue
    const j = jaccard(sh, candShingles)
    if (j >= jaccardThreshold && (!best || j > best.jaccard)) {
      best = { candidateId: id, jaccard: j, matchType: 'fuzzy_name' }
    }
  }
  return best
}

// Constants exposed for tests + tuning.
export const CONSTANTS = {
  MINHASH_PERMUTATIONS,
  MINHASH_BAND_SIZE,
  NAME_ENTROPY_THRESHOLD,
  JACCARD_THRESHOLD,
}
