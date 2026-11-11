/** Always disable Next.js and Turbo CLI telemetry. HITLY_TELEMETRY does not affect this. */
export function applyCliTelemetryDisabled(env = process.env) {
  env.NEXT_TELEMETRY_DISABLED = '1'
  env.TURBO_TELEMETRY_DISABLED = '1'
}
