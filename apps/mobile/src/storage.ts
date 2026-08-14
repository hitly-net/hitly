export async function getItem(key: string): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export async function deleteItem(key: string): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // Ignore private-mode failures.
  }
}
