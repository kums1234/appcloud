'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme, getT } from '@/lib/theme'

const nav = [
  { href: '/dashboard',    label: 'Dashboard',      icon: '▦' },
  { href: '/graph',        label: 'Graph View',     icon: '⬡' },
  { href: '/applications', label: 'Applications',   icon: '◈' },
  { href: '/infra',        label: 'Infrastructure', icon: '◫' },
  { href: '/changes',      label: 'Changes',        icon: '⟳' },
  { href: '/discovery',    label: 'Discovery',      icon: '◎', accent: '#a78bfa' },
  { href: '/workflows',    label: 'Workflows',      icon: '⧖', accent: '#38bdf8' },
  { href: '/governance',   label: 'Governance',     icon: '⚖', accent: '#a78bfa' },
  { divider: true },
  { href: '/integrations', label: 'Integrations',   icon: '⟁', accent: '#2dd4bf' },
  { href: '/users',        label: 'Users',          icon: '◎', accent: '#a78bfa' },
]

export default function Sidebar() {
  const path            = usePathname()
  const { theme, toggle } = useTheme()
  const T               = getT(theme)
  const isLight         = theme === 'light'

  return (
    <aside style={{
      position: 'fixed', left: 0, top: 0, height: '100vh', width: 220,
      background: T.surface, borderRight: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', zIndex: 50, fontFamily: 'monospace',
      transition: 'background 0.2s ease, border-color 0.2s ease',
    }}>
      {/* Logo */}
      <div style={{ padding: '20px 20px 16px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: `${T.green}22`, border: `1.5px solid ${T.green}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, color: T.green, boxShadow: `0 0 12px ${T.green}33`,
          }}>⬡</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: T.text,
              letterSpacing: '-0.02em' }}>AppCloud</div>
            <div style={{ fontSize: 9, color: T.muted, letterSpacing: '0.1em', marginTop: 1 }}>
              INFRA GRAPH
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav.map((item, i) => {
          if (item.divider) return (
            <div key={`div-${i}`} style={{ height: 1, background: T.border,
              margin: '8px 4px' }} />
          )
          const { href, label, icon, accent } = item
          const active     = path === href || path.startsWith(href + '/')
          const accentBase = accent || T.green
          const color      = active ? accentBase : T.muted
          const bg         = active ? `${accentBase}18`   : 'transparent'
          const border     = active ? `${accentBase}44`   : 'transparent'
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 12px', borderRadius: 8,
                border: `1px solid ${border}`,
                background: bg, color,
                fontSize: 12, fontWeight: active ? 700 : 400,
                cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '0.01em',
              }}>
                <span style={{ fontSize: 13, width: 16, textAlign: 'center',
                  flexShrink: 0 }}>{icon}</span>
                <span style={{ flex: 1 }}>{label}</span>
                {active && <div style={{ width: 5, height: 5, borderRadius: '50%',
                  background: accentBase, boxShadow: `0 0 8px ${accentBase}` }} />}
              </div>
            </Link>
          )
        })}
      </nav>

      {/* Footer — theme toggle + status */}
      <div style={{ padding: '12px 14px', borderTop: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Theme toggle button */}
        <button onClick={toggle}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', padding: '7px 10px', borderRadius: 7,
            background: T.surface2, border: `1px solid ${T.border}`,
            cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'monospace',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = `${T.teal}55`; e.currentTarget.style.background = `${T.teal}10` }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border;       e.currentTarget.style.background = T.surface2 }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>{isLight ? '☽' : '☀'}</span>
          <span style={{ fontSize: 10, color: T.dim, fontWeight: 600 }}>
            {isLight ? 'Dark mode' : 'Light mode'}
          </span>
          {/* Track */}
          <div style={{ marginLeft: 'auto', width: 28, height: 15, borderRadius: 8,
            background: isLight ? T.teal : T.border2,
            border: `1px solid ${isLight ? T.teal : T.border}`,
            position: 'relative', transition: 'background 0.2s' }}>
            <div style={{
              position: 'absolute', top: 2,
              left: isLight ? 14 : 2,
              width: 9, height: 9, borderRadius: '50%',
              background: isLight ? '#fff' : T.dim,
              transition: 'left 0.2s',
            }}/>
          </div>
        </button>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%',
            background: T.green, boxShadow: `0 0 6px ${T.green}` }} />
          <span style={{ fontSize: 9, color: T.muted, letterSpacing: '0.1em' }}>
            SYSTEM ONLINE · v1.0.0
          </span>
        </div>
      </div>
    </aside>
  )
}