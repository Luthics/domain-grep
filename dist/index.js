#!/usr/bin/env node

// src/sleep.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// src/providers/rdap.ts
var TIMEOUT_MS = 1e4;
var MAX_RETRIES = 2;
var SEED_BASES = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
  io: "https://rdap.identitydigital.services/rdap/"
};
var IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
var rdapProvider = {
  id: "rdap",
  name: "RDAP (IANA bootstrap)",
  tlds: "*",
  parallel: true,
  async check(domain) {
    const start = performance.now();
    try {
      const res = await query(domain);
      const ms = performance.now() - start;
      if (res.status === 200)
        return { status: "registered", httpStatus: 200, ms };
      if (res.status === 404)
        return { status: "available", httpStatus: 404, ms };
      return { status: "unknown", httpStatus: res.status, ms, note: `HTTP ${res.status}` };
    } catch (err) {
      return {
        status: "unknown",
        ms: performance.now() - start,
        note: err instanceof RdapError ? err.message : `network error: ${errorMessage(err)}`
      };
    }
  }
};

class RdapError extends Error {
}
var bases = new Map(Object.entries(SEED_BASES));
var ianaLoaded = null;
async function query(domain) {
  const tld = tldOf(domain);
  let base = bases.get(tld);
  if (!base) {
    await loadIana();
    base = bases.get(tld);
  }
  if (!base)
    throw new RdapError(`no RDAP server registered for .${tld}`);
  return request(`${base}domain/${domain}`);
}
function loadIana() {
  ianaLoaded ??= (async () => {
    const res = await fetch(IANA_BOOTSTRAP_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok)
      throw new RdapError(`failed to load IANA bootstrap registry (HTTP ${res.status})`);
    const data = await res.json();
    for (const [tlds, urls] of data.services) {
      if (!urls[0])
        continue;
      for (const tld of tlds) {
        if (!bases.has(tld))
          bases.set(tld.toLowerCase(), urls[0]);
      }
    }
  })();
  return ianaLoaded;
}
function tldOf(domain) {
  return domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
}
async function request(url, attempt = 0) {
  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/rdap+json" }
  });
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleep(600 * 2 ** attempt);
    return request(url, attempt + 1);
  }
  return res;
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// src/providers/whois.ts
import { connect } from "node:net";
var TIMEOUT_MS2 = 1e4;
var MAX_RETRIES2 = 4;
var NOT_FOUND = /no matching record/i;
var REGISTERED = /^domain name:/im;
var RATE_LIMITED = /interval is too short|too many requests|rate limit/i;
var whoisProvider = {
  id: "whois",
  name: "Port-43 WHOIS (CNNIC & friends)",
  tlds: ["cn"],
  parallel: false,
  concurrency: 1,
  minIntervalMs: 1200,
  async check(domain) {
    const start = performance.now();
    try {
      const text = await queryWithRetry(`domain ${domain}\r
`);
      const ms = performance.now() - start;
      if (NOT_FOUND.test(text))
        return { status: "available", ms, note: "via whois" };
      if (REGISTERED.test(text))
        return { status: "registered", ms, note: "via whois" };
      return { status: "unknown", ms, note: "whois: verify manually" };
    } catch (err) {
      return {
        status: "unknown",
        ms: performance.now() - start,
        note: `whois error: ${errorMessage2(err)}`
      };
    }
  }
};
var SERVERS = {
  cn: "whois.cnnic.cn"
};
async function queryWithRetry(query2, attempt = 0) {
  const server = SERVERS[tldOf2(query2)];
  const text = await whoisQuery(server, query2);
  if (RATE_LIMITED.test(text) && attempt < MAX_RETRIES2) {
    await sleep(1500 * (attempt + 1));
    return queryWithRetry(query2, attempt + 1);
  }
  return text;
}
function tldOf2(query2) {
  const name = query2.trim().split(/\s+/)[1] ?? "";
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}
function whoisQuery(server, query2) {
  return new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    const finish = (settle) => {
      if (!done) {
        done = true;
        settle();
      }
    };
    const socket = connect({ host: server, port: 43 }, () => socket.write(query2));
    socket.setTimeout(TIMEOUT_MS2);
    socket.on("data", (chunk) => {
      out += chunk.toString();
    });
    socket.on("end", () => finish(() => resolve(out)));
    socket.on("timeout", () => {
      socket.destroy();
      finish(() => reject(new Error("whois timeout")));
    });
    socket.on("error", (err) => finish(() => reject(err)));
  });
}
function errorMessage2(err) {
  return err instanceof Error ? err.message : String(err);
}

