'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const AuthContext = createContext(null)

const TOKEN_KEY = 'appcloud_token'

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(null)
  const [token,   setToken]   = useState(null)
  const [loading, setLoading] = useState(true)  // true until we've checked storage

  // Rehydrate from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(TOKEN_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        setToken(parsed.token)
        setUser(parsed.user)
      }
    } catch {}
    setLoading(false)
  }, [])

  const login = useCallback(async (email, password) => {
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Login failed')

    setToken(data.token)
    setUser(data.user)
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, user: data.user }))
    } catch {}
    return data.user
  }, [])

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setToken(null)
    setUser(null)
    try { sessionStorage.removeItem(TOKEN_KEY) } catch {}
    window.location.href = '/login'
  }, [])

  const register = useCallback(async (name, email, password) => {
    const res = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Registration failed')

    setToken(data.token)
    setUser(data.user)
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: data.token, user: data.user }))
    } catch {}
    return data.user
  }, [])

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}