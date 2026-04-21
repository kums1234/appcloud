'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme, getT } from '@/lib/theme'

const RAIL_W = 56

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

export { RAIL_W }

export default function NavRail() {
  const path = usePathname()
  const { theme, toggle } = useTheme()
  const T = getT(theme)
  const isLight = theme === 'light'

  return (
    <aside style={{
      position: 'fixed', left: 0, top: 0, height: '100vh', width: RAIL_W,
      background: T.surface, borderRight: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      zIndex: 50, fontFamily: 'monospace',
      transition: 'background 0.2s ease, border-color 0.2s ease',
    }}>
      {/* Logo */}
      <div style={{
        width: '100%', padding: '16px 0 12px',
        borderBottom: `1px solid ${T.border}`,
        display: 'flex', justifyContent: 'center',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `${T.green}22`, border: `1.5px solid ${T.green}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, color: T.green, boxShadow: `0 0 12px ${T.green}33`,
        }}>⬡</div>
      </div>

      {/* Nav */}
      <nav style={{
        flex: 1, padding: '10px 0', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        width: '100%',
      }}>
        {nav.map((item, i) => {
          if (item.divider) return (
            <div key={`div-${i}`} style={{
              height: 1, background: T.border, margin: '6px 8px', width: 'calc(100% - 16px)',
            }} />
          )
          const { href, label, icon, accent } = item
          const active = path === href || path.startsWith(href + '/')
          const accentBase = accent || T.green
          const color = active ? accentBase : T.muted
          const bg = active ? `${accentBase}18` : 'transparent'
          const border = active ? `${accentBase}44` : 'transparent'

          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }} title={label}>
              <div style={{
                position: 'relative',
                width: 40, height: 40,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8,
                border: `1px solid ${border}`,
                background: bg, color,
                fontSize: 16,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}>
                {icon}
                {active && <div style={{
                  position: 'absolute', right: -4, top: '50%', transform: 'translateY(-50%)',
                  width: 4, height: 4, borderRadius: '50%',
                  background: accentBase, boxShadow: `0 0 8px ${accentBase}`,
                }} />}
              </div>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div style={{
        padding: '10px 0', borderTop: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        width: '100%',
      }}>
        {/* Theme toggle */}
        <button onClick={toggle}
          title={`Switch to ${isLight ? 'dark' : 'light'} mode`}
          style={{
            width: 36, height: 36, borderRadius: 8,
            background: T.surface2, border: `1px solid ${T.border}`,
            cursor: 'pointer', transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, color: T.dim, fontFamily: 'monospace',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = `${T.teal}55`
            e.currentTarget.style.background = `${T.teal}10`
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = T.border
            e.currentTarget.style.background = T.surface2
          }}>
          {isLight ? '☽' : '☀'}
        </button>

        {/* Status dot */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 4 }}>
          <div style={{
            width: 5, height: 5, borderRadius: '50%',
            background: T.green, boxShadow: `0 0 6px ${T.green}`,
          }} />
        </div>
      </div>
    </aside>
  )
}
