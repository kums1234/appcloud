'use client'
import { useState, useEffect } from 'react'
import { useAuth } from '../../lib/auth-context'
import { useTheme, getT } from '../../lib/theme'

const mono = { fontFamily:'monospace' }

import { ThemeProvider } from '../../lib/theme'

function LoginInner() {
  const { login, register, user, loading } = useAuth()
  const { theme } = useTheme()
  const T = getT(theme)
  const [mode,     setMode]     = useState('login')   // 'login' | 'register'
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState(null)
  const [busy,     setBusy]     = useState(false)

  // Already logged in — redirect to dashboard
  useEffect(() => {
    if (!loading && user) window.location.href = '/dashboard'
  }, [user, loading])

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        await register(name, email, password)
      }
      window.location.href = '/dashboard'
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = {
    width: '100%', background: T.surface2,
    border: `1px solid ${T.border2}`, borderRadius: 8,
    padding: '10px 13px', color: T.text, fontSize: 13,
    fontFamily: 'monospace', outline: 'none',
    boxSizing: 'border-box', marginBottom: 12,
  }

  if (loading) return null

  const isLight = theme === 'light'
  return (
    <div style={{ minHeight:'100vh', background:T.bg, display:'flex',
      alignItems:'center', justifyContent:'center', fontFamily:'monospace' }}>
      <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}`}</style>

      <div style={{ width:'100%', maxWidth:380,
        animation:'fadeUp .3s cubic-bezier(.16,1,.3,1)' }}>

        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:10,
              background:`linear-gradient(135deg,${T.teal}33,${T.blue}22)`,
              border:`1.5px solid ${T.teal}55`,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:18, color:T.teal }}>⬡</div>
            <span style={{ ...mono, fontSize:18, fontWeight:800,
              color:T.text, letterSpacing:'-0.02em' }}>AppCloud</span>
          </div>
          <div style={{ ...mono, fontSize:10, color:T.dim, marginTop:6,
            letterSpacing:'0.1em' }}>INFRASTRUCTURE INTELLIGENCE PLATFORM</div>
        </div>

        {/* Card */}
        <div style={{ background:T.surface, border:`1px solid ${T.border}`,
          borderRadius:14, padding:'28px 28px 24px',
          boxShadow:'0 0 60px #00000055' }}>

          {/* Top shimmer */}
          <div style={{ position:'relative', overflow:'hidden',
            margin:'-28px -28px 24px', height:1 }}>
            <div style={{ height:1, background:
              `linear-gradient(90deg,transparent,${T.teal}66,transparent)` }}/>
          </div>

          {/* Mode tabs */}
          <div style={{ display:'flex', gap:4, marginBottom:22,
            background:T.surface2, borderRadius:8, padding:3 }}>
            {['login','register'].map(m => (
              <button key={m} onClick={() => { setMode(m); setError(null) }}
                style={{ ...mono, flex:1, padding:'7px 0', borderRadius:6,
                  border:'none', cursor:'pointer', fontSize:11, fontWeight:700,
                  transition:'all .15s',
                  background: mode===m ? T.teal+'22' : 'transparent',
                  color:       mode===m ? T.teal     : T.dim,
                  outline: mode===m ? `1px solid ${T.teal}44` : 'none' }}>
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          {/* Fields */}
          {mode === 'register' && (
            <div>
              <div style={{ ...mono, fontSize:9, color:T.muted,
                letterSpacing:'0.1em', fontWeight:700, marginBottom:5 }}>NAME</div>
              <input style={inputStyle} type="text" placeholder="Your name"
                value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}/>
            </div>
          )}

          <div>
            <div style={{ ...mono, fontSize:9, color:T.muted,
              letterSpacing:'0.1em', fontWeight:700, marginBottom:5 }}>EMAIL</div>
            <input style={inputStyle} type="email" placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}/>
          </div>

          <div>
            <div style={{ ...mono, fontSize:9, color:T.muted,
              letterSpacing:'0.1em', fontWeight:700, marginBottom:5 }}>PASSWORD</div>
            <input style={{ ...inputStyle, marginBottom: error ? 0 : 8 }}
              type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}/>
          </div>

          {/* Error */}
          {error && (
            <div style={{ ...mono, fontSize:11, color:T.red,
              background:T.red+'0a', border:`1px solid ${T.red}33`,
              borderRadius:7, padding:'8px 12px', margin:'10px 0' }}>
              ✗ {error}
            </div>
          )}

          {/* Submit */}
          <button onClick={submit} disabled={busy}
            style={{ ...mono, width:'100%', padding:'11px 0',
              background:`linear-gradient(135deg,${T.teal},${T.blue})`,
              border:'none', borderRadius:8, color:'#fff',
              fontSize:13, fontWeight:700, cursor:'pointer',
              marginTop:6, opacity: busy ? .7 : 1,
              boxShadow:`0 0 24px ${T.teal}33`,
              transition:'all .15s' }}>
            {busy
              ? mode === 'login' ? 'Signing in…' : 'Creating account…'
              : mode === 'login' ? 'Sign in'      : 'Create account'}
          </button>

          {mode === 'register' && (
            <div style={{ ...mono, fontSize:9, color:T.dim, textAlign:'center',
              marginTop:12, lineHeight:1.7 }}>
              The first account created becomes admin.
            </div>
          )}
        </div>

        <div style={{ ...mono, fontSize:9, color:T.muted, textAlign:'center',
          marginTop:16, lineHeight:1.7 }}>
          If <code style={{ color:T.dim }}>JWT_SECRET</code> is not set in the API,
          any password will work.
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <ThemeProvider>
      <LoginInner />
    </ThemeProvider>
  )
}