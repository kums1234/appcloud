// utils/aws-regions.js
//
// Region-string validator. Used in two places:
//
//   1. integrations-cloud.js POST/PATCH — reject malformed regions on write
//      so they never make it into the cloud_accounts.config blob.
//   2. discovery.aws.js — defence-in-depth before the WHERE clause is
//      interpolated into the AWS Config Aggregator query language. The
//      aggregator query language is SQL-like, and a non-region string
//      injected here can manipulate the WHERE clause (e.g. `' OR 1=1; --`).
//      Hard validation upstream means the downstream interpolation is safe.
//
// We don't ship the full canonical list (AWS adds regions a few times a
// year) — instead we match the structural pattern that every AWS region
// follows: a two-letter geography, an optional `-gov` modifier, a locator
// word, and a digit. Passing this regex is necessary but not sufficient —
// a typoed region just won't match anything in Config and the scan will
// return zero rows, which is harmless.

// Two-letter geo, optional -gov, locator word(s), and a 1–3-digit suffix.
// Bounding the digit suffix prevents `us-east-1234567890`-style values from
// passing — they don't correspond to any real region and indicate either a
// typo or a probe.
const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?(?:-[a-z]+)+-\d{1,3}$/

export function isValidAwsRegion(region) {
  return typeof region === 'string'
      && region.length > 0
      && region.length <= 24
      && AWS_REGION_RE.test(region)
}

// Parse a comma-separated string OR an array of strings into a list of
// regions, throwing if any entry doesn't match the AWS pattern. Returns
// the cleaned list (trimmed, lowercased).
export function parseAndValidateRegions(input) {
  if (!input) return []
  const arr = Array.isArray(input)
    ? input
    : String(input).split(',')
  const cleaned = arr.map(r => String(r || '').trim().toLowerCase()).filter(Boolean)
  const bad = cleaned.filter(r => !isValidAwsRegion(r))
  if (bad.length) {
    throw new Error(`invalid AWS region(s): ${bad.join(', ')}`)
  }
  return cleaned
}
