export function affectedRows(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result
  if (!header || typeof header !== 'object') return 0
  // MySQL-style headers carry affectedRows/rowsAffected; the node-postgres
  // driver returns a pg Result whose count lives on `rowCount`. Reading only
  // the MySQL names made every Postgres UPDATE look like a no-op (0), which
  // silently zeroed the expire sweep's count and blocked scheduler claims.
  const record = header as { affectedRows?: unknown; rowsAffected?: unknown; rowCount?: unknown }
  const count = Number(record.affectedRows ?? record.rowsAffected ?? record.rowCount ?? 0)
  return Number.isFinite(count) && count > 0 ? count : 0
}
