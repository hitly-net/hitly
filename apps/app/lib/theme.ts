export const THEME_COOKIE = 'hitly-theme'

export const THEMES = ['light', 'dark', 'system'] as const

export type Theme = (typeof THEMES)[number]

export function parseTheme(value: string | null | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function readThemeCookie() {
  if (typeof document === 'undefined') return 'system' as const
  const match = document.cookie.split('; ').find((part) => part.startsWith(`${THEME_COOKIE}=`))
  return parseTheme(match?.slice(THEME_COOKIE.length + 1))
}

export function writeThemeCookie(theme: Theme) {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`
}