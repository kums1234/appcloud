'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

// ── Palettes ──────────────────────────────────────────────────────────────────
export const THEMES = {
  dark: {
    bg:       '#04080f',
    surface:  '#080f1a',
    surface2: '#0d1626',
    surface3: '#111d2e',
    border:   '#0f1f35',
    border2:  '#1e293b',
    text:     '#f1f5f9',
    muted:    '#334155',
    dim:      '#64748b',
    // accent colours — same in both themes
    green:    '#22c55e',
    blue:     '#38bdf8',
    amber:    '#f59e0b',
    red:      '#f43f5e',
    purple:   '#a78bfa',
    teal:     '#2dd4bf',
    orange:   '#fb923c',
  },
  light: {
    bg:       '#f0f4f8',
    surface:  '#ffffff',
    surface2: '#f8fafc',
    surface3: '#f1f5f9',
    border:   '#e2e8f0',
    border2:  '#cbd5e1',
    text:     '#0f172a',
    muted:    '#94a3b8',
    dim:      '#64748b',
    // accent colours — same in both themes
    green:    '#16a34a',
    blue:     '#0284c7',
    amber:    '#d97706',
    red:      '#dc2626',
    purple:   '#7c3aed',
    teal:     '#0d9488',
    orange:   '#ea580c',
  },
}

// ── Context ───────────────────────────────────────────────────────────────────
const ThemeContext = createContext({ theme: 'dark', toggle: () => {} })

const STORAGE_KEY = 'appcloud_theme'

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState('dark')

  // Rehydrate from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark') setTheme(stored)
    } catch {}
  }, [])

  // Keep <html> data-theme attribute in sync for CSS custom props + scrollbar
  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-theme', theme)
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {}
  }, [theme])

  const toggle = useCallback(() =>
    setTheme(t => t === 'dark' ? 'light' : 'dark'), [])

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useTheme() {
  return useContext(ThemeContext)
}

// ── getT — returns the palette for the current theme ─────────────────────────
// Usage in pages:  const T = getT(useTheme().theme)
export function getT(theme) {
  return THEMES[theme] ?? THEMES.dark
}