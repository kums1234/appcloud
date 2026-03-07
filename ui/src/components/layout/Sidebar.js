'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const nav = [
  { href: '/dashboard',     label: 'Dashboard',      icon: '▦' },
  { href: '/graph',         label: 'Graph View',     icon: '⬡' },
  { href: '/applications',  label: 'Applications',   icon: '◈' },
  { href: '/infra',         label: 'Infrastructure', icon: '◫' },
  { href: '/changes',       label: 'Changes',        icon: '⟳' },
  { href: '/discovery',  label: 'Discovery',    icon: '◎', accent: '#a78bfa' },
  { href: '/workflows',  label: 'Workflows',    icon: '⧖', accent: '#38bdf8' },
  { href: '/governance', label: 'Governance',    icon: '⚖', accent: '#a78bfa' },
  { divider: true },
  { href: '/integrations',  label: 'Integrations',   icon: '⟁', accent: '#2dd4bf' },
  { href: '/users',         label: 'Users',          icon: '◎', accent: '#a78bfa' },
]

export default function Sidebar() {
  const path = usePathname()
  return (
    <aside style={{
      position: 'fixed', left: 0, top: 0, height: '100vh', width: 220,
      background: '#04080f', borderRight: '1px solid #0f1f35',
      display: 'flex', flexDirection: 'column', zIndex: 40, fontFamily: 'monospace',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #0f1f35' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: '#22c55e22', border: '1.5px solid #22c55e55',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, color: '#22c55e', boxShadow: '0 0 12px #22c55e33',
          }}>⬡</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>AppCloud</div>
            <div style={{ fontSize: 9, color: '#1e3a5f', letterSpacing: '0.1em', marginTop: 1 }}>INFRA GRAPH</div>
          </div>
        </div>
      </div>

      <nav style={{ flex: 1, padding: '12px 10px', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav.map((item, i) => {
          if (item.divider) return (
            <div key={`div-${i}`} style={{ height: 1, background: '#0f1f35', margin: '8px 4px' }} />
          )
          const { href, label, icon, accent } = item
          const active = path === href || path.startsWith(href + '/')
          const color  = active ? (accent || '#22c55e') : '#334155'
          const bg     = active ? (accent ? accent + '18' : '#22c55e18') : 'transparent'
          const border = active ? (accent ? accent + '44' : '#22c55e44') : 'transparent'
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
                <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
                <span style={{ flex: 1 }}>{label}</span>
                {active && <div style={{ width: 5, height: 5, borderRadius: '50%',
                  background: color, boxShadow: `0 0 8px ${color}` }} />}
              </div>
            </Link>
          )
        })}
      </nav>

      <div style={{ padding: '14px 20px', borderTop: '1px solid #0f1f35' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%',
            background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
          <span style={{ fontSize: 9, color: '#1e3a5f', letterSpacing: '0.1em' }}>SYSTEM ONLINE · v1.0.0</span>
        </div>
      </div>
    </aside>
  )
}