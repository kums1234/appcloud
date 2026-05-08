// Static-analysis invariant: every Cypher MERGE that creates a
// :CONNECTS_TO edge must populate the four required edge properties
// declared in CLAUDE.md: source, via, confidence, evidence. The
// graph-store conventions specify these — an edge without them is
// untraceable, can't be re-scored, and can't be invalidated by a
// future cleanup.
//
// This test scans every JS source file under api/src for Cypher
// template literals containing the MERGE shape and verifies the
// surrounding text references all four property names. It's a
// best-effort lint, not a full Cypher parser — but it catches the
// "I added a new edge writer and forgot evidence" case at PR review
// time, which is the actual failure mode we've seen.

import { describe, test, expect } from '@jest/globals'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_SRC   = path.resolve(__dirname, '..')

// Files that intentionally don't carry the contract. Each entry needs
// a comment justifying why; this list is itself a lint target.
const EXEMPT_FILES = new Set([
  // utils/audit-buffer.js — operates on Postgres audit_log, not Neo4j.
  'utils/audit-buffer.js',
])

// Required edge properties per CLAUDE.md. If a file's MERGE includes
// :CONNECTS_TO, every one of these tokens must appear within the
// containing template literal (we accept either snake_case or
// camelCase since the codebase has both — `discovered_at` /
// `last_seen` for properties, `confidence` / `evidence` as-is).
const REQUIRED_TOKENS = ['source', 'via', 'confidence', 'evidence']

async function listJsFiles(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      await listJsFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

// Best-effort extraction of the template literal containing a MERGE
// that produces a :CONNECTS_TO edge. We split the source on backticks
// and keep any chunk that mentions both "MERGE" and ":CONNECTS_TO".
// Multi-line template strings (which is what every Cypher block here
// uses) end up in a single chunk.
function extractConnectsToBlocks(source) {
  const chunks = source.split('`')
  // Even-indexed chunks are outside backticks, odd-indexed are inside.
  return chunks.filter((c, i) =>
    i % 2 === 1 &&                    // inside a template literal
    /MERGE\s*\([^)]*\)/.test(c) &&
    /:CONNECTS_TO/.test(c),
  )
}

describe(':CONNECTS_TO edge contract — every MERGE must set source/via/confidence/evidence', () => {
  test('static scan of api/src finds no contract violations', async () => {
    const files     = await listJsFiles(API_SRC)
    const offenders = []

    for (const file of files) {
      const rel = path.relative(API_SRC, file)
      if (EXEMPT_FILES.has(rel)) continue
      const src    = await fs.readFile(file, 'utf8')
      const blocks = extractConnectsToBlocks(src)
      for (const block of blocks) {
        const missing = REQUIRED_TOKENS.filter(t => !block.includes(t))
        if (missing.length > 0) {
          offenders.push({
            file: rel,
            missing,
            // First 100 chars for context; full block is recoverable
            // by grepping the file for ':CONNECTS_TO'.
            preview: block.replace(/\s+/g, ' ').slice(0, 100),
          })
        }
      }
    }

    if (offenders.length > 0) {
      const lines = offenders.map(o =>
        `  ${o.file}: missing [${o.missing.join(', ')}] — preview: "${o.preview}…"`,
      ).join('\n')
      throw new Error(
        `:CONNECTS_TO MERGE statements missing required properties:\n${lines}\n\n` +
        `Per CLAUDE.md, every :CONNECTS_TO edge must set source, via, confidence, ` +
        `and evidence on its MERGE statement. If you have a legitimate exception, ` +
        `add the file to EXEMPT_FILES with a comment explaining why.`,
      )
    }
  })

  test('every MERGE :CONNECTS_TO writer propagates the contract — sanity check on coverage', async () => {
    // Counterpart: the test above could pass vacuously if the codebase
    // had no CONNECTS_TO writers at all. Lock that we have at least
    // a few — the discovery scanners + auto-link + bootstrap.
    const files = await listJsFiles(API_SRC)
    let totalBlocks = 0
    for (const file of files) {
      const rel = path.relative(API_SRC, file)
      if (EXEMPT_FILES.has(rel)) continue
      const src = await fs.readFile(file, 'utf8')
      totalBlocks += extractConnectsToBlocks(src).length
    }
    expect(totalBlocks).toBeGreaterThan(5)   // sanity — multiple writers
  })
})
