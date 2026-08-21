import type { DomainProvider, ProviderCheck } from '../types'

const TIMEOUT_MS = 10_000
const MAX_RETRIES = 4

const NOT_FOUND = /no matching record/i
const REGISTERED = /^domain name:/im
const RATE_LIMITED = /interval is too short|too many requests|rate limit/i

/**
 * Classic port-43 WHOIS provider for registries without public RDAP.
 *
 * Serial by design (`parallel: false`): registries like CNNIC reject bursts
 * with "Queried interval is too short". The scheduler enforces the
 * `minIntervalMs` gap; this provider only parses responses and retries on
 * transient rate-limit replies.
 *
 * Only an explicit not-found marker counts as "available"; anything
 * unrecognized stays "unknown" so the user verifies manually.
 */
export const whoisProvider: DomainProvider = {
  id: 'whois',
  name: 'Port-43 WHOIS (CNNIC & friends)',
  tlds: ['cn'],
  parallel: false,
  concurrency: 1,
  minIntervalMs: 1200,

  async check(domain: string): Promise<ProviderCheck> {
    const start = performance.now()
    try {
      const text = await queryWithRetry(`domain ${domain}\r\n`)
      const ms = performance.now() - start
      if (NOT_FOUND.test(text)) return { status: 'available', ms, note: 'via whois' }
      if (REGISTERED.test(text)) return { status: 'registered', ms, note: 'via whois' }
      return { status: 'unknown', ms, note: 'whois: verify manually' }
    } catch (err) {
      return {
        status: 'unknown',
        ms: performance.now() - start,
        note: `whois error: ${errorMessage(err)}`,
      }
    }
  },
}

/** WHOIS server per TLD — extend this map to cover more registries. */
const SERVERS: Record<string, string> = {
  cn: 'whois.cnnic.cn',
}

async function queryWithRetry(query: string, attempt = 0): Promise<string> {
  const server = SERVERS[tldOf(query)]
  const text = await whoisQuery(server, query)
  if (RATE_LIMITED.test(text) && attempt < MAX_RETRIES) {
    await Bun.sleep(1500 * (attempt + 1))
    return queryWithRetry(query, attempt + 1)
  }
  return text
}

function tldOf(query: string): string {
  // query looks like "domain example.tld\r\n"
  const name = query.trim().split(/\s+/)[1] ?? ''
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

/** One-shot port-43 WHOIS query: send request, read until the server closes. */
function whoisQuery(server: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let done = false
    const finish = (settle: () => void) => {
      if (!done) {
        done = true
        settle()
      }
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    timeout.addEventListener('abort', () => finish(() => reject(new Error('whois timeout'))))
    Bun.connect({
      hostname: server,
      port: 43,
      socket: {
        data(_socket, chunk) {
          out += chunk
        },
        end() {
          finish(() => resolve(out))
        },
        error(_socket, error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        },
      },
    })
      .then((socket) => socket.write(query))
      .catch((error) => finish(() => reject(error)))
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
