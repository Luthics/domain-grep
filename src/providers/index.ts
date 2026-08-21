import type { DomainProvider } from '../types'
import { rdapProvider } from './rdap'
import { whoisProvider } from './whois'

/**
 * All available providers. To add a new data source, implement
 * `DomainProvider` (see src/types.ts) and append it here.
 */
export const PROVIDERS: readonly DomainProvider[] = [whoisProvider, rdapProvider]

/**
 * Pick the provider for a domain: an exact-TLD match always wins over a
 * `"*"` fallback. Returns null when nothing covers the TLD.
 */
export function route(domain: string): DomainProvider | null {
  const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase()
  return (
    PROVIDERS.find((p) => p.tlds !== '*' && p.tlds.includes(tld)) ??
    PROVIDERS.find((p) => p.tlds === '*') ??
    null
  )
}
