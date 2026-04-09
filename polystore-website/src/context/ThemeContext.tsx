/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from "react"

type Theme = "dark" | "light" | "system"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

function getSystemTheme(): Exclude<Theme, "system"> {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function setFavicon(resolvedTheme: Exclude<Theme, "system">) {
  const favicon = document.querySelector<HTMLLinkElement>('link#favicon')
  if (!favicon) return
  favicon.href = resolvedTheme === "dark" ? "/favicon-dark-32.png" : "/favicon-light-32.png"
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  )

  useEffect(() => {
    const root = window.document.documentElement

    root.classList.remove("light", "dark")

    if (theme === "system") {
      const apply = () => {
        const systemTheme = getSystemTheme()
        root.classList.remove("light", "dark")
        root.classList.add(systemTheme)
        setFavicon(systemTheme)
      }

      apply()

      const mql = window.matchMedia("(prefers-color-scheme: dark)")
      const onChange = () => apply()
      const legacyMql = mql as unknown as {
        addEventListener?: (type: "change", listener: () => void) => void
        removeEventListener?: (type: "change", listener: () => void) => void
        addListener?: (listener: () => void) => void
        removeListener?: (listener: () => void) => void
      }

      if (legacyMql.addEventListener && legacyMql.removeEventListener) {
        legacyMql.addEventListener("change", onChange)
        return () => legacyMql.removeEventListener?.("change", onChange)
      }

      legacyMql.addListener?.(onChange)
      return () => legacyMql.removeListener?.(onChange)
    }

    root.classList.add(theme)
    setFavicon(theme)
  }, [theme])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}
