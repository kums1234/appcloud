// Run a callback with deterministic substitutes for `Math.random`,
// `crypto.randomUUID`, and the `Date` constructor — originals restored
// on exit (success or throw). For build-time work that produces
// checked-in artefacts (Postman collection, mock fixtures, snapshot
// JSON) where a third-party tool pulls examples or IDs from those
// globals, this is what makes the output stable across runs.
//
// IMPORTANT: any module whose code captures these globals at load time
// must be imported INSIDE the callback. The vendored json-schema-faker
// inside openapi-to-postmanv2 does exactly this for `Math.random` —
// patching after the import is a no-op for the captured reference.
//
// Usage:
//
//   import { withDeterministicGlobals } from './_lib/with-deterministic-globals.js'
//
//   const collection = await withDeterministicGlobals(async () => {
//     const converter = (await import('some-converter')).default
//     return converter.run(input)
//   })

import { createRequire } from 'node:module'

const DEFAULT_SEED          = 0xC0FFEE
const DEFAULT_FIXED_EPOCH_MS = 1704067200000   // 2024-01-01T00:00:00Z
const HEX                    = '0123456789abcdef'

export async function withDeterministicGlobals(fn, opts = {}) {
  const seed         = opts.seed         ?? DEFAULT_SEED
  const fixedEpochMs = opts.fixedEpochMs ?? DEFAULT_FIXED_EPOCH_MS

  // ESM crypto namespace is frozen — go through createRequire to get
  // the mutable CJS exports that downstream modules `require()`.
  const cryptoMod      = createRequire(import.meta.url)('node:crypto')
  const realRandom     = Math.random
  const realRandomUUID = cryptoMod.randomUUID
  const RealDate       = Date

  let state = seed
  function nextU32() {
    // mulberry32 — small, fast, well-mixed PRNG; same input yields
    // identical output. Adequate for fixture generation; not for
    // cryptography (don't reuse this for anything security-relevant).
    state = (state + 0x6D2B79F5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  Math.random = () => nextU32() / 4294967296

  cryptoMod.randomUUID = function seededUUID() {
    // RFC 4122 v4-shaped, but the bytes come from our seeded PRNG.
    let s = ''
    for (let i = 0; i < 32; i++) {
      if (i === 8 || i === 12 || i === 16 || i === 20) s += '-'
      let nibble = nextU32() & 0xF
      if (i === 12) nibble = 0x4
      if (i === 16) nibble = (nibble & 0x3) | 0x8
      s += HEX[nibble]
    }
    return s
  }

  // V8 reads the system clock for `new Date()` (no args) via the
  // internal binding, NOT through `Date.now()` — patching `Date.now`
  // alone leaves a residual ~30s of clock drift. Wrapping the
  // constructor is the only reliable hook. All other call shapes
  // (`new Date(timestamp)`, `Date.UTC`, `Date.parse`, `Date.now()`)
  // delegate to the real Date so existing behaviour is preserved.
  function PinnedDate(...args) {
    if (new.target) {
      return args.length === 0 ? new RealDate(fixedEpochMs) : new RealDate(...args)
    }
    return new RealDate(fixedEpochMs).toString()
  }
  PinnedDate.now       = () => fixedEpochMs
  PinnedDate.UTC       = RealDate.UTC
  PinnedDate.parse     = RealDate.parse
  PinnedDate.prototype = RealDate.prototype
  globalThis.Date      = PinnedDate

  try {
    return await fn()
  } finally {
    Math.random          = realRandom
    cryptoMod.randomUUID = realRandomUUID
    globalThis.Date      = RealDate
  }
}
