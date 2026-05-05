/**
 * Run 10 sequential summarize requests and report timing.
 * Usage: bun run apps/customer-summary/scripts/run-loop.ts
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const CUSTOMER_IDS = Array.from({ length: 10 }, (_, i) => `cust-${String(i + 1).padStart(3, "0")}`);

async function run() {
  console.log(`Running ${CUSTOMER_IDS.length} summarize requests against ${BASE_URL}\n`);

  const timings: { id: string; ms: number; ok: boolean }[] = [];

  for (const id of CUSTOMER_IDS) {
    const start = performance.now();
    const res = await fetch(`${BASE_URL}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: id }),
    });
    const ms = performance.now() - start;
    const ok = res.status === 200;
    timings.push({ id, ms, ok });

    const status = ok ? "OK" : `FAIL(${res.status})`;
    console.log(`  ${id}: ${ms.toFixed(0)}ms ${status}`);

    if (!ok) {
      const body = await res.text();
      console.log(`    -> ${body.slice(0, 200)}`);
    }
  }

  const successes = timings.filter((t) => t.ok);
  const avg = successes.reduce((s, t) => s + t.ms, 0) / (successes.length || 1);
  const p50 = percentile(successes.map((t) => t.ms), 0.5);
  const p95 = percentile(successes.map((t) => t.ms), 0.95);

  console.log(`\n--- Results ---`);
  console.log(`  Total:   ${CUSTOMER_IDS.length}`);
  console.log(`  Success: ${successes.length}`);
  console.log(`  Avg:     ${avg.toFixed(0)}ms`);
  console.log(`  P50:     ${p50.toFixed(0)}ms`);
  console.log(`  P95:     ${p95.toFixed(0)}ms`);
}

function percentile(sorted: number[], p: number): number {
  const s = [...sorted].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const idx = Math.ceil(p * s.length) - 1;
  return s[Math.max(0, idx)];
}

run().catch((e) => {
  console.error("Loop failed:", e);
  process.exit(1);
});
