export type Availability = 'available' | 'registered' | 'unknown'

export interface CheckResult {
  domain: string
  status: Availability
  /** id of the provider that produced this result */
  provider: string
  ms: number
  httpStatus?: number
  note?: string
}

/** What a provider returns for one domain (domain/provider fields are filled in by the scheduler). */
export type ProviderCheck = Omit<CheckResult, 'domain' | 'provider'>

/**
 * A domain availability data source.
 *
 * Contributing a new provider takes two steps:
 *   1. implement this interface in `src/providers/<your-provider>.ts`
 *   2. add it to the list in `src/providers/index.ts`
 *
 * The scheduler handles concurrency, rate limiting and TLD routing based on
 * the metadata below — a provider only implements `check()`.
 */
export interface DomainProvider {
  /** Unique slug, used in reports and CLI output. */
  id: string
  /** Human-readable name shown by `--providers`. */
  name: string
  /**
   * TLDs this provider can check (without the leading dot), e.g. `["cn"]`.
   * Use `"*"` to act as a fallback for TLDs no exact-match provider covers.
   * Note: `"*"` means "attempt any TLD", not "guaranteed support" — a
   * fallback provider may still return `unknown` for TLDs it cannot resolve
   * (e.g. the RDAP provider only covers what IANA's bootstrap registry lists,
   * plus its manual seeds).
   */
  tlds: string[] | '*'
  /**
   * Whether the upstream source tolerates high concurrency.
   * Parallel providers share the global worker pool; non-parallel ones get
   * their own serialized lane (see `concurrency` / `minIntervalMs`).
   */
  parallel: boolean
  /**
   * Max concurrent in-flight requests for this provider.
   * Defaults: `global --concurrency` when parallel, `1` when not.
   */
  concurrency?: number
  /**
   * Minimum gap between two requests to this source, in ms.
   * Use for registries that reject bursts (e.g. CNNIC's WHOIS).
   */
  minIntervalMs?: number
  /**
   * Check a single domain. Must never throw — return
   * `{ status: "unknown", note: "..." }` on any failure.
   */
  check(domain: string): Promise<ProviderCheck>
}