// src/providers/index.ts
var PROVIDERS = [whoisProvider, rdapProvider];
function route(domain) {
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  return PROVIDERS.find((p) => p.tlds !== "*" && p.tlds.includes(tld)) ?? PROVIDERS.find((p) => p.tlds === "*") ?? null;
}

// src/report.ts
import { writeFile } from "node:fs/promises";
var green = (s) => `\x1B[32m${s}\x1B[0m`;
var red = (s) => `\x1B[31m${s}\x1B[0m`;
var yellow = (s) => `\x1B[33m${s}\x1B[0m`;
var dim = (s) => `\x1B[2m${s}\x1B[0m`;
var bold = (s) => `\x1B[1m${s}\x1B[0m`;
function grid(items, colorize) {
  const width = Math.max(...items.map((i) => i.length)) + 2;
  const termWidth = process.stdout.columns ?? 100;
  const cols = Math.max(1, Math.floor(termWidth / width));
  const lines = [];
  for (let i = 0;i < items.length; i += cols) {
    lines.push(items.slice(i, i + cols).map((it) => colorize(it.padEnd(width))).join("").trimEnd());
  }
  return lines.join(`
`);
}
function printReport(results, opts) {
  const by = (s) => results.filter((r) => r.status === s);
  const available = by("available").map((r) => r.domain).sort();
  const unknown = by("unknown");
  const registered = by("registered").map((r) => r.domain).sort();
  console.log("");
  console.log(bold(`✅ Available (${available.length})`));
  console.log(available.length ? grid(available, green) : dim("  (none)"));
  console.log("");
  console.log(bold(`⚠️  Unknown (${unknown.length}) — verify manually`));
  console.log(unknown.length ? unknown.map((r) => `  ${yellow(r.domain.padEnd(30))} ${dim(r.note ?? "")}`).join(`
`) : dim("  (none)"));
  console.log("");
  if (opts.showAll) {
    console.log(bold(`❌ Registered (${registered.length})`));
    console.log(registered.length ? grid(registered, (d) => dim(red(d))) : dim("  (none)"));
  } else {
    console.log(dim(`❌ Registered: ${registered.length} (hidden — use --all to list)`));
  }
  console.log("");
}
function summarize(results) {
  return {
    available: results.filter((r) => r.status === "available").length,
    registered: results.filter((r) => r.status === "registered").length,
    unknown: results.filter((r) => r.status === "unknown").length,
    total: results.length
  };
}
async function saveReport(results, file) {
  const sorted = [...results].sort((a, b) => a.domain.localeCompare(b.domain));
  const body = file.endsWith(".json") ? JSON.stringify({ checkedAt: new Date().toISOString(), summary: summarize(results), results: sorted }, null, 2) : ["available", "unknown", "registered"].map((status) => [
    `# ${status.toUpperCase()}`,
    ...sorted.filter((r) => r.status === status).map((r) => r.note ? `${r.domain}	${r.note}` : r.domain),
    ""
  ].join(`
`)).join(`
`);
  await writeFile(file, body);
}

// src/pool.ts
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length)
        break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/scheduler.ts
async function schedule(domains, opts) {
  const lanes = buildLanes(domains);
  let done = 0;
  const results = await Promise.all([...lanes.entries()].map((lane) => runLane(lane, opts, () => ++done)));
  return results.flat();
}
function buildLanes(domains) {
  const lanes = new Map;
  for (const domain of domains) {
    const provider = route(domain);
    if (!provider)
      continue;
    const lane = lanes.get(provider);
    if (lane)
      lane.push(domain);
    else
      lanes.set(provider, [domain]);
  }
  return lanes;
}
async function runLane(lane, opts, bumpDone) {
  const [provider, domains] = lane;
  const concurrency = provider.parallel ? provider.concurrency ?? opts.concurrency : provider.concurrency ?? 1;
  let lastRequestAt = 0;
  return mapPool(domains, concurrency, async (domain) => {
    if (provider.minIntervalMs) {
      const wait = provider.minIntervalMs - (Date.now() - lastRequestAt);
      if (wait > 0)
        await sleep(wait);
      lastRequestAt = Date.now();
    }
    const check = await provider.check(domain);
    const result = { domain, provider: provider.id, ...check };
    opts.onProgress?.(bumpDone(), opts.total ?? 0, result);
    return result;
  });
}

// src/variants.ts
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
function generateVariants({
  words,
  prefixes,
  suffixes,
  includeOriginal = true
}) {
  const out = new Set;
  for (const raw of words) {
    const word = normalize(raw);
    if (!word)
      continue;
    if (includeOriginal)
      out.add(word);
    for (const p of prefixes) {
      const withPrefix = `${normalize(p)}${word}`;
      if (withPrefix)
        out.add(withPrefix);
    }
    for (const s of suffixes) {
      const withSuffix = `${word}${normalize(s)}`;
      if (withSuffix !== word)
        out.add(withSuffix);
    }
    for (const p of prefixes) {
      for (const s of suffixes) {
        out.add(`${normalize(p)}${word}${normalize(s)}`);
      }
    }
  }
  return [...out];
}
function toDomains(variants, tlds) {
  const out = [];
  for (const v of variants) {
    for (const t of tlds) {
      out.push(`${v}.${t}`);
    }
  }
  return out;
}

