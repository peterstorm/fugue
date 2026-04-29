#!/usr/bin/env bun
/**
 * Quick smoke test: runs one request against localhost:3000 and prints the response.
 * Usage: bun run apps/customer-summary/scripts/smoke.ts
 */

const res = await fetch("http://localhost:3000/summarize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customer_id: "cust-001" }),
});

console.log("Status:", res.status);
console.log("Response:", JSON.stringify(await res.json(), null, 2));
