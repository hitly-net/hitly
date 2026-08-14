export function affectedRows(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result
  if (!header || typeof header !== 'object') return 0
  const record = header as { affectedRows?: unknown; rowsAffected?: unknown }
  return Number(record.affectedRows ?? record.rowsAffected ?? 0)
}
