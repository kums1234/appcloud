'use client'
import clsx from 'clsx'

// Stat card
export function StatCard({ label, value, sub, accent, icon: Icon }) {
  return (
    <div className="card flex items-start justify-between gap-4">
      <div>
        <p className="label">{label}</p>
        <p className={clsx('text-3xl font-display font-bold mt-1', accent || 'text-white')}>{value}</p>
        {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
      </div>
      {Icon && (
        <div className="w-10 h-10 rounded-lg bg-surface-2 border border-border flex items-center justify-center shrink-0">
          <Icon size={18} className={accent || 'text-accent'} />
        </div>
      )}
    </div>
  )
}

// Tier badge
export function TierBadge({ tier }) {
  const map = { 1: ['danger', 'CRITICAL'], 2: ['warning', 'HIGH'], 3: ['success', 'MEDIUM'], 4: ['muted', 'LOW'] }
  const [color, label] = map[tier] || ['muted', 'UNKNOWN']
  return (
    <span className={clsx('badge', `bg-${color}/10 text-${color} border border-${color}/20`)}>
      T{tier} {label}
    </span>
  )
}

// Status badge
export function StatusBadge({ status }) {
  const map = {
    approved: 'bg-success/10 text-success border-success/20',
    draft: 'bg-warning/10 text-warning border-warning/20',
    rejected: 'bg-danger/10 text-danger border-danger/20',
    production: 'bg-accent/10 text-accent border-accent/20',
    development: 'bg-muted/10 text-muted border-muted/20',
  }
  return (
    <span className={clsx('badge border', map[status] || 'bg-surface-2 text-muted border-border')}>
      {status}
    </span>
  )
}

// Provider badge
export function ProviderBadge({ provider }) {
  const map = {
    aws: 'bg-warning/10 text-warning border-warning/20',
    azure: 'bg-accent/10 text-accent border-accent/20',
    gcp: 'bg-success/10 text-success border-success/20',
    onprem: 'bg-muted/10 text-muted border-muted/20',
  }
  return (
    <span className={clsx('badge border', map[provider] || 'bg-surface-2 text-muted border-border')}>
      {provider}
    </span>
  )
}

// Component type badge
export function TypeBadge({ type }) {
  const map = {
    API: 'bg-accent/10 text-accent border-accent/20',
    DB: 'bg-warning/10 text-warning border-warning/20',
    Worker: 'bg-success/10 text-success border-success/20',
    UI: 'bg-danger/10 text-danger border-danger/20',
  }
  return (
    <span className={clsx('badge border', map[type] || 'bg-surface-2 text-muted border-border')}>
      {type}
    </span>
  )
}

// Empty state
export function Empty({ message = 'No data found' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-surface-2 border border-border flex items-center justify-center mb-3">
        <span className="text-xl">∅</span>
      </div>
      <p className="text-muted text-sm">{message}</p>
    </div>
  )
}

// Loading spinner
export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 border-2 border-accent/20 border-t-accent rounded-full animate-spin" />
    </div>
  )
}

// Page header
export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

// Risk score bar
export function RiskScore({ score }) {
  const pct = (score / 10) * 100
  const color = score >= 8 ? 'bg-danger' : score >= 6 ? 'bg-warning' : 'bg-success'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div className={clsx('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted w-6 text-right">{score.toFixed(1)}</span>
    </div>
  )
}

// Modal
export function Modal({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-1 border border-border rounded-2xl w-full max-w-lg shadow-glow-lg animate-slide-up">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-white transition-colors text-lg leading-none">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

// Table
export function Table({ cols, rows, onRowClick }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {cols.map(c => (
              <th key={c.key} className="label text-left px-4 py-3 font-normal">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onClick={() => onRowClick?.(row)}
              className={clsx(
                'border-b border-border/50 transition-colors',
                onRowClick ? 'cursor-pointer hover:bg-surface-2' : ''
              )}
            >
              {cols.map(c => (
                <td key={c.key} className="px-4 py-3 text-white/80">
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
