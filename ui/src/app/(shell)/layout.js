'use client'
import { useEffect } from 'react'
import Sidebar from '@/components/layout/Sidebar'
import { useAuth } from '@/lib/auth-context'

const T = {
  bg:'#04080f', surface:'#080f1a', surface2:'#0d1626',
  border:'#0f1f35', text:'#f1f5f9', muted:'#334155', dim:'#64748b',
  teal:'#2dd4bf', red:'#f43f5e', amber:'#f59e0b',
}
const mono = { fontFamily:'monospace' }

const ROLE_COLOR = {
  admin:  { color:'#a78bfa', bg:'#a78bfa18', border:'#a78bfa33' },
  user:   { color:'#38bdf8', bg:'#38bdf818', border:'#38bdf833' },
  viewer: { color:'#64748b', bg:'#64748b18', border:'#64748b33' },
}

function AuthGuard({ children }) {
  const { user, loading } = useAuth()
  useEffect(() => {
    if (!loading && !user) window.location.href = '/login'
  }, [user, loading])
  if (loading || !user) return null
  return children
}

function TopBar() {
  const { user, logout } = useAuth()
  if (!user) return null
  const role     = user.role || 'user'
  const rc       = ROLE_COLOR[role] || ROLE_COLOR.user
  const initials = (user.name || user.email || '?')
    .split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase()
  return (
    <div style={{
      position:'fixed', top:0, left:220, right:0, height:48, zIndex:40,
      background:`${T.bg}ee`, backdropFilter:'blur(8px)',
      borderBottom:`1px solid ${T.border}`,
      display:'flex', alignItems:'center',
      justifyContent:'flex-end', padding:'0 24px', gap:12,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:28, height:28, borderRadius:7,
          background:`linear-gradient(135deg,${T.teal}33,${T.teal}11)`,
          border:`1px solid ${T.teal}44`,
          display:'flex', alignItems:'center', justifyContent:'center',
          ...mono, fontSize:10, fontWeight:700, color:T.teal }}>
          {initials}
        </div>
        <div>
          <div style={{ ...mono, fontSize:11, fontWeight:600, color:T.text, lineHeight:1 }}>
            {user.name || user.email}
          </div>
          <div style={{ ...mono, fontSize:8, color:T.dim, marginTop:1 }}>{user.email}</div>
        </div>
        <span style={{ ...mono, fontSize:8, fontWeight:700,
          color:rc.color, background:rc.bg, border:`1px solid ${rc.border}`,
          borderRadius:3, padding:'1px 6px', letterSpacing:'0.06em',
          textTransform:'uppercase' }}>{role}</span>
      </div>
      <div style={{ width:1, height:20, background:T.border }}/>
      <button onClick={logout}
        style={{ ...mono, fontSize:10, color:T.dim,
          background:'transparent', border:`1px solid ${T.border}`,
          borderRadius:6, padding:'5px 11px', cursor:'pointer' }}
        onMouseEnter={e => { e.currentTarget.style.color=T.red; e.currentTarget.style.borderColor=T.red+'44' }}
        onMouseLeave={e => { e.currentTarget.style.color=T.dim; e.currentTarget.style.borderColor=T.border }}>
        Sign out
      </button>
    </div>
  )
}

function ShellInner({ children }) {
  return (
    <AuthGuard>
      <div style={{ display:'flex', minHeight:'100vh', background:T.bg }}>
        <Sidebar/>
        <div style={{ marginLeft:220, flex:1, minHeight:'100vh', display:'flex', flexDirection:'column' }}>
          <TopBar/>
          <main style={{ flex:1, overflowX:'hidden', marginTop:48 }}>
            {children}
          </main>
        </div>
      </div>
    </AuthGuard>
  )
}

export default function ShellLayout({ children }) {
  return (
    <ShellInner>{children}</ShellInner>
  )
}