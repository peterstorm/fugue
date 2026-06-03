# @fugue/pg

PostgreSQL capability adapter for Fugue workflows.

## Installation

```bash
bun add @fugue/pg pg
```

## Usage

### Register with the host

```ts
import { createPgAdapter } from "@fugue/pg";

const pgHandle = createPgAdapter({
  connectionString: process.env.DATABASE_URL!,
  poolSize: 20,
  statementTimeoutMs: 15_000,
});

// Pass to SharedInfra capabilities:
const sharedInfra = {
  // ... other infra ...
  capabilities: [pgHandle],
};
```

### Use in a node

```ts
import { createFetchNode } from "@fugue/framework";
import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

const fetchUser = createFetchNode({
  id: "fetch-user",
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: UserSchema,
  requires: ["db"] as const,
  fetch: async (input, ctx) => {
    // ctx.db is typed as PgCapability — non-null, schema-validated
    return ctx.db.queryOne(
      UserSchema,
      "SELECT id, name, email FROM users WHERE id = $1",
      [input.userId],
    );
  },
});
```

### Testing with the fake

```ts
import { createFakePgCapability } from "@fugue/pg";

const fakeDb = createFakePgCapability({
  "SELECT * FROM users WHERE id": [
    { id: "1", name: "Alice", email: "alice@example.com" },
  ],
  "INSERT INTO orders": { rowCount: 1 },
});

// Use in tests via makeNodeContext:
const ctx = makeNodeContext({
  runId: "test-run",
  dagId: "test-dag",
  capabilities: { db: fakeDb.client },
});
```

## API

### `PgCapability`

| Method | Description |
|--------|-------------|
| `query<T>(schema, sql, params?)` | Execute query, validate all rows against Zod schema |
| `queryOne<T>(schema, sql, params?)` | Execute query, validate first row (or null) |
| `execute(sql, params?)` | Execute write, return `{ rowCount }` |
| `queryRaw(sql, params?)` | Execute query, return raw rows without validation |

All methods return `Result<T, FrameworkError>` — no exceptions escape.

### `createPgAdapter(config)`

Creates a `CapabilityHandle<"db">` with lifecycle management:
- `connect()`: validates connectivity with SELECT 1
- `close()`: drains the connection pool
- `healthCheck()`: SELECT 1 with 5s timeout

### `createFakePgCapability(routes)`

In-memory fake for testing. Routes are matched by exact SQL or longest prefix match.