// index.ts
var DEFAULT_TLDS = ["com", "net", "org", "io", "ai", "dev", "app", "co"];
var USAGE = `domain-finder — find available domains via RDAP/WHOIS (no API key needed)

USAGE
  domain-finder <word>... [options]

ARGS
  <word>...              one or more keywords

OPTIONS
  --tlds <list>          comma-separated TLDs         (default: ${DEFAULT_TLDS.join(",")})
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
`;
function parseArgs(argv) {
  const opts = {
    words: [],
    tlds: DEFAULT_TLDS,
    prefixes: [],
    suffixes: [],
    includeOriginal: true,
    concurrency: 20,
    showAll: false,
    help: false,
    listProviders: false
  };
  const list = (v) => (v ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--tlds":
        opts.tlds = list(argv[++i]);
        break;
      case "--prefixes":
        opts.prefixes = list(argv[++i]);
        break;
      case "--suffixes":
        opts.suffixes = list(argv[++i]);
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, Number(argv[++i]) || 20);
        break;
      case "--out":
        opts.out = argv[++i];
        break;
      case "--no-original":
        opts.includeOriginal = false;
        break;
      case "--all":
        opts.showAll = true;
        break;
      case "--providers":
        opts.listProviders = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("--"))
          throw new Error(`unknown option: ${arg}`);
        opts.words.push(arg);
    }
  }
  return opts;
}
function printProviders() {
  console.log(`Registered providers:
`);
  for (const p of PROVIDERS) {
    const tlds = p.tlds === "*" ? "fallback for TLDs not covered above — IANA bootstrap (~1200 TLDs) + manual seeds; unlisted TLDs return unknown" : p.tlds.map((t) => `.${t}`).join(", ");
    const mode = p.parallel ? `parallel ×${p.concurrency ?? "global"}` : `serial ×${p.concurrency ?? 1}`;
    const throttle = p.minIntervalMs ? `, ${p.minIntervalMs}ms between requests` : "";
    console.log(`  ${p.id.padEnd(8)} ${p.name}`);
    console.log(`  ${" ".repeat(8)} tlds: ${tlds}`);
    console.log(`  ${" ".repeat(8)} mode: ${mode}${throttle}
`);
  }
}
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}
`);
    console.log(USAGE);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.listProviders) {
    printProviders();
    return;
  }
  if (opts.words.length === 0) {
    console.error(`error: provide at least one keyword
`);
    console.log(USAGE);
    process.exit(1);
  }
  if (opts.tlds.length === 0) {
    console.error("error: --tlds must not be empty");
    process.exit(1);
  }
  const variants = generateVariants(opts);
  if (variants.length === 0) {
    console.error("error: no candidates to check — --no-original without any prefixes/suffixes leaves an empty list");
    process.exit(1);
  }
  const domains = toDomains(variants, opts.tlds);
  console.log(`\uD83D\uDD0E keywords : ${opts.words.join(", ")}`);
  console.log(`   variants (${variants.length}): ${variants.slice(0, 12).join(", ")}${variants.length > 12 ? " …" : ""}`);
  console.log(`   tlds (${opts.tlds.length}): ${opts.tlds.join(", ")}`);
  const lanes = new Map;
  for (const d of domains) {
    const p = route(d);
    if (p)
      lanes.set(p.id, (lanes.get(p.id) ?? 0) + 1);
  }
  console.log(`   → ${domains.length} domains via ${[...lanes].map(([id, n]) => `${id}×${n}`).join(", ")}
`);
  const start = performance.now();
  const results = await schedule(domains, {
    concurrency: opts.concurrency,
    total: domains.length,
    onProgress: (done, total, r) => {
      process.stdout.write(`\r  ⏳ ${done}/${total}  ${r.domain.slice(0, 40).padEnd(40)}\x1B[K`);
    }
  });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  process.stdout.write(`\r  ✔ checked ${domains.length} domains in ${seconds}s\x1B[K
`);
  printReport(results, { showAll: opts.showAll });
  if (opts.out) {
    await saveReport(results, opts.out);
    console.log(`\uD83D\uDCBE saved to ${opts.out}`);
  }
  const summary = summarize(results);
  if (summary.available === 0 && summary.unknown === 0)
    process.exit(2);
}
main();
