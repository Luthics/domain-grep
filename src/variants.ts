/** Keep only characters valid in a domain name, lowercased. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '')
}

export interface VariantOptions {
  words: string[]
  prefixes: string[]
  suffixes: string[]
  /** Include the bare keyword itself (default true). */
  includeOriginal?: boolean
}

/**
 * Build unique SLD candidates from words × prefixes × suffixes:
 * word, {prefix}word, word{suffix}, {prefix}word{suffix}.
 */
export function generateVariants({
  words,
  prefixes,
  suffixes,
  includeOriginal = true,
}: VariantOptions): string[] {
  const out = new Set<string>()
  for (const raw of words) {
    const word = normalize(raw)
    if (!word) continue
    if (includeOriginal) out.add(word)
    for (const p of prefixes) {
      const withPrefix = `${normalize(p)}${word}`
      if (withPrefix) out.add(withPrefix)
    }
    for (const s of suffixes) {
      const withSuffix = `${word}${normalize(s)}`
      if (withSuffix !== word) out.add(withSuffix)
    }
    for (const p of prefixes) {
      for (const s of suffixes) {
        out.add(`${normalize(p)}${word}${normalize(s)}`)
      }
    }
  }
  return [...out]
}

/** Cross variants with TLDs into full domain names. */
export function toDomains(variants: string[], tlds: string[]): string[] {
  const out: string[] = []
  for (const v of variants) {
    for (const t of tlds) {
      out.push(`${v}.${t}`)
    }
  }
  return out
}
