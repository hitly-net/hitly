export function isSignupEnabled(): boolean {
  const value = process.env.HITLY_SIGNUP_ENABLED
  if (!value || value === '1' || value === 'true') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return true
}
