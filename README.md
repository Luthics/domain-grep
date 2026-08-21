# domain-finder

Find available domains by keyword with prefix/suffix combinations — powered by RDAP and WHOIS, no API key required.

Built for [Bun](https://bun.sh). Zero runtime dependencies.

## Install

Requires Bun ≥ 1.0. No dependencies to install:

```bash
bun install        # optional, installs dev tooling only
```

Or build a standalone binary (~57 MB, no Bun needed to run):

```bash
bun run compile
./domain-finder --help
```

## Usage

```bash
bun index.ts <keyword>... [options]
```

### Examples

```bash
# Check "myapp" across the default TLDs (com net org io ai dev app co)
bun index.ts myapp

# Cartesian product: myphoto / getphoto / photohq / getphotolab …
bun index.ts photo --tlds com,io,ai --prefixes my,get --suffixes hq,lab

# Multiple keywords at once, list registered domains too, save as JSON
bun index.ts blog news --tlds com,dev --all --out results.json
```

### Options

| Option | Description | Default |
|---|---|---|
| `--tlds <list>` | comma-separated TLDs | `com,net,org,io,ai,dev,app,co` |
| `--prefixes <list>` | comma-separated prefixes | none |
| `--suffixes <list>` | comma-separated suffixes | none |
| `--no-original` | exclude the bare keyword itself | included |
| `--concurrency <n>` | parallel RDAP requests | 20 |
| `--all` | also list registered domains | available/unknown only |
| `--out <file>` | write results to file (`.json` structured, anything else plain text) | not saved |
| `--providers` | list registered data providers and exit | — |

Variant generation: for each keyword, `word`, `{prefix}word`, `word{suffix}` and `{prefix}word{suffix}` are generated, deduplicated, then crossed with the TLD list.

## Architecture

Detection is abstracted into **providers** — one module per data source, each declaring which TLDs it covers and how it tolerates concurrency. The scheduler handles routing, pooling and rate limiting.

| provider | TLD coverage | concurrency model | notes |
|---|---|---|---|
| `rdap` | fallback: ~1200 TLDs listed in IANA's bootstrap registry + manual seeds (`.com`/`.net`/`.io`); unlisted TLDs return unknown | parallel, shared global pool | HTTP 404 = available, 200 = registered |
| `whois` | `.cn` (exact match wins) | serial ×1, 1.2 s between requests | CNNIC has no public RDAP; classic port-43 WHOIS, only an explicit not-found marker counts |

Run `--providers` to see everything currently registered.

### Add your own provider

Two steps — the scheduler takes care of concurrency, throttling and TLD routing. You only implement `check()`:

**1. Create `src/providers/<your-provider>.ts`:**

```ts
import type { DomainProvider, ProviderCheck } from '../types'

export const myProvider: DomainProvider = {
  id: 'my-provider',
  name: 'My Data Source',
  tlds: ['example'],        // covers .example only; or '*' as a fallback
  parallel: true,           // does the upstream tolerate high concurrency?
  // concurrency: 10,       // optional; default: global when parallel, 1 when not
  // minIntervalMs: 500,    // optional; minimum gap between requests

  async check(domain: string): Promise<ProviderCheck> {
    // never throw — return status "unknown" on failure
    try {
      const res = await fetch(`https://api.example.com/domain/${domain}`)
      if (res.status === 404) return { status: 'available', ms: 0, note: 'example api' }
      if (res.status === 200) return { status: 'registered', ms: 0, note: 'example api' }
      return { status: 'unknown', ms: 0, note: `HTTP ${res.status}` }
    } catch (err) {
      return { status: 'unknown', ms: 0, note: String(err) }
    }
  },
}
```

**2. Register it in `src/providers/index.ts`:**

```ts
import { myProvider } from './my-provider'
export const PROVIDERS = [whoisProvider, myProvider, rdapProvider]
```

An exact-TLD provider always wins over a `"*"` fallback, so adding a dedicated `.cn` source automatically takes over `.cn` queries while everything else stays untouched.

## Notes

- RDAP 404 means "not in the registry" (= registrable), but a few premium/reserved names may still require special pricing — worth a manual check at your registrar before you buy.
- Keep concurrency moderate per registry (the default of 20 is safe); aggressive bursts may get your IP temporarily rate-limited.
- Second-level TLDs like `.co.uk` are not resolved specially — RDAP/WHOIS is queried by the rightmost label.

## Exit codes

- `0` — available or unknown results found
- `1` — invalid arguments
- `2` — every domain registered (handy in scripts)

## AI Disclosure

This project was developed with AI assistance. The implementation was primarily written by [Claude](https://claude.com/claude-code) (Anthropic), working under human direction: the product concept, provider architecture, design decisions and testing against live registries were driven and reviewed by the maintainer, who takes responsibility for every line that ships.

## License

[MIT](LICENSE)
