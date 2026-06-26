# @fuguejs/oracle

Oracle capability adapter for Fugue workflows. **Read-only** — `query` /
`queryOne` / `queryRaw` only, no write surface.

The driver runs in **thin mode** (pure-JS Oracle Net over TCP — no Instant
Client, no native addon, musl/alpine-safe) and is lazy-loaded via
`createRequire`, exactly as `@fuguejs/pg` loads `pg`.

## Installation

```bash
bun add @fuguejs/oracle oracledb zod
```

`oracledb` and `zod` are peer dependencies — `oracledb` provides the
connection pool, `zod` the schemas every `query`/`queryOne` call validates
against.

## Capability key: `oracle` (not `db`)

This package augments `@fuguejs/framework`'s `CapabilityRegistry` with the
`"oracle"` key — distinct from `@fuguejs/pg`'s `"db"`, so both adapters compose
in one host. Nodes declare `requires: ["oracle"]` and read `ctx.oracle`.

## Named binds (`:name`)

The one API divergence from `@fuguejs/pg`: binds are **named** and passed as a
`Record<string, unknown>` (`{ subId: "123" }`), bound to `:name` placeholders,
with `outFormat: OUT_FORMAT_OBJECT`. `@fuguejs/pg` uses positional `$1` /
`unknown[]`.

## Usage

### Register with the host

```ts
import { createOracleAdapter } from "@fuguejs/oracle";

const oracleHandle = createOracleAdapter({
  connectString: process.env.ORACLE_CONNECT_STRING!, // HOST:PORT/SERVICE
  user: process.env.ORACLE_USER!,
  password: process.env.ORACLE_PASSWORD!,
  poolMax: 8,
});

const sharedInfra = {
  // ... other infra ...
  capabilities: [oracleHandle],
};
```

### Use in a node

```ts
import { createFetchNode } from "@fuguejs/framework";
import { z } from "zod";

const PackageInfoRowSchema = z.object({
  optionKey: z.string(),
  standardPrice: z.string().nullable(),
  discountPrice: z.string().nullable(),
  packName: z.string().nullable(),
});

const fetchPackage = createFetchNode({
  id: "fetch-package",
  inputSchema: z.object({ subId: z.string() }),
  outputSchema: PackageInfoRowSchema.nullable(),
  requires: ["oracle"] as const,
  fetch: async (input, ctx) =>
    ctx.oracle.queryOne(
      PackageInfoRowSchema,
      "SELECT * FROM TABLE(GET_PACKAGE_INFO(:subId)) pkg",
      { subId: input.subId },
    ),
});
```

### Testing with the fake

```ts
import { createFakeOracleCapability } from "@fuguejs/oracle";

const fakeOracle = createFakeOracleCapability({
  "SELECT * FROM TABLE(GET_PACKAGE_INFO": [
    { optionKey: "X", standardPrice: "199", discountPrice: "99", packName: "X" },
  ],
});

const ctx = makeNodeContext({
  runId: "test-run",
  dagId: "test-dag",
  capabilities: { oracle: fakeOracle.client },
});
```

## API

### `OracleCapability`

| Method | Description |
|--------|-------------|
| `query<T>(schema, sql, binds?)` | Execute query, validate all rows against Zod schema |
| `queryOne<T>(schema, sql, binds?)` | Execute query, validate first row (or null) |
| `queryRaw(sql, binds?)` | Escape hatch: raw `unknown[]` rows, no validation — prefer `query` with a schema |

All methods return `Result<T, FrameworkError>` — no exceptions escape.

### `createOracleAdapter(config)`

Creates a `CapabilityHandle<"oracle">` with lifecycle management:
- `connect()`: validates connectivity with `SELECT 1 FROM DUAL`
- `close()`: closes the pool immediately (`pool.close(0)`, zero drain window)
- `healthCheck()`: `SELECT 1 FROM DUAL`, racing a 5s timeout (a hung pool reports unhealthy)

Config options: `connectString`, `user`, `password`, `poolMin` (default 0),
`poolMax` (default 4). Each query acquires/releases a pooled connection,
amortizing connection cost.

### `mapOracleError(error, sql)`

Classifies an `oracledb` error. Connection-class ORA- codes
(`ORA-03113/03114/12541/12170/12514`) → `transient` (retriable); everything
else → non-retriable `node-crash`. Oracle stacks multiple ORA codes in one
message, so classification prefers the structured `errorNum` and then scans
**all** `ORA-NNNNN` tokens — if any is connection-class the error is
`transient`. **Credentials are stripped** from every message: the DSN
`user/password@host` form and the `password=` / `pwd=` / `user=` / `uid=`
key-value forms are redacted to `***` before the message is surfaced or logged.

### `createFakeOracleCapability(routes)`

In-memory fake for testing. Routes are matched by exact SQL or longest prefix
match. Binds are not inspected.
