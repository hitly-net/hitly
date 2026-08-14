import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type MenuContextValue = {
  open: boolean
  show: () => void
  hide: () => void
}

const MenuContext = createContext<MenuContextValue | null>(null)

export function MenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const value = useMemo(
    () => ({
      open,
      show: () => setOpen(true),
      hide: () => setOpen(false),
    }),
    [open],
  )
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>
}

export function useMenu() {
  const value = useContext(MenuContext)
  if (!value) throw new Error('useMenu must be used within MenuProvider')
  return value
}
