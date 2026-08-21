import type { DomainProvider, ProviderCheck } from '../types'
import { sleep } from '../sleep'

const TIMEOUT_MS = 10_000
const MAX_RETRIES = 2

// Known registry RDAP bases — skip the bootstrap lookup entirely.
// .io is absent from IANA's bootstrap registry (its RDAP was never
// formally registered there), so it is seeded manually.
const SEED_BASES: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  io: 'https://rdap.identitydigital.services/rdap/',
}

// IANA's authoritative RDAP bootstrap registry (RFC 9224).
const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/**
 * RDAP availability provider.
 *
 * RDAP semantics: HTTP 200 = registered, 404 = not found in the registry
 * (= available for registration). Unknown TLDs are resolved through IANA's
 * bootstrap registry, which maps each TLD to its authoritative RDAP server.
 */
export const rdapProvider: DomainProvider = {
  id: 'rdap',
  name: 'RDAP (IANA bootstrap)',
  tlds: '*',
  parallel: true,

  async check(domain: string): Promise<ProviderCheck> {
    const start = performance.now()
    try {
      const res = await query(domain)
      const ms = performance.now() - start
      if (res.status === 200) return { status: 'registered', httpStatus: 200, ms }
      if (res.status === 404) return { status: 'available', httpStatus: 404, ms }
      return { status: 'unknown', httpStatus: res.status, ms, note: `HTTP ${res.status}` }
    } catch (err) {
      return {
        status: 'unknown',
        ms: performance.now() - start,
        note: err instanceof RdapError ? err.message : `network error: ${errorMessage(err)}`,
      }
    }
  },
}

class RdapError extends Error {}

const bases = new Map<string, string>(Object.entries(SEED_BASES))
let ianaLoaded: Promise<void> | null = null

async function query(domain: string): Promise<Response> {
  const tld = tldOf(domain)
  let base = bases.get(tld)
  if (!base) {
    await loadIana()
    base = bases.get(tld)
  }
  if (!base) throw new RdapError(`no RDAP server registered for .${tld}`)
  return request(`${base}domain/${domain}`)
}

/** Fetch and index IANA's bootstrap registry once per process. */
function loadIana(): Promise<void> {
  ianaLoaded ??= (async () => {
    const res = await fetch(IANA_BOOTSTRAP_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new RdapError(`failed to load IANA bootstrap registry (HTTP ${res.status})`)
    const data = (await res.json()) as { services: [string[], string[]][] }
    for (const [tlds, urls] of data.services) {
      if (!urls[0]) continue
      for (const tld of tlds) {
        if (!bases.has(tld)) bases.set(tld.toLowerCase(), urls[0])
      }
    }
  })()
  return ianaLoaded
}

function tldOf(domain: string): string {
  return domain.slice(domain.lastIndexOf('.') + 1).toLowerCase()
}

async function request(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/rdap+json' },
  })
  // Back off on rate limiting / transient registry errors.
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleep(600 * 2 ** attempt)
    return request(url, attempt + 1)
  }
  return res
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
