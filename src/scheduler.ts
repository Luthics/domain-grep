import { mapPool } from './pool'
import { route } from './providers'
import type { CheckResult, DomainProvider } from './types'

export interface ScheduleOptions {
  /** Global worker-pool size for parallel providers. */
  concurrency: number
  /** Total number of domains, for progress reporting. */
  total?: number
  onProgress?: (done: number, total: number, result: CheckResult) => void
}

/**
 * Route every domain to its provider, then run one lane per provider:
 * parallel providers share the global pool, rate-limited ones get a
 * serialized, throttled lane of their own. Lanes run concurrently.
 */
export async function schedule(domains: string[], opts: ScheduleOptions): Promise<CheckResult[]> {
  const lanes = buildLanes(domains)
  let done = 0
  const results = await Promise.all(
    [...lanes.entries()].map((lane) => runLane(lane, opts, () => ++done)),
  )
  return results.flat()
}

function buildLanes(domains: string[]): Map<DomainProvider, string[]> {
  const lanes = new Map<DomainProvider, string[]>()
  for (const domain of domains) {
    const provider = route(domain)
    if (!provider) continue
    const lane = lanes.get(provider)
    if (lane) lane.push(domain)
    else lanes.set(provider, [domain])
  }
  return lanes
}

async function runLane(
  lane: [DomainProvider, string[]],
  opts: ScheduleOptions,
  bumpDone: () => number,
): Promise<CheckResult[]> {
  const [provider, domains] = lane
  const concurrency = provider.parallel
    ? (provider.concurrency ?? opts.concurrency)
    : (provider.concurrency ?? 1)
  let lastRequestAt = 0

  return mapPool(domains, concurrency, async (domain): Promise<CheckResult> => {
    if (provider.minIntervalMs) {
      const wait = provider.minIntervalMs - (Date.now() - lastRequestAt)
      if (wait > 0) await Bun.sleep(wait)
      lastRequestAt = Date.now()
    }
    const check = await provider.check(domain)
    const result: CheckResult = { domain, provider: provider.id, ...check }
    opts.onProgress?.(bumpDone(), opts.total ?? 0, result)
    return result
  })
}
