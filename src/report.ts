import type { Availability, CheckResult } from './types'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

/** Render items as a column-aligned grid that fits the terminal width. */
function grid(items: string[], colorize: (s: string) => string): string {
  const width = Math.max(...items.map((i) => i.length)) + 2
  const termWidth = process.stdout.columns ?? 100
  const cols = Math.max(1, Math.floor(termWidth / width))
  const lines: string[] = []
  for (let i = 0; i < items.length; i += cols) {
    lines.push(items.slice(i, i + cols).map((it) => colorize(it.padEnd(width))).join('').trimEnd())
  }
  return lines.join('\n')
}

export function printReport(results: CheckResult[], opts: { showAll: boolean }): void {
  const by = (s: Availability) => results.filter((r) => r.status === s)
  const available = by('available').map((r) => r.domain).sort()
  const unknown = by('unknown')
  const registered = by('registered').map((r) => r.domain).sort()

  console.log('')
  console.log(bold(`✅ Available (${available.length})`))
  console.log(available.length ? grid(available, green) : dim('  (none)'))

  console.log('')
  console.log(bold(`⚠️  Unknown (${unknown.length}) — verify manually`))
  console.log(
    unknown.length
      ? unknown.map((r) => `  ${yellow(r.domain.padEnd(30))} ${dim(r.note ?? '')}`).join('\n')
      : dim('  (none)'),
  )

  console.log('')
  if (opts.showAll) {
    console.log(bold(`❌ Registered (${registered.length})`))
    console.log(registered.length ? grid(registered, (d) => dim(red(d))) : dim('  (none)'))
  } else {
    console.log(dim(`❌ Registered: ${registered.length} (hidden — use --all to list)`))
  }
  console.log('')
}

export interface ReportSummary {
  available: number
  registered: number
  unknown: number
  total: number
}

export function summarize(results: CheckResult[]): ReportSummary {
  return {
    available: results.filter((r) => r.status === 'available').length,
    registered: results.filter((r) => r.status === 'registered').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    total: results.length,
  }
}

/** Write results to a file. `.json` gets structured output, anything else plain text. */
export function saveReport(results: CheckResult[], file: string): void {
  const sorted = [...results].sort((a, b) => a.domain.localeCompare(b.domain))
  const body = file.endsWith('.json')
    ? JSON.stringify({ checkedAt: new Date().toISOString(), summary: summarize(results), results: sorted }, null, 2)
    : (['available', 'unknown', 'registered'] as const)
        .map((status) =>
          [
            `# ${status.toUpperCase()}`,
            ...sorted.filter((r) => r.status === status).map((r) =>
              r.note ? `${r.domain}\t${r.note}` : r.domain,
            ),
            '',
          ].join('\n'),
        )
        .join('\n')
  Bun.write(file, body)
}
