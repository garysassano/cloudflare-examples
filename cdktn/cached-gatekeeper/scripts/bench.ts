/**
 * Measures what the cache is actually doing, without trusting a heuristic.
 *
 * The Worker stamps a fresh `originId` every time the credentialed entrypoint
 * runs. Counting distinct ids across N identical calls gives the exact number
 * that reached GitHub, so the hit rate here is measured rather than inferred.
 *
 *   node --experimental-strip-types scripts/bench.ts \
 *     --url http://localhost:8787 --path /v1/repos/cloudflare/cloudflare-os/issues -n 20
 */

interface Options {
  url: string;
  path: string;
  key: string;
  count: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
  };
  return {
    url: get("--url", "http://localhost:8787").replace(/\/+$/, ""),
    path: get("--path", "/v1/repos/cloudflare/cloudflare-os/issues"),
    key: get("--key", "demo-key"),
    count: Number(get("-n", "20")),
    concurrency: Number(get("--concurrency", "1")),
  };
}

interface Sample {
  ms: number;
  originId: string;
  status: string | null;
  rateLimit: number | null;
  ok: boolean;
  error?: string;
}

async function call(options: Options): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(`${options.url}${options.path}`, {
    headers: { authorization: `Bearer ${options.key}` },
  });
  const ms = performance.now() - started;
  const payload = (await response.json()) as {
    cache?: { originId: string; status: string | null; upstreamRateLimitRemaining: number | null };
    error?: string;
  };
  if (!response.ok || !payload.cache) {
    return {
      ms,
      originId: "",
      status: null,
      rateLimit: null,
      ok: false,
      error: payload.error ?? `HTTP ${response.status}`,
    };
  }
  return {
    ms,
    originId: payload.cache.originId,
    status: payload.cache.status,
    rateLimit: payload.cache.upstreamRateLimitRemaining,
    ok: true,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`${options.count} calls to ${options.url}${options.path}\n`);

  const samples: Sample[] = [];
  for (let issued = 0; issued < options.count; issued += options.concurrency) {
    const batch = Math.min(options.concurrency, options.count - issued);
    const results = await Promise.all(Array.from({ length: batch }, () => call(options)));
    samples.push(...results);
  }

  const failed = samples.filter((s) => !s.ok);
  if (failed.length > 0) {
    console.error(`${failed.length} call(s) failed: ${failed[0]?.error}`);
    if (failed.length === samples.length) process.exit(1);
  }

  const ok = samples.filter((s) => s.ok);
  const origins = new Set(ok.map((s) => s.originId));
  const hits = ok.length - origins.size;
  const originLatencies = new Map<string, number>();
  for (const sample of ok) {
    if (!originLatencies.has(sample.originId)) originLatencies.set(sample.originId, sample.ms);
  }
  const hitLatencies = ok
    .filter((s) => originLatencies.get(s.originId) !== s.ms)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  const missLatencies = [...originLatencies.values()].sort((a, b) => a - b);

  // Each origin fetch is exactly one upstream request, so this is the spend.
  // There is no need to infer it from the rate-limit headers, which a cache hit
  // replays from whenever the entry was stored.
  const spent = origins.size;
  const quotaLeft = ok.map((s) => s.rateLimit).filter((v): v is number => v !== null);

  const statuses = new Map<string, number>();
  for (const sample of ok) {
    const key = sample.status ?? "none";
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }

  console.log(`  calls           ${ok.length}`);
  console.log(`  reached GitHub  ${origins.size}`);
  console.log(`  cache hits      ${hits}  (${((hits / ok.length) * 100).toFixed(1)}%)`);
  console.log(`  upstream spend  ${spent} GitHub request(s)`);
  if (quotaLeft.length > 0) {
    console.log(`  quota left      ${Math.min(...quotaLeft)}`);
  }
  console.log(
    `  hit  p50/p95    ${percentile(hitLatencies, 50).toFixed(0)}ms / ${percentile(hitLatencies, 95).toFixed(0)}ms`,
  );
  console.log(
    `  miss p50/p95    ${percentile(missLatencies, 50).toFixed(0)}ms / ${percentile(missLatencies, 95).toFixed(0)}ms`,
  );
  console.log(`  cf-cache-status ${[...statuses].map(([name, n]) => `${name}=${n}`).join(" ")}`);

  if (origins.size === ok.length && ok.length > 1) {
    console.log(
      "\nEvery call reached GitHub. That is expected against `wrangler dev`, which does\n" +
        "not apply Workers Cache \u2014 point --url at the deployed Worker to measure it.",
    );
  }
}

await main();

export {};
