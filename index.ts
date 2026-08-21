#!/usr/bin/env node
import { PROVIDERS, route } from './src/providers'
import { printReport, saveReport, summarize } from './src/report'
import { schedule } from './src/scheduler'
import { generateVariants, toDomains } from './src/variants'

const DEFAULT_TLDS = ['com', 'net', 'org', 'io', 'ai', 'dev', 'app', 'co']

interface CliOptions {
  words: string[]
  tlds: string[]
  prefixes: string[]
  suffixes: string[]
  includeOriginal: boolean
  concurrency: number
  showAll: boolean
  out?: string
  help: boolean
  listProviders: boolean
}

const USAGE = `domain-finder — find available domains via RDAP/WHOIS (no API key needed)

USAGE
  domain-finder <word>... [options]

ARGS
  <word>...              one or more keywords

OPTIONS
  --tlds <list>          comma-separated TLDs         (default: ${DEFAULT_TLDS.join(',')})
  --prefixes <list>      comma-separated prefixes     (e.g. my,get,try)
  --suffixes <list>      comma-separated suffixes     (e.g. hq,ly,lab)
  --no-original          exclude the bare keyword itself
  --concurrency <n>      parallel RDAP requests       (default: 20)
  --all                  also list registered domains
  --out <file>           write results to file (.json or .txt)
  --providers            list registered data providers and exit
  -h, --help             show this help

EXAMPLES
  domain-finder myapp
  domain-finder photo --tlds com,io,ai --prefixes my,get --suffixes hq,lab
  domain-finder blog news --tlds com,dev --all --out results.json

NOTES
  RDAP 404 means the domain is not in the registry (= registrable), but a few
  premium/reserved names may still require special pricing — those are worth a
  manual check at your registrar.
`

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    words: [],
    tlds: DEFAULT_TLDS,
    prefixes: [],
    suffixes: [],
    includeOriginal: true,
    concurrency: 20,
    showAll: false,
    help: false,
    listProviders: false,
  }
  const list = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--tlds': opts.tlds = list(argv[++i]); break
      case '--prefixes': opts.prefixes = list(argv[++i]); break
      case '--suffixes': opts.suffixes = list(argv[++i]); break
      case '--concurrency': opts.concurrency = Math.max(1, Number(argv[++i]) || 20); break
      case '--out': opts.out = argv[++i]; break
      case '--no-original': opts.includeOriginal = false; break
      case '--all': opts.showAll = true; break
      case '--providers': opts.listProviders = true; break
      case '-h': case '--help': opts.help = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
        opts.words.push(arg)
    }
  }
  return opts
}

function printProviders(): void {
  console.log('Registered providers:\n')
  for (const p of PROVIDERS) {
    const tlds =
      p.tlds === '*'
        ? 'fallback for TLDs not covered above — IANA bootstrap (~1200 TLDs) + manual seeds; unlisted TLDs return unknown'
        : p.tlds.map((t) => `.${t}`).join(', ')
    const mode = p.parallel ? `parallel ×${p.concurrency ?? 'global'}` : `serial ×${p.concurrency ?? 1}`
    const throttle = p.minIntervalMs ? `, ${p.minIntervalMs}ms between requests` : ''
    console.log(`  ${p.id.padEnd(8)} ${p.name}`)
    console.log(`  ${' '.repeat(8)} tlds: ${tlds}`)
    console.log(`  ${' '.repeat(8)} mode: ${mode}${throttle}\n`)
  }
}

async function main() {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n`)
    console.log(USAGE)
    process.exit(1)
  }

  if (opts.help) {
    console.log(USAGE)
    return
  }
  if (opts.listProviders) {
    printProviders()
    return
  }
  if (opts.words.length === 0) {
    console.error('error: provide at least one keyword\n')
    console.log(USAGE)
    process.exit(1)
  }
  if (opts.tlds.length === 0) {
    console.error('error: --tlds must not be empty')
    process.exit(1)
  }

  const variants = generateVariants(opts)
  if (variants.length === 0) {
    console.error(
      'error: no candidates to check — --no-original without any prefixes/suffixes leaves an empty list',
    )
    process.exit(1)
  }
  const domains = toDomains(variants, opts.tlds)

  console.log(`🔎 keywords : ${opts.words.join(', ')}`)
  console.log(
    `   variants (${variants.length}): ${variants.slice(0, 12).join(', ')}${variants.length > 12 ? ' …' : ''}`,
  )
  console.log(`   tlds (${opts.tlds.length}): ${opts.tlds.join(', ')}`)

  const lanes = new Map<string, number>()
  for (const d of domains) {
    const p = route(d)
    if (p) lanes.set(p.id, (lanes.get(p.id) ?? 0) + 1)
  }
  console.log(`   → ${domains.length} domains via ${[...lanes].map(([id, n]) => `${id}×${n}`).join(', ')}\n`)

  const start = performance.now()
  const results = await schedule(domains, {
    concurrency: opts.concurrency,
    total: domains.length,
    onProgress: (done, total, r) => {
      process.stdout.write(`\r  ⏳ ${done}/${total}  ${r.domain.slice(0, 40).padEnd(40)}\x1b[K`)
    },
  })
  const seconds = ((performance.now() - start) / 1000).toFixed(1)
  process.stdout.write(`\r  ✔ checked ${domains.length} domains in ${seconds}s\x1b[K\n`)

  printReport(results, { showAll: opts.showAll })

  if (opts.out) {
    await saveReport(results, opts.out)
    console.log(`💾 saved to ${opts.out}`)
  }

  const summary = summarize(results)
  if (summary.available === 0 && summary.unknown === 0) process.exit(2)
}

main()
