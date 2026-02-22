/**
 * @iisl/api — Database Connection Pool
 * VALIDATION: [COMPILE-PENDING] — requires pg package and DATABASE_URL env
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

function normalizeDatabaseUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    // On some hosts, localhost resolves to ::1 and can hit a different local Postgres.
    // Use IPv4 loopback to target Docker port mapping consistently.
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
  } catch {
    // If URL parsing fails, let pg report the original connection error.
  }
  return raw;
}

export const pool = new Pool({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error", err);
});

/**
 * Execute a query with optional parameters.
 * Returns typed rows.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params);
}

/**
 * Execute a function within a transaction.
 * Rolls back automatically on error.
 *
 * IMPORTANT: All state mutations that must be atomic (e.g. approval status
 * transition + action_executions creation) must use this function.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a query with lock_version optimistic concurrency check.
 * Throws ConcurrencyConflictError if 0 rows were updated.
 */
export async function updateWithLockVersion(
  client: PoolClient,
  table: string,
  id: string,
  currentLockVersion: number,
  updates: Record<string, unknown>
): Promise<void> {
  const setEntries = Object.entries(updates);
  const setClauses = setEntries
    .map(([key], i) => `${key} = $${i + 3}`)
    .join(", ");
  const values = setEntries.map(([, v]) => v);

  const result = await client.query(
    `UPDATE ${table}
     SET ${setClauses}, lock_version = lock_version + 1, updated_at = now()
     WHERE id = $1 AND lock_version = $2`,
    [id, currentLockVersion, ...values]
  );

  if (result.rowCount === 0) {
    throw new ConcurrencyConflictError(
      `Concurrency conflict on ${table} id=${id} ` +
      `expected lock_version=${currentLockVersion}`
    );
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
